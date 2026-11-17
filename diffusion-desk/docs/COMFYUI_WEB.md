# Standalone ComfyUI workspace

The Observatory includes the Studio UI and owns GPU scheduling in Hybrid mode. Use the standalone Vue and Node workspace for a dedicated image session with a single scheduler. Stop the text engine and transfer image-engine ownership before using standalone generation. Close the standalone server before switching Observatory back to Hybrid.

From the repository root, build the web UI and install the adapter dependencies:

```bash
npm ci --prefix diffusion-desk/webui
npm run build:comfyui --prefix diffusion-desk/webui
npm ci --prefix diffusion-desk/server/comfyui
systemctl --user start diffusion-desk-comfyui.service
node diffusion-desk/server/comfyui/app.mjs --comfy-root "$PWD/.work/ComfyUI" --host 127.0.0.1 --port 8093
```

Open `http://127.0.0.1:8093/`. This standalone interface is intended for a trusted local machine. The embedded Observatory Studio uses the Observatory session and origin checks.
