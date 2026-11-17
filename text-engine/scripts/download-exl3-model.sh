#!/usr/bin/env bash
set -euo pipefail
repo_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
[[ "$#" == 0 ]] || { echo 'Pinned model download accepts no overrides' >&2; exit 2; }
readarray -t pinned < <(python3 - "$repo_dir/config/production_policy.json" "$repo_dir/config/production_image.json" <<'PY'
import json,sys
p,r=[json.load(open(f)) for f in sys.argv[1:]]
if p['policy_id'] not in tuple(f'b70-qwen38-exl3-production-v{version}' for version in range(1, 8)):raise SystemExit('EXL3 production is not selected')
print(p['model']['id']);print(p['model']['revision']);print(r['image_id'])
PY
)
[[ "${#pinned[@]}" == 3 ]] || exit 2
model_dir="$HOME/.cache/exl3xpu/turboderp-Qwen3.8-27B-exl3-4.00bpw"
if [[ -n "${B70_BUILD_RECEIPT:-}" ]]; then
  pinned[2]=$(PYTHONPATH="$repo_dir/scripts" python3 -c 'import sys; from local_build import local_build; print(local_build(sys.argv[1])[1])' "$B70_BUILD_RECEIPT")
fi
mkdir -p "$model_dir"
exec docker run --rm -e HF_HUB_OFFLINE=0 \
  -v "$model_dir:/models/checkpoint" --entrypoint hf "${pinned[2]}" \
  download "${pinned[0]}" --revision "${pinned[1]}" --local-dir /models/checkpoint
