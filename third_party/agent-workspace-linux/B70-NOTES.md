# B70 headless integration

Upstream: https://github.com/agent-sh/agent-workspace-linux
Tag: v0.6.4
Commit: b1756da4707fee8585ec0ffb8f8ddd9cfc25b519
License: MIT; see LICENSE.

Local changes: omit the GPUI viewer and generic MCP host from the CLI entrypoint
and dependency manifest. Keep upstream workspace/daemon, native desktop/input
and session implementations. Main parser tests specific to those hosts are
omitted; core module tests remain. Dashboard supplies the viewer and Durable
tools. All execution must remain inside the B70 sandbox.

No upstream installer or host desktop configuration is used. Cargo.lock pins
the headless build. Rebuild through dashboard/ops/desktop/build.sh.

Additional B70 changes: X11 keyboard typing uses a 12 ms delay and a literal
argument delimiter (Unicode remapping); paste accepts a literal argument
delimiter; window manager startup captures stderr and rejects immediate exit.
Synthetic passwd/group files are supplied by the outer sandbox, never from the
host. Rust compiler used for this build: 1.99.1 (58cf8f9c3).

X11 screenshot capture bounds ffmpeg filter and codec worker threads to one,
leaving room for browser and Pi-env control threads inside TasksMax.
