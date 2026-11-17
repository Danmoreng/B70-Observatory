#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
service_user="${SUDO_USER:-}"
skip_build=false
reuse_runner_config=false

usage() {
  cat <<'EOF'
Usage: sudo ./install-observatory.sh [--user USER] [--skip-build] [--reuse-runner-config]

Builds Local AI B70 Observatory, prepares the isolated coding-runner profile,
installs/updates all hardened systemd units and starts (or restarts) them.

Run `npm run configure` once as the normal service user before this script.
Use --reuse-runner-config for an Observatory update when the existing runner
configuration should be preserved. The dashboard source must be clean.
EOF
}

while (($# > 0)); do
  case "$1" in
    --user)
      shift
      service_user="${1:-}"
      ;;
    --skip-build)
      skip_build=true
      ;;
    --reuse-runner-config)
      reuse_runner_config=true
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      printf 'Unknown argument: %s\n' "$1" >&2
      usage >&2
      exit 2
      ;;
  esac
  shift
done

if [[ ${EUID} -ne 0 ]]; then
  printf 'Run this script with sudo: sudo %s\n' "$0" >&2
  exit 1
fi

if [[ -z "$service_user" || ! "$service_user" =~ ^[a-z_][a-z0-9_-]*$ ]]; then
  printf 'Could not determine a safe service user. Pass --user USER.\n' >&2
  exit 1
fi

if ! id "$service_user" >/dev/null 2>&1; then
  printf 'Service user does not exist: %s\n' "$service_user" >&2
  exit 1
fi

env_file="$script_dir/data/observatory.env"
if [[ ! -f "$env_file" ]]; then
  printf 'Missing %s\n' "$env_file" >&2
  printf 'Run this first without sudo:\n  cd %s && npm run configure\n' "$script_dir" >&2
  exit 1
fi

if [[ "$reuse_runner_config" == true ]]; then
  repository="$(dirname -- "$script_dir")"
  if [[ -n "$(runuser -u "$service_user" -- git -C "$repository" status --porcelain -- dashboard)" ]]; then
    printf 'Dashboard source has uncommitted changes; commit them before installation.\n' >&2
    exit 1
  fi
  if [[ ! -f "$script_dir/data/runner.env" ]]; then
    printf 'Existing runner configuration is missing: %s/data/runner.env\n' "$script_dir" >&2
    exit 1
  fi
fi

node_binary="$(command -v node || true)"
if [[ -z "$node_binary" ]]; then
  printf 'Node.js was not found in the sudo environment. Node.js 24 is required.\n' >&2
  exit 1
fi
node_major="$($node_binary -p 'Number(process.versions.node.split(".")[0])')"
if ((node_major < 24)); then
  printf 'Node.js 24 or newer is required; found %s.\n' "$($node_binary --version)" >&2
  exit 1
fi

npm_binary="$(command -v npm || true)"
if [[ -z "$npm_binary" || ! -x "$script_dir/node_modules/.bin/tsx" ]]; then
  printf 'Build dependencies are missing. Run this first without sudo:\n' >&2
  printf '  cd %s && npm ci\n' "$script_dir" >&2
  exit 1
fi

if [[ "$skip_build" == false ]]; then
  printf 'Building Observatory as %s...\n' "$service_user"
  runuser -u "$service_user" -- "$npm_binary" --prefix "$script_dir" run build
elif [[ ! -f "$script_dir/packages/server/dist/index.js" || ! -f "$script_dir/packages/server/dist/runner/main.js" || ! -f "$script_dir/packages/runner/dist/sandbox-entry.js" || ! -f "$script_dir/packages/runner/dist/release-builder.js" || ! -x "$script_dir/build/local-ai-b70-gpu-helper" || ! -f "$script_dir/build/local-ai-b70-release-helper.mjs" || ! -f "$script_dir/build/observatory-release/manifest.json" ]]; then
  printf -- '--skip-build requested, but the web/server or native helper build is missing.\n' >&2
  exit 1
fi

if [[ "$reuse_runner_config" == true ]]; then
  printf 'Reusing existing isolated runner configuration.\n'
else
  printf 'Preparing isolated runner configuration as %s...\n' "$service_user"
  runuser -u "$service_user" -- "$npm_binary" --prefix "$script_dir" run configure:runner -- \
    --project-dir "$script_dir"
fi
runner_env_file="$script_dir/data/runner.env"

printf 'Installing systemd service...\n'
"$script_dir/node_modules/.bin/tsx" "$script_dir/ops/install-service.ts" \
  --project-dir "$script_dir" \
  --env-file "$env_file" \
  --runner-env-file "$runner_env_file" \
  --user "$service_user"

# The lower-level installer uses `enable --now`, which does not restart an
# already running unit after a code update. Restart explicitly so this script
# is also a reliable idempotent upgrade command.
systemctl reset-failed local-ai-b70-gpu-helper.service || true
systemctl reset-failed local-ai-b70-release-helper.service || true
systemctl reset-failed local-ai-b70-runner.service || true
systemctl restart local-ai-b70-gpu-helper.service
systemctl restart local-ai-b70-release-helper.service
systemctl restart local-ai-b70-runner.service
systemctl restart local-ai-b70-observatory.service
systemctl --no-pager --full status local-ai-b70-gpu-helper.service
systemctl --no-pager --full status local-ai-b70-release-helper.service
systemctl --no-pager --full status local-ai-b70-runner.service
systemctl --no-pager --full status local-ai-b70-observatory.service

printf '\nObservatory is installed and enabled at boot.\n'
printf 'Open: http://127.0.0.1:8090/\n'
printf 'Logs: journalctl -u local-ai-b70-observatory.service -f\n'
printf 'GPU logs: journalctl -u local-ai-b70-gpu-helper.service -f\n'
printf 'Release logs: journalctl -u local-ai-b70-release-helper.service -f\n'
printf 'Runner logs: journalctl -u local-ai-b70-runner.service -f\n'
