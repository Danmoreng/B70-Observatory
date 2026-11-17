"""Prepare a pinned ComfyUI checkout, XPU environment and H3 model files."""
import argparse
import hashlib
import json
import subprocess
from pathlib import Path

HERE = Path(__file__).resolve().parent
COMFY = ('https://github.com/Comfy-Org/ComfyUI.git', 'dc9ffe6adde25671bf535e99556ca9f8085c7d0f')
NODES = ('https://github.com/Rinne414/ComfyUI-MiniMaxH3-Tools.git', '6fd50255dc08c5bfba7b91fee083c8c0abf2023b')
REV = '0bb149f51e3156ed4b90dd45d5620346bfe1df8f'
MODELS = {
    'diffusion_models/minimax_h3_image_pruned_int8_convrot.safetensors': '83eb140f1ff95c068f8a6886e6d3f3d0d4ab2e07bb2fe6d2ef992a51146ee622',
    'text_encoders/qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors': '35a88d51044231fe332301d7a62aa81e3f2cba62febeb446e2c1e3e0ef76f2c6',
    'vae/minimax_h3_image_vae_fp16.safetensors': 'd80e9c2e5cfc9844869961ff5a58c9a9e52182df6bfb30b26018dd7f348721af',
}


def run(*args):
    subprocess.run(args, check=True)


def checkout(path, spec):
    url, revision = spec
    if not (path / '.git').is_dir():
        path.parent.mkdir(parents=True, exist_ok=True)
        run('git', 'clone', '--no-checkout', '--filter=blob:none', url, path)
        run('git', '-C', path, 'checkout', '--detach', revision)
    if subprocess.check_output(['git', '-C', path, 'rev-parse', 'HEAD'], text=True).strip() != revision:
        raise SystemExit(f'Expected {revision} in {path}')


def download(url, path, digest):
    path.parent.mkdir(parents=True, exist_ok=True)
    pending = path.with_suffix(path.suffix + '.part')
    source = path if path.exists() else pending
    if source == pending:
        run('curl', '--fail', '--location', '--retry', '3', '--continue-at', '-', '--output', pending, url)
    with source.open('rb') as stream:
        if hashlib.file_digest(stream, 'sha256').hexdigest() != digest:
            raise SystemExit(f'Checksum mismatch for {source}')
    if source == pending:
        pending.replace(path)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, default=HERE.parent/'.work/ComfyUI')
    parser.add_argument('--python', default='python3.12')
    args = parser.parse_args()
    root = args.root.resolve()
    checkout(root, COMFY)
    nodes = root/'custom_nodes/ComfyUI-MiniMaxH3-Tools'
    checkout(nodes, NODES)
    patch = HERE/'h3-sizes.patch'
    if subprocess.run(['git','-C',nodes,'apply','--reverse','--check',patch],capture_output=True).returncode:
        run('git','-C',nodes,'apply',patch)
    run(args.python,'-m','venv',root/'.venv')
    pip = root/'.venv/bin/pip'
    run(pip,'install','--index-url','https://download.pytorch.org/whl/xpu','-r',HERE/'xpu-constraints.txt')
    run(pip,'install','-c',HERE/'xpu-constraints.txt','-r',root/'requirements.txt','comfy-kitchen==0.2.41')
    native = root/'.b70-runtime'
    libroot = native/'root'
    libroot.mkdir(parents=True,exist_ok=True)
    for pkg in json.loads((HERE/'intel-packages.json').read_text()):
        path = native/'packages'/pkg['url'].rsplit('/',1)[1]
        download(pkg['url'], path, pkg['sha256'])
        run('bsdtar','-xf',path,'-C',libroot)
    icd = native/'icd/intel.icd'
    icd.parent.mkdir(exist_ok=True)
    icd.write_text(str(libroot/'usr/lib/intel-opencl/libigdrcl.so')+'\n')
    for name, digest in MODELS.items():
        download(f'https://huggingface.co/Comfy-Org/MiniMax-H3-Image/resolve/{REV}/{name}',root/'models'/name,digest)


if __name__ == '__main__':
    main()
