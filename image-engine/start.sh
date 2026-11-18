#!/usr/bin/env bash
set -euo pipefail
cd -- "${B70_COMFY_ROOT:?configure B70_COMFY_ROOT in the image service}"
if systemctl --user is-active --quiet b70-qwen38-vllm.service; then
  echo "Text service still holds the GPU" >&2
  exit 1
fi
native_root="${B70_COMFY_NATIVE_ROOT:-$PWD/.b70-runtime}"
export LD_LIBRARY_PATH="$native_root/root/usr/lib:$PWD/.venv/lib/python3.12/site-packages/torch/lib"
export OCL_ICD_VENDORS="$native_root/icd"
export ONEAPI_DEVICE_SELECTOR=level_zero:0 HF_HUB_DISABLE_TELEMETRY=1 DO_NOT_TRACK=1
# A host may set its own daily admission and shutdown times for this service.
command=()
if [[ -n "${B70_COMFY_LATEST_START:-}${B70_COMFY_STOP_AT:-}" ]]; then
  for value in "${B70_COMFY_LATEST_START:-}" "${B70_COMFY_STOP_AT:-}"; do
    [[ "$value" =~ ^([01][0-9]|2[0-3]):[0-5][0-9]$ ]] || { echo "Expected both local times as HH:MM" >&2; exit 2; }
  done
  today=$(date +%F)
  now=$(date +%s)
  latest=$(date -d "$today $B70_COMFY_LATEST_START" +%s)
  stop=$(date -d "$today $B70_COMFY_STOP_AT" +%s)
  (( now < latest && latest < stop )) || { echo "Outside configured image service hours" >&2; exit 1; }
  command=(timeout --foreground --signal=TERM --kill-after=15s "$((stop - now))s")
fi
exec "${command[@]}" .venv/bin/python main.py --listen 127.0.0.1 --port 8188 --use-pytorch-cross-attention --reserve-vram 2 --disable-pinned-memory --disable-async-offload --cache-none
