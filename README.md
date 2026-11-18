# B70 Observatory

A local coding-agent workstation for the Intel Arc Pro B70. One GPU serves Qwen3.8-27B through vLLM or runs the MiniMax H3 image workflow through ComfyUI. The Observatory Studio embeds Diffusion Desk, schedules the engine switch and returns images to the originating agent session.

| Directory | What runs there |
| --- | --- |
| `dashboard/` | Observatory web UI, authenticated gateway, GPU scheduler, image Studio, coding runner and service installers |
| `diffusion-desk/` | [Standalone ComfyUI web workspace](diffusion-desk/docs/COMFYUI_WEB.md), Vue frontend and Node adapter |
| `chat-ui/` | Optional separate Hugging Face Chat UI launcher with a persistent MongoDB volume |
| `pi/` | Pinned Pi coding-agent package and lockfile |
| `third_party/agent-workspace-linux/` | Headless desktop implementation used inside the agent sandbox |
| `text-engine/` | Direct XPU source build, EXL3 profile, bounded transfers, 180 W power control and RAM prefix cache |
| `image-engine/` | Pinned ComfyUI and H3 extension revisions, local canvas patch, verified model downloads and XPU launcher |

The runner creates isolated worktrees and starts Pi through the gateway. Its desktop tools launch a private graphical session, inspect screenshots and drive applications in that session. The browser and desktop runtimes are read-only mounts. Keep the project checkout in a dedicated projects directory because the installer uses its parent as the allowed projects root.

The active text engine uses a 12 GiB host cache. Up to 8 GiB can survive an engine switch in a separate, swap-disabled RAM service. At image startup it drops the least recently used blocks until 25 GiB is available or the cache is empty. During image generation, a dip below 10 GiB releases older blocks toward 11 GiB of headroom in batches of about 256 MiB per pressure check. Below 7 GiB all remaining pages become kernel-reclaimable, and below 5 GiB the service clears the cache. Returning to text verifies surviving blocks before reuse.

The runner keeps a stable text reference for each tool screenshot and sends the two most recent previews in one labeled message. The engine retains a recurrent-state checkpoint every 7,168 tokens so a later observation can reuse the preceding text.

Observatory's Pi and web clients use an explicit output limit as a budget for the answer or tool call. For example, `max_tokens=2000` with medium reasoning reserves up to 10,192 completion tokens, including up to 8,192 for thinking. After the closing thinking marker, the scheduler allows at most 2,000 more tokens. The engine applies its 16,384-token output ceiling to the visible allowance. It shortens the thinking budget when the tokenized prompt leaves less room in the model context. Other clients can select this mode with the `x-b70-output-budget: visible` header. Use `x-b70-output-budget: total` at the gateway for the standard combined limit. A request without an explicit limit keeps the 16,384-token default.

On the reference B70 at 180 W, six isolated pairs of agent requests with changing tool images reused 172,032 of 228,655 tokens in their second prompts. The summed time to first token fell from 141.4 s to 37.6 s compared with the earlier runner and engine settings. On three code-review fixtures with two seeds each, separating the visible budget produced six correct lists at a 2,048-token limit. The combined limit produced four correct lists and two empty answers. Two replies in each group matched strict JSON.

In a 4000 × 3000 ComfyUI switch test, the secondary cache started at 7.93 GiB. The image completed in 143 s and 2.11 GiB remained resident. After vLLM was ready, continuing the same conversation reused 17,920 of 20,344 prompt tokens. Its first token took 1.84 s, compared with 9.84 s for the identical cold prompt. The text engine took 90 s to become ready. Filling used an 8 GiB primary cache and returning to text restored the usual 12 GiB primary cache.

## Install on a B70 workstation

The reference stack targets x86-64 Arch Linux, systemd, the Intel xe driver and a 32 GB B70. Use a regular account with Docker and render-device access. Install Git, Python 3.12, Node.js 24 and npm, Bubblewrap, Bash, curl, jq, GNU core utilities, GCC/G++, GnuPG, CMake, Ninja, libarchive, and the Rust toolchain pinned in `dashboard/ops/desktop/build.sh`. Provide Chrome under `/opt/google/chrome` or use `--browser-root` with a separate Chrome installation. The packaged Chromium runtime is used for desktop browsing. Allow disk space for Docker build stages and model downloads. The three image weights alone use about 38 GB.

Use this checkout as the source for the services and release builds. Keep credentials, host settings and writable application state in private directories outside Git. The following commands use the same shell variables throughout the installation.

```bash
b70_config="${XDG_CONFIG_HOME:-$HOME/.config}/b70-observatory"
b70_state="${XDG_STATE_HOME:-$HOME/.local/state}/b70-observatory/dashboard"
install -d -m 700 "$b70_config" "$b70_state"
```

### 1. Build the text engine

From `text-engine/`, build the direct XPU image. The build verifies the locked sources and native libraries and writes a receipt with the resulting image ID. The reference system's qualified Docker image is identified in the repository by digest. A fresh source build has its own ID and runtime status.

```bash
python3 scripts/build-engine.py --tag local/b70-observatory:direct-xpu --output .work/direct-xpu
install -m 600 .env.example "$b70_config/text.env"
sed -i 's|^VLLM_IMAGE=.*|VLLM_IMAGE=local/b70-observatory:direct-xpu|' "$b70_config/text.env"
printf 'B70_BUILD_RECEIPT=%s\n' "$PWD/.work/direct-xpu/build.json" >> "$b70_config/text.env"
export B70_BUILD_RECEIPT="$PWD/.work/direct-xpu/build.json"
./scripts/download-model.sh
```

