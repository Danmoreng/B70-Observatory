#!/usr/bin/env bash
set -euo pipefail
exec bash "$(dirname -- "$0")/download-exl3-model.sh" "$@"
