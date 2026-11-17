# B70 Observatory

A local coding-agent workstation for the Intel Arc Pro B70. One GPU serves Qwen3.8-27B through vLLM or runs the MiniMax H3 image workflow through ComfyUI. The Observatory Studio embeds Diffusion Desk, schedules the engine switch and returns images to the originating agent session.

| Directory | What runs there |
| --- | --- |
| `dashboard/` | Observatory web UI, authenticated gateway, GPU scheduler, image Studio, coding runner and service installers |
| `diffusion-desk/` | [Standalone ComfyUI web workspace](diffusion-desk/docs/COMFYUI_WEB.md), Vue frontend and Node adapter |
| `pi/` | Pinned Pi coding-agent package and lockfile |
| `third_party/agent-workspace-linux/` | Headless desktop implementation used inside the agent sandbox |
| `text-engine/` | Direct XPU source build, EXL3 profile, bounded transfers, 180 W power control and RAM prefix cache |
| `image-engine/` | Pinned ComfyUI and H3 extension revisions, local canvas patch, verified model downloads and XPU launcher |

The runner creates isolated worktrees and starts Pi through the gateway. Its desktop tools launch a private graphical session, inspect screenshots and drive applications in that session. The browser and desktop runtimes are read-only mounts. Keep the project checkout in a dedicated projects directory because the installer uses its parent as the allowed projects root.

The active text engine uses a 12 GiB host cache. Up to 8 GiB can survive an engine switch in a separate, swap-disabled RAM service. At image startup the service drops retained blocks if less than 25 GiB is available. During image generation it makes pages reclaimable below 10 GiB and clears the cache below 5 GiB. Returning to text verifies surviving blocks before reuse.

## Install on a B70 workstation

The reference stack targets x86-64 Arch Linux, systemd, the Intel xe driver and a 32 GB B70. Use a regular account with Docker and render-device access. Install Git, Python 3.12, Node.js 24 and npm, Bubblewrap, Bash, curl, jq, GNU core utilities, GCC/G++, GnuPG, CMake, Ninja, libarchive, and the Rust toolchain pinned in `dashboard/ops/desktop/build.sh`. Provide Chrome under `/opt/google/chrome` or use `--browser-root` with a separate Chrome installation. The packaged Chromium runtime is used for desktop browsing. Allow disk space for Docker build stages and model downloads. The three image weights alone use about 38 GB.

### 1. Build the text engine

From `text-engine/`, build the direct XPU image. The build verifies the locked sources and native libraries and writes a receipt with the resulting image ID. The reference system's qualified Docker image is identified in the repository by digest. A fresh source build has its own ID and runtime status.

```bash
python3 scripts/build-engine.py --tag local/b70-observatory:direct-xpu --output .work/direct-xpu
cp .env.example .env
sed -i 's|^VLLM_IMAGE=.*|VLLM_IMAGE=local/b70-observatory:direct-xpu|' .env
printf 'B70_BUILD_RECEIPT=%s\n' "$PWD/.work/direct-xpu/build.json" >> .env
export B70_BUILD_RECEIPT="$PWD/.work/direct-xpu/build.json"
./scripts/download-model.sh
```

The build and agent scheduler inherit the reference work window in Europe/Berlin. Start a full text-image build early enough for the three-hour build allowance. The repository does not install a host shutdown timer.

The power helper discovers the B70 through sysfs. If multiple cards match, set `RENDER_NODE` to the intended render device. Give the service account permission to write the B70 power limit using the scoped rule in `text-engine/systemd/80-b70-power.rules`, then run:

```bash
./scripts/set-power-limit.py
set -a
source .env
set +a
python3 scripts/run-server-exl3.py --check-only
./scripts/install-user-service.sh
curl -fsS http://127.0.0.1:8081/health
```

Wait for model loading before checking health. On a machine that already has the exact qualified image, keep its matching tag in `.env` and omit the build receipt. Both paths check the checkpoint files and serving configuration.

### 2. Prepare the image engine and sandbox runtimes

Before building the sandbox desktop, install the [signing keyrings for its pinned packages](dashboard/ops/desktop/README.md).

From the **repository root**, prepare the pinned ComfyUI checkout. The installer verifies model and Intel package checksums and creates an isolated Python environment. Downloads are stored under `.work/ComfyUI` by default.

```bash
python3 image-engine/prepare.py
npm ci --prefix pi
cd dashboard
npm ci
python3 ops/browsers/prepare.py
sh ops/desktop/build.sh
python3 ops/memory/prepare.py
npm run build
```

The release build verifies and packages the prepared browser, desktop and memory runtimes alongside the Studio. Run these preparations before the final build to include all three.

### 3. Configure credentials and install the services

From `dashboard/`, generate credentials on the target machine. For local access use loopback. For LAN access substitute the specific interface address and configure trusted HTTPS before transmitting credentials over the network.

```bash
node packages/server/dist/cli/configure-auth.js --host 127.0.0.1
read -rs -p 'Gateway token printed by configure-auth: ' B70_RUNNER_GATEWAY_TOKEN
echo
export B70_RUNNER_GATEWAY_TOKEN
npm run configure:runner -- --project-dir "$PWD"
unset B70_RUNNER_GATEWAY_TOKEN
cd ..
python3 scripts/configure-stack.py
sudo install -Dm644 .work/studio-paths.conf /etc/systemd/system/local-ai-b70-observatory.service.d/studio-paths.conf
cd dashboard
sudo ./install-observatory.sh --user "$(id -un)" --reuse-runner-config
```

The generated drop-in grants Studio write access to the image output and reference-input directories under the selected ComfyUI root. The runner keeps its existing sandbox boundaries. User systemd manages the two GPU engines and the RAM cache. System services manage the Observatory, runner and privileged helpers.

Open `http://127.0.0.1:8090/`, sign in and select **Hybrid** for agent image requests. Create a project under the configured projects directory. Test a coding task with a desktop preview, then ask the same agent to generate an image and continue the conversation. Studio and the agent share the GPU scheduler. Use one scheduler at a time.

## Verification and provenance

The public-source dashboard was built and tested with the pinned Pi packages and the reference installation's prepared native desktop, browser and memory artifacts. A complete fresh GPU build and installation on a second machine is a separate qualification step. On the reference runtime, a 4000 × 3000 generation between two text requests retained 8,960 prefix tokens. Time to first token on the continuation was 2.01 seconds with the warm prefix and 5.71 seconds with a cleared cache.

The engine source derives from the [Intel B70 vLLM recipe](https://github.com/Danmoreng/intel-b70-qwen38-vllm). The embedded Studio derives from [Diffusion Desk](https://github.com/Danmoreng/diffusion-desk). The image installer fetches upstream [ComfyUI](https://github.com/Comfy-Org/ComfyUI) and [MiniMax H3 Tools](https://github.com/Rinne414/ComfyUI-MiniMaxH3-Tools) at the revisions in the installer. Component license notices remain with their sources. Model weights are fetched from their publishers and have separate terms.
