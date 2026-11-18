#!/usr/bin/env python3
"""Configure local integration after the Observatory and runner credentials exist."""
import argparse
import os
from pathlib import Path
import re
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[1]


def path_value(p):
    value = str(p.resolve())
    if not re.fullmatch(r'/[A-Za-z0-9._/+@-]+', value):
        raise ValueError('Use a checkout and runtime path without whitespace or systemd specifiers')
    return value


def update_env(path, values):
    original = path.read_text().splitlines()
    lines = [line for line in original if line.partition('=')[0] not in values]
    lines.extend(f'{key}={value}' for key, value in values.items())
    with tempfile.NamedTemporaryFile(dir=path.parent, mode='w', delete=False) as out:
        out.write('\n'.join(lines) + '\n')
        pending = Path(out.name)
    pending.replace(path)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--comfy-root', type=Path, default=ROOT/'.work/ComfyUI')
    parser.add_argument('--browser-root', type=Path, default=Path('/opt/google/chrome'),
                        help='Standalone Chrome directory mounted read-only in browser jobs')
    parser.add_argument('--config-dir', type=Path, default=ROOT/'dashboard/data',
                        help='Directory containing observatory.env and runner.env')
    parser.add_argument('--state-dir', type=Path, default=ROOT/'dashboard/data',
                        help='Writable image job state directory')
    parser.add_argument('--studio-dropin', type=Path, default=ROOT/'.work/studio-paths.conf',
                        help='Destination for the generated systemd write-path drop-in')
    args = parser.parse_args()
    if os.getuid() == 0:
        raise SystemExit('Run as the user who will own the GPU engines')
    base = path_value(ROOT)
    comfy = path_value(args.comfy_root)
    config = Path(path_value(args.config_dir))
    data = Path(path_value(args.state_dir))
    for path in [config/'observatory.env', config/'runner.env', Path(comfy)/'.venv/bin/python', args.browser_root/'chrome']:
        if not path.is_file():
            raise SystemExit(f'Missing prerequisite: {path}')
    for name in ('desktop-runtime', 'browser-runtime','memory-runtime'):
        if not (ROOT/'dashboard/build'/name/'manifest.json').is_file():
            raise SystemExit(f'Prepare dashboard/build/{name} first')
    for sub in ['output', 'input/DiffusionDesk']:
        (Path(comfy)/sub).mkdir(parents=True, exist_ok=True)
    (data/'image-jobs').mkdir(mode=0o700, parents=True, exist_ok=True)
    update_env(config/'observatory.env', {
        'OBSERVATORY_STUDIO_COMFY_ROOT':comfy, 'OBSERVATORY_IMAGE_JOBS_ROOT':str(data/'image-jobs'),
        'OBSERVATORY_COMFY_URL':'http://127.0.0.1:8188',
    })
    update_env(config/'runner.env', {
        'B70_RUNNER_ENGINE':'pi-durable', 'B70_RUNNER_DESKTOP_ENABLED':'1',
        'B70_RUNNER_MEMORY_ENABLED':'1', 'B70_RUNNER_IMAGE_GENERATION_ENABLED':'1',
        'B70_RUNNER_BROWSER_RUNTIME_ROOT':path_value(args.browser_root),
    })
    units = Path(os.environ.get('XDG_CONFIG_HOME',Path.home()/'.config'))/'systemd/user'
    units.mkdir(parents=True,exist_ok=True)
    (units/'diffusion-desk-comfyui.service').write_text(f'''[Unit]
Description=ComfyUI H3 image generation on Intel XPU
After=network-online.target b70-qwen38-vllm.service
Conflicts=b70-qwen38-vllm.service

[Service]
Type=simple
Environment=B70_COMFY_ROOT={comfy}
EnvironmentFile=-{config}/image.env
WorkingDirectory={comfy}
ExecStart={base}/image-engine/start.sh
MemoryHigh=22G
MemoryMax=24G
MemorySwapMax=0
OOMPolicy=stop
KillMode=control-group
TimeoutStopSec=30
''')
    # The privileged installer reads this template on the target machine.
    dropin = args.studio_dropin
    dropin.parent.mkdir(exist_ok=True)
    dropin.write_text(f'[Service]\nReadWritePaths={comfy}/output {comfy}/input/DiffusionDesk\n')
    subprocess.run(['systemctl','--user','daemon-reload'],check=True)


if __name__ == '__main__':
    main()
