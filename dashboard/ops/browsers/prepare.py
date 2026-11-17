#!/usr/bin/env python3
"""Prepare signed, pinned Chromium privately; never install a system package."""

import base64
import hashlib
import json
import os
import shutil
import subprocess
import tempfile
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
DASHBOARD = HERE.parent.parent


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def prepare_keyrings(cache):
    home = cache / 'gnupg'
    home.mkdir(mode=0o700, exist_ok=True)
    rings = []
    for name in ['manjaro', 'archlinux']:
        source = Path('/usr/share/pacman/keyrings') / (name + '.gpg')
        target = cache / (name + '.gpg')
        if source.read_bytes().startswith(b'-----BEGIN PGP'):
            subprocess.run([
                'gpg', '--homedir', str(home), '--batch', '--yes', '--dearmor',
                '--output', str(target), str(source),
            ], check=True)
        else:
            shutil.copy2(source, target)
        rings.extend(['--keyring', str(target)])
    return home, rings


def download_verified(entry, cache, home, rings):
    artifact = cache / Path(entry['url']).name
    if not artifact.exists():
        pending = artifact.with_suffix('.pending')
        with urllib.request.urlopen(entry['url'], timeout=60) as response:
            with pending.open('wb') as output:
                copied = 0
                while block := response.read(128 * 1024):
                    copied += len(block)
                    if copied > entry['size']:
                        raise RuntimeError('Browser package exceeds pinned size')
                    output.write(block)
        pending.rename(artifact)
    if artifact.stat().st_size != entry['size'] or sha(artifact) != entry['sha256']:
        raise RuntimeError('Browser package checksum mismatch')
    signature = cache / (entry['name'] + '.sig')
    signature.write_bytes(base64.b64decode(entry['signature'], validate=True))
    subprocess.run([
        'gpgv', '--homedir', str(home), *rings, str(signature), str(artifact),
    ], check=True)
    return artifact


def main():
    lock = HERE / 'package.lock.json'
    package = json.loads(lock.read_text())
    cache = DASHBOARD / 'build/browser-downloads'
    cache.mkdir(parents=True, exist_ok=True)
    home, rings = prepare_keyrings(cache)
    artifacts = [
        download_verified(entry, cache, home, rings)
        for entry in [package, *package.get('dependencies', [])]
    ]
    output = DASHBOARD / 'build/browser-runtime'
    with tempfile.TemporaryDirectory(prefix='browser-stage-', dir=output.parent) as temporary:
        unpack = Path(temporary) / 'unpack'
        unpack.mkdir()
        subprocess.run([
            'bsdtar', '-xf', str(artifacts[0]), '-C', str(unpack),
            'usr/lib/chromium', 'usr/share/licenses/chromium',
        ], check=True)
        stage = Path(temporary) / 'runtime'
        stage.mkdir()
        shutil.copytree(unpack / 'usr/lib/chromium', stage / 'chromium', symlinks=True)
        shutil.copytree(unpack / 'usr/share/licenses/chromium', stage / 'licenses', symlinks=True)
        for dependency in artifacts[1:]:
            other = Path(temporary) / dependency.name
            other.mkdir()
            subprocess.run([
                'bsdtar', '-xf', str(dependency), '-C', str(other),
                'usr/lib', 'usr/share/licenses',
            ], check=True)
            for library in (other / 'usr/lib').iterdir():
                if library.is_file() or library.is_symlink():
                    shutil.copy2(library, stage / 'chromium' / library.name, follow_symlinks=False)
            shutil.copytree(
                other / 'usr/share/licenses', stage / 'licenses/dependencies', dirs_exist_ok=True,
            )
        shutil.copy2(lock, stage / 'licenses/package.lock.json')
        files = []
        for path in sorted(stage.rglob('*')):
            relative = str(path.relative_to(stage))
            if path.is_symlink():
                if not path.resolve().is_relative_to(stage):
                    raise RuntimeError('External browser runtime symlink')
                files.append({'path': relative, 'symlink': os.readlink(path)})
            elif path.is_file():
                path.chmod(0o755 if path.stat().st_mode & 0o111 else 0o644)
                files.append({'path': relative, 'sha256': sha(path)})
        (stage / 'manifest.json').write_text(json.dumps({
            'version': 1,
            'packageLockSha256': sha(lock),
            'browserVersion': package['versionString'],
            'files': files,
        }, indent=2) + '\n')
        if output.exists():
            shutil.rmtree(output)
        shutil.copytree(stage, output, symlinks=True)
    print('Prepared Chromium ' + package['versionString'])


if __name__ == '__main__':
    main()
