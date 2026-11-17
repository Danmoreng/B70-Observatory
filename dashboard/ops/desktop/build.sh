#!/bin/sh
# Operator build only. No installer, global toolchain changes or service changes.
set -eu
desktop_ops_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
desktop_dashboard_dir=$(CDPATH= cd -- "$desktop_ops_dir/../.." && pwd)
desktop_target_dir="$desktop_dashboard_dir/build/desktop-cargo"
case "$(rustc --version)" in
  "rustc 1.99.1 "*) ;;
  *) echo 'Desktop build requires the reviewed Rust 1.99.1 toolchain.' >&2; exit 1 ;;
esac
timeout 1800s cargo build --locked --release --jobs 2 \
  --manifest-path "$desktop_dashboard_dir/../third_party/agent-workspace-linux/Cargo.toml" \
  --target-dir "$desktop_target_dir"
python "$desktop_ops_dir/prepare.py" --binary "$desktop_target_dir/release/agent-workspace-linux"
