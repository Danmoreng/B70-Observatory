"""Select the Intel Arc Pro B70 associated with a DRM render node."""
import os
from pathlib import Path


def b70_device():
    selected = os.environ.get('RENDER_NODE')
    nodes = [Path(selected)] if selected else Path('/dev/dri').glob('renderD*')
    matches = []
    for node in nodes:
        device = Path('/sys/class/drm') / node.resolve().name / 'device'
        if node.exists() and (device / 'vendor').read_text().strip() == '0x8086' and (device / 'device').read_text().strip() == '0xe223':
            matches.append(device.resolve())
    if len(matches) != 1:
        raise SystemExit('Select one Intel Arc Pro B70 using RENDER_NODE=/dev/dri/renderD…')
    return matches[0]
