#!/usr/bin/env bash
set -euo pipefail
cd -- "${B70_COMFY_ROOT:?configure B70_COMFY_ROOT in the image service}"
if systemctl --user is-active --quiet b70-qwen38-vllm.service; then
  echo "Text service still holds the GPU" >&2
  exit 1
fi
export LD_LIBRARY_PATH="$PWD/.b70-runtime/root/usr/lib:$PWD/.venv/lib/python3.12/site-packages/torch/lib"
export OCL_ICD_VENDORS="$PWD/.b70-runtime/icd"
export ONEAPI_DEVICE_SELECTOR=level_zero:0 HF_HUB_DISABLE_TELEMETRY=1 DO_NOT_TRACK=1
exec .venv/bin/python main.py --listen 127.0.0.1 --port 8188 --use-pytorch-cross-attention --reserve-vram 2 --disable-pinned-memory --disable-async-offload --cache-none
