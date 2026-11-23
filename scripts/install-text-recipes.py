#!/usr/bin/env python3
"""Install the two qualified text recipes behind the Observatory's shared loopback endpoint."""
import argparse
import copy
import json
import os
from pathlib import Path
import subprocess
from tempfile import NamedTemporaryFile

ROOT = Path(__file__).resolve().parents[1]
INKLING = 'inkling2-mini-exl3-b70'
QWEN = 'Qwen3.8-27B'


def write(path, text):
    with NamedTemporaryFile(mode='w', dir=path.parent, delete=False) as stream:
        stream.write(text)
        stream.flush()
        os.fsync(stream.fileno())
    Path(stream.name).replace(path)


def unit_path(path):
    if any(c in str(path) for c in '"%$\\\n\r'):
        raise ValueError(f'Unsupported character in systemd path: {path}')
    return '"'+str(path)+'"'


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--inkling', type=Path, required=True, help='Built Intel B70 Inkling recipe checkout')
    parser.add_argument('--config-dir', type=Path, default=Path.home()/'.config/b70-observatory')
    args = parser.parse_args()
    recipe = args.inkling.resolve()
    unit_path(recipe)
    for file in ['scripts/serve-coding-agent.sh','models/exl3/config.json',
                 '.work/build/inkling2-vllm-fused-bias.so','.work/build/inkling2-exl3-moe-mb32-64.so']:
        if not (recipe/file).is_file():
            raise SystemExit(f'Missing qualified Inkling artifact: {recipe/file}')
    envfile = args.config_dir/'runner.env'
    lines = envfile.read_text().splitlines()
    env = dict(line.split('=',1) for line in lines if '=' in line and not line.startswith('#'))
    if env.get('B70_RUNNER_UPSTREAM_URL') != 'http://127.0.0.1:8081':
        raise SystemExit('Configure the shared B70 endpoint on loopback port 8081 first.')
    profile = Path(env['B70_RUNNER_PROFILE_ROOT'])/'models.json'
    models = json.loads(profile.read_text())
    entries = models['providers'][env.get('B70_RUNNER_PROVIDER','b70-vllm')]['models']
    qwen = next(m for m in entries if m['id'] == QWEN)
    if not any(m['id']==INKLING for m in entries):
        entry = copy.deepcopy(qwen)
        entry.update(id=INKLING,name='Inkling 2 Mini · EXL3 / DSpark',contextWindow=262144)
        entry['compat']['thinkingFormat']='openai'
        entry['compat'].pop('chatTemplateKwargs',None)
        entries.append(entry)
    state = Path(env['B70_RUNNER_STATE_ROOT']).parent/'engine-mode.json'
    units = Path(os.environ.get('XDG_CONFIG_HOME',Path.home()/'.config'))/'systemd/user'
    units.mkdir(exist_ok=True,parents=True)
    write(units/'b70-inkling2-vllm.service',f"""[Unit]
Description=Inkling 2 Mini EXL3 on Intel Arc Pro B70 (adaptive DSpark)
After=network.target b70-qwen38-vllm.service diffusion-desk-comfyui.service
Conflicts=b70-qwen38-vllm.service diffusion-desk-comfyui.service

[Service]
Type=exec
WorkingDirectory={recipe}
Environment=INKLING2_VLLM_PORT=8081 INKLING2_VISION=1 INKLING2_VISION_FUSED_QKV=1 INKLING2_PREFILL_PROFILE=optimized
Environment=INKLING2_MAX_SEQS=2
ExecStartPre={unit_path(ROOT/'text-engine/scripts/set-power-limit.py')}
ExecStart=/usr/bin/bash scripts/serve-coding-agent.sh dspark
ExecStop=-/usr/bin/docker stop -t 15 inkling2-vllm-exl3
TimeoutStopSec=45
""")
    write(units/'b70-observatory-text-boot.service',f"""[Unit]
Description=Start the selected B70 Observatory text recipe
After=network.target

[Service]
Type=oneshot
ExecStart=/usr/bin/python3 {unit_path(ROOT/'scripts/start-selected-text.py')} {unit_path(state)}

[Install]
WantedBy=default.target
""")
    write(profile,json.dumps(models,indent=2,ensure_ascii=False)+'\n')
    updates={'B70_RUNNER_TEXT_RECIPES':'1','B70_RUNNER_MODEL':INKLING}
    write(envfile,'\n'.join([line for line in lines if line.split('=',1)[0] not in updates]
                             +[f'{k}={v}' for k,v in updates.items()])+'\n')
    ctl=['systemctl','--user']
    subprocess.run(ctl+['daemon-reload'],check=True)
    # Transfer the existing autostart preference on first installation.
    if subprocess.run(ctl+['is-enabled','--quiet','b70-qwen38-vllm.service']).returncode==0:
        subprocess.run(ctl+['enable','b70-observatory-text-boot.service'],check=True)
        subprocess.run(ctl+['disable','b70-qwen38-vllm.service'],check=True)

if __name__ == '__main__':
    main()
