#!/usr/bin/env python3
"""Prepare a private, pinned desktop runtime. Never installs host packages."""
import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import urllib.request

HERE = Path(__file__).resolve().parent
DASHBOARD = HERE.parent.parent
VENDOR = DASHBOARD.parent / 'third_party/agent-workspace-linux'


def sha(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def source_digest(root):
    files = sorted((path for path in root.rglob('*') if path.is_file()
        and not any(part in ('.git', 'target', 'node_modules') for part in path.relative_to(root).parts)),
        key=lambda path: str(path.relative_to(root)))
    content = ''.join(str(path.relative_to(root)) + '\0' + sha(path) + '\n' for path in files)
    return hashlib.sha256(content.encode()).hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--binary', type=Path, required=True)
    parser.add_argument('--output', type=Path, default=DASHBOARD / 'build/desktop-runtime')
    args = parser.parse_args()
    output = args.output.resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    cache = DASHBOARD / 'build/desktop-downloads'
    cache.mkdir(parents=True, exist_ok=True)
    gpg_home = cache / 'gnupg'
    gpg_home.mkdir(mode=0o700, exist_ok=True)
    keyrings = []
    for name in ['manjaro', 'archlinux']:
        source = Path('/usr/share/pacman/keyrings') / (name + '.gpg')
        keyring = cache / (name + '.gpg')
        if source.read_bytes().startswith(b'-----BEGIN PGP'):
            subprocess.run(['gpg', '--homedir', str(gpg_home), '--batch', '--yes', '--dearmor', '--output', str(keyring), str(source)], check=True)
        else:
            shutil.copy2(source, keyring)
        keyrings.extend(['--keyring', str(keyring)])
    packages = json.loads((HERE / 'packages.lock.json').read_text())['packages']
    with tempfile.TemporaryDirectory(prefix='desktop-stage-', dir=output.parent) as temporary:
        stage = Path(temporary)
        for package in packages:
            filename = package['url'].rsplit('/', 1)[1]
            cached = Path('/var/cache/pacman/pkg') / filename
            archive = cached if cached.exists() and sha(cached) == package['sha256'] else cache / filename
            if not archive.exists():
                request = urllib.request.Request(package['url'], headers={'User-Agent': 'B70-runtime-build/1'})
                part = archive.with_suffix(archive.suffix + '.part')
                with urllib.request.urlopen(request, timeout=30) as response, part.open('wb') as target:
                    copied = 0
                    while block := response.read(128 * 1024):
                        copied += len(block)
                        if copied > package['size']:
                            raise RuntimeError('Package exceeds pinned size')
                        target.write(block)
                part.replace(archive)
            if archive.stat().st_size != package['size'] or sha(archive) != package['sha256']:
                raise RuntimeError(f'Package integrity mismatch: {filename}')
            signature = cache / (filename + '.sig')
            signature.write_bytes(base64.b64decode(package['signature'], validate=True))
            subprocess.run(['gpgv', '--homedir', str(gpg_home), *keyrings, str(signature), str(archive)], check=True)
            # The independently signed distribution archive is extracted only into staging.
            subprocess.run(['bsdtar', '-xf', str(archive), '-C', str(stage),
                '--no-same-owner', '--no-same-permissions'], check=True)
            for metadata in stage.glob('.*'):
                if metadata.is_file():
                    metadata.unlink()
        (stage / 'bin').mkdir()
        shutil.copy2(args.binary, stage / 'bin/agent-workspace-linux')
        os.chmod(stage / 'bin/agent-workspace-linux', 0o755)
        # Runtime data uses our private prefix; never a user's desktop configuration.
        (stage / 'bin/openbox').write_text('''#!/bin/sh
ulimit -c 0
exec /runtime/desktop/usr/bin/openbox --sm-disable --config-file /runtime/desktop/etc/xdg/openbox/rc.xml "$@"
''')
        os.chmod(stage / 'bin/openbox', 0o755)
        # Openbox dereferences getpwuid(): provide ONLY the sandbox identity.
        # Never mount the operator's account database into generated applications.
        (stage / 'etc/passwd').write_text('nobody:x:65534:65534:B70 sandbox:/tmp:/bin/sh\n')
        (stage / 'etc/group').write_text('nobody:x:65534:\n')
        (stage / 'etc/nsswitch.conf').write_text('passwd: files\ngroup: files\nhosts: files\n')
        licenses = stage / 'licenses'
        licenses.mkdir()
        shutil.copy2(VENDOR / 'LICENSE', licenses / 'agent-workspace-linux-MIT.txt')
        shutil.copy2(VENDOR / 'B70-NOTES.md', licenses / 'B70-NOTES.md')
        shutil.copy2(HERE / 'packages.lock.json', licenses / 'packages.lock.json')
        shutil.copy2(HERE / 'rust-dependencies.json', licenses / 'rust-dependencies.json')
        files = []
        for path in sorted(stage.rglob('*')):
            if path.is_symlink():
                target = path.resolve()
                if not target.is_relative_to(stage):
                    raise RuntimeError(f'External runtime symlink: {path}')
                files.append({'path': str(path.relative_to(stage)), 'symlink': os.readlink(path)})
            elif path.is_file():
                files.append({'path': str(path.relative_to(stage)), 'sha256': sha(path)})
        (stage / 'manifest.json').write_text(json.dumps({
            'version': 1, 'upstream': 'https://github.com/agent-sh/agent-workspace-linux',
            'upstreamVersion': '0.6.4', 'upstreamCommit': 'b1756da4707fee8585ec0ffb8f8ddd9cfc25b519',
            'localVariant': 'B70 headless; no GPUI viewer or generic MCP host',
            'cargoLockSha256': sha(VENDOR / 'Cargo.lock'), 'files': files,
            'sourceDigest': source_digest(VENDOR), 'packageLockSha256': sha(HERE / 'packages.lock.json'),
        }, indent=2) + '\n')
        if output.exists():
            shutil.rmtree(output)
        shutil.copytree(stage, output, symlinks=True)
    print(f'Prepared desktop runtime: {output}')


if __name__ == '__main__':
    main()
