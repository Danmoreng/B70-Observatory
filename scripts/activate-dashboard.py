#!/usr/bin/env python3
"""Activate a local monorepo build using the installed Observatory release helper."""
import argparse
import http.client
import json
import os
from pathlib import Path
import shutil
import socket
import sqlite3
import subprocess
import time
from uuid import uuid4

ROOT = Path(__file__).resolve().parents[1]
SOCKET = '/run/local-ai-b70-release-helper/control.sock'
STAGING = Path('/var/lib/local-ai-b70-runner/releases')


def helper(method, path, body=None):
    connection = http.client.HTTPConnection('localhost', timeout=15)
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as stream:
        stream.settimeout(15)
        stream.connect(SOCKET)
        connection.sock = stream
        connection.request(method, path, body=json.dumps(body) if body else None,
                           headers={'Content-Type': 'application/json'})
        response = connection.getresponse()
        value = json.load(response)
        if response.status >= 300:
            raise RuntimeError(f'Release helper returned HTTP {response.status}: {value}')
        return value


def require_idle(runner_db, observatory_db):
    for path, query in [
        (runner_db, "SELECT 1 FROM agent_runs WHERE status IN ('running','starting','queued') LIMIT 1"),
        (observatory_db, "SELECT 1 FROM requests WHERE status='in_progress' LIMIT 1"),
    ]:
        with sqlite3.connect(path.resolve().as_uri() + '?mode=ro', uri=True) as db:
            if db.execute(query).fetchone():
                raise SystemExit('Wait for active agent runs and gateway requests to finish.')


def main():
    state = Path(os.environ.get('XDG_STATE_HOME', Path.home()/'.local/state'))
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--observatory-db', type=Path, default=state/'b70-observatory/dashboard/observatory.db')
    parser.add_argument('--runner-db', type=Path, default=Path('/var/lib/local-ai-b70-runner/tasks.sqlite'))
    args = parser.parse_args()
    if subprocess.check_output(['git', '-C', ROOT, 'status', '--porcelain']):
        raise SystemExit('Commit the source changes before building and activating the release.')
    revision = subprocess.check_output(['git', '-C', ROOT, 'rev-parse', 'HEAD'], text=True).strip()
    artifact = ROOT/'dashboard/build/observatory-release'
    manifest = json.loads((artifact/'manifest.json').read_text())
    if manifest['revision'] != revision:
        raise SystemExit('Run npm run build from dashboard/ at the current Git revision.')
    ref = {'revision': revision, 'digest': manifest['artifactDigest'], 'releaseId': str(uuid4())}
    before = helper('GET', '/v1/status')
    current = before.get('current') or {}
    if before['status'] == 'activating':
        raise SystemExit('Another release operation is in progress.')
    if (current.get('revision'), current.get('digest')) == (revision, ref['digest']) and before['status'] == 'active':
        print('This build is active.')
        return
    require_idle(args.runner_db, args.observatory_db)
    dest = STAGING/ref['releaseId']
    shutil.copytree(artifact, dest, symlinks=True)
    try:
        require_idle(args.runner_db, args.observatory_db)
        if helper('GET', '/v1/status') != before:
            raise SystemExit('The active release changed during staging.')
    except BaseException:
        shutil.rmtree(dest)
        raise
    # From here the helper owns validation, service restarts and rollback.
    helper('POST', '/v1/activate', ref)
    deadline = time.monotonic() + 180
    while time.monotonic() < deadline:
        status = helper('GET', '/v1/status')
        if status['status'] != 'activating':
            if status.get('current') != ref or status['status'] != 'active':
                raise SystemExit(f"Activation ended with {status['status']}: {status.get('message', '')}")
            print(f'Active dashboard and runner at {revision}.')
            return
        time.sleep(1)
    raise SystemExit('Activation still pending. Inspect the release helper status.')


if __name__ == '__main__':
    main()