The build and agent scheduler inherit the reference work window in Europe/Berlin. Start a full text-image build early enough for the three-hour build allowance. The repository does not install a host shutdown timer.

The power helper discovers the B70 through sysfs. If multiple cards match, set `RENDER_NODE` to the intended render device. Give the service account permission to write the B70 power limit using the scoped rule in `text-engine/systemd/80-b70-power.rules`, then run:

```bash
./scripts/set-power-limit.py
set -a
source "$b70_config/text.env"
set +a
python3 scripts/run-server-exl3.py --check-only
./scripts/install-user-service.sh --env-file "$b70_config/text.env"
curl -fsS http://127.0.0.1:8081/health
```

Wait for model loading before checking health. On a machine that already has the exact qualified image, keep its matching tag in `text.env` and omit the build receipt. Both paths check the checkpoint files and serving configuration.

### 2. Prepare the image engine and sandbox runtimes

Before building the sandbox desktop, install the [signing keyrings for its pinned packages](dashboard/ops/desktop/README.md).

From the **repository root**, prepare the pinned ComfyUI checkout. The installer verifies model and Intel package checksums and creates an isolated Python environment. Downloads are stored under `.work/ComfyUI` by default.

```bash
comfy_root="${XDG_DATA_HOME:-$HOME/.local/share}/b70-observatory/ComfyUI"
python3 image-engine/prepare.py --root "$comfy_root"
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
node packages/server/dist/cli/configure-auth.js --host 127.0.0.1 \
  --output "$b70_config/observatory.env" --db-path "$b70_state/observatory.db"
read -rs -p 'Gateway token printed by configure-auth: ' B70_RUNNER_GATEWAY_TOKEN
echo
export B70_RUNNER_GATEWAY_TOKEN
npm run configure:runner -- --project-dir "$PWD" --env-file "$b70_config/observatory.env" \
  --runner-env-file "$b70_config/runner.env" --profile-root "$b70_config/runner-profile"
unset B70_RUNNER_GATEWAY_TOKEN
cd ..
python3 scripts/configure-stack.py --config-dir "$b70_config" --state-dir "$b70_state" \
  --comfy-root "$comfy_root" --studio-dropin "$b70_config/studio-paths.conf"
sudo install -Dm644 "$b70_config/studio-paths.conf" /etc/systemd/system/local-ai-b70-observatory.service.d/studio-paths.conf
cd dashboard
sudo ./install-observatory.sh --user "$(id -un)" --reuse-runner-config --config-dir "$b70_config" --data-dir "$b70_state"
```

The generated drop-in grants Studio write access to the image output and reference-input directories under the selected ComfyUI root. The runner keeps its existing sandbox boundaries. User systemd manages the two GPU engines and the RAM cache. System services manage the Observatory, runner and privileged helpers.

Open `http://127.0.0.1:8090/`, sign in and select **Hybrid** for agent image requests. Create a project under the configured projects directory. Test a coding task with a desktop preview, then ask the same agent to generate an image and continue the conversation. Studio and the agent share the GPU scheduler. Use one scheduler at a time.

## Updating a running workstation

Commit code in this repository. For a dashboard, Studio or runner change, build the release from that commit and activate it when the workstation is idle. The existing release helper verifies the packaged files, restarts both services and health-checks the result. The previous release remains available for rollback.

```bash
(cd dashboard && npm run typecheck && npm test && npm run build)
python3 scripts/activate-dashboard.py --observatory-db "$b70_state/observatory.db"
```

The text service reads `text.env` from its installed systemd configuration and loads the qualified runtime from `text-engine/` on startup. Run the documented preflight with that environment before restarting an idle text service. Changes to the RAM broker require a separate broker restart, which clears its disposable cache. A changed model image or dependency lock also requires its corresponding build or preparation step.

The image launcher reads optional host settings from `image.env` in the configured directory. For an existing prepared installation, set `B70_COMFY_NATIVE_ROOT` to the directory containing `root/usr/lib` and `icd`. The host can set `TZ`, `B70_COMFY_LATEST_START` and `B70_COMFY_STOP_AT` to apply a daily work window. The optional separate Chat UI uses `chat-ui/run-chatui.sh` with `B70_CHATUI_ENV_FILE` pointing at its private Docker environment file.

## Verification and provenance

The public-source dashboard was built and tested with the pinned Pi packages and the reference installation's prepared native desktop, browser and memory artifacts. A complete fresh GPU build and installation on a second machine is a separate qualification step. On the reference runtime, a 4000 × 3000 generation between two text requests retained 8,960 prefix tokens. Time to first token on the continuation was 2.01 seconds with the warm prefix and 5.71 seconds with a cleared cache.

The engine source derives from the [Intel B70 vLLM recipe](https://github.com/Danmoreng/intel-b70-qwen38-vllm). The embedded Studio derives from [Diffusion Desk](https://github.com/Danmoreng/diffusion-desk). The image installer fetches upstream [ComfyUI](https://github.com/Comfy-Org/ComfyUI) and [MiniMax H3 Tools](https://github.com/Rinne414/ComfyUI-MiniMaxH3-Tools) at the revisions in the installer. Component license notices remain with their sources. Model weights are fetched from their publishers and have separate terms.
