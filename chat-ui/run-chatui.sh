#!/usr/bin/env bash
set -euo pipefail
root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
exec docker run -d --name b70-chatui --init --restart unless-stopped --stop-timeout 30 \
 --network host --memory 1536m --cpus 2 \
 --env-file "${B70_CHATUI_ENV_FILE:-${XDG_CONFIG_HOME:-$HOME/.config}/b70-observatory/chatui.env}" -v b70-chatui-data:/data \
 -v "$root/chatui-entrypoint.sh:/app/b70-entrypoint.sh:ro" \
 --entrypoint /bin/bash \
 ghcr.io/huggingface/chat-ui-db@sha256:c6ce50921eca2d569d70be0e8452984a8f4ae506189f5959bedd5fd0bbd86057 /app/b70-entrypoint.sh
