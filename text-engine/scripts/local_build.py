"""Resolve the immutable image produced by the published direct XPU builder."""
import json
from pathlib import Path
import re
import subprocess


def local_build(path):
    receipt = json.loads(Path(path).read_text())
    lock = json.loads((Path(__file__).resolve().parents[1]/'engine/direct-xpu/build-lock.json').read_text())
    if receipt.get('status') != 'BUILT_CPU_CHECKED_GPU_UNTESTED' or receipt.get('build_lock') != lock:
        raise ValueError('Expected a completed direct XPU build from this lock')
    image = receipt['image_id']
    if not re.fullmatch(r'sha256:[0-9a-f]{64}', image):
        raise ValueError('Invalid immutable image ID')
    actual = json.loads(subprocess.check_output(['docker','image','inspect',receipt['tag']], text=True))[0]
    if actual['Id'] != image or actual['Config']['Labels'].get('org.local.b70.experiment') != 'direct-xpu-033':
        raise ValueError('Image identity differs from local build receipt')
    return receipt['tag'], image
