#!/usr/bin/env bash
set -euo pipefail
repo_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
[[ "$#" == 0 ]] || { echo "Production launcher accepts no vLLM overrides" >&2; exit 2; }
env_file="${B70_TEXT_ENV_FILE:-$repo_dir/.env}"
if [[ -n "${B70_TEXT_ENV_FILE:-}" || -f "$env_file" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$env_file"
  set +a
fi
exec python3 "$repo_dir/scripts/run-server-exl3.py"
