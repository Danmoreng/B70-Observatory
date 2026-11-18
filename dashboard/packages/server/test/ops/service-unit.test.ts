import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { renderUnit } from '../../../../ops/service-unit.js';

const values = {
  user: 'observatory',
  group: 'observatory',
  projectDir: '/srv/local-ai-b70/dashboard',
  envFile: '/etc/local-ai-b70/observatory.env',
  nodeBinary: '/usr/bin/node',
  helperBinary: '/usr/local/libexec/local-ai-b70-gpu-helper',
  releaseHelperBinary: '/usr/local/libexec/local-ai-b70-release-helper.mjs',
  releaseRoot: '/var/lib/local-ai-b70-releases',
  observatoryHost: '192.168.1.20',
  releaseEnvFile: '/etc/local-ai-b70/release-helper.env',
  runnerEnvFile: '/etc/local-ai-b70/runner.env',
  runnerProjectRoots: '/srv/agent-projects',
  userId: '1000',
};

describe('Observatory systemd unit', () => {
  it('restarts the web service after clean or failed unexpected exits with bounded attempts', () => {
    const template = readFileSync(
      new URL('../../../../ops/local-ai-b70-observatory.service.template', import.meta.url),
      'utf8'
    );
    const unit = renderUnit(template, values);

    expect(unit).toContain('Restart=always');
    expect(unit).toContain('RestartSec=5s');
    expect(unit).toContain('StartLimitIntervalSec=60');
    expect(unit).toContain('StartLimitBurst=5');
    expect(unit).toContain(
      'ExecStart=/usr/bin/node /var/lib/local-ai-b70-releases/current/server.cjs'
    );
    expect(unit).toContain(`ReadWritePaths="${values.projectDir}/data"`);
    const external = renderUnit(template, { ...values, dataDirectory: '/srv/observatory-state' });
    expect(external).toContain('ReadWritePaths="/srv/observatory-state"');
    expect(external).not.toContain(`ReadWritePaths="${values.projectDir}/data"`);
    expect(unit).not.toContain('{{');
  });

  it('installs a separately restarting runner with a private state boundary', () => {
    const template = readFileSync(
      new URL('../../../../ops/local-ai-b70-runner.service.template', import.meta.url),
      'utf8'
    );
    const unit = renderUnit(template, values);

    expect(unit).toContain('EnvironmentFile=/etc/local-ai-b70/runner.env');
    expect(unit).toContain(
      'ExecStart=/usr/bin/env B70_RUNNER_SUPPORT_ROOT=/var/lib/local-ai-b70-releases/current/runtime B70_RUNNER_RELEASE_SOCKET=/run/local-ai-b70-release-helper/control.sock /usr/bin/node /var/lib/local-ai-b70-releases/current/runner.mjs'
    );
    expect(unit).toContain('Environment=XDG_RUNTIME_DIR=/run/user/1000');
    expect(unit).toContain('StateDirectory=local-ai-b70-runner');
    expect(unit).toContain(
      'ReadWritePaths=/var/lib/local-ai-b70-runner /run/local-ai-b70-runner /srv/agent-projects'
    );
    expect(unit).toContain('NoNewPrivileges=true');
    expect(unit).toContain('RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6 AF_NETLINK');
    expect(unit).not.toContain('ProtectKernelTunables=true');
    expect(unit).not.toContain('ProtectKernelLogs=true');
    expect(unit).not.toContain('RestrictSUIDSGID=true');
    expect(unit).toContain('Restart=always');
    expect(unit).not.toContain('{{');
  });

  it('installs a root-owned release helper with a narrow socket and filesystem boundary', () => {
    const template = readFileSync(
      new URL('../../../../ops/local-ai-b70-release-helper.service.template', import.meta.url),
      'utf8'
    );
    const unit = renderUnit(template, values);

    expect(unit).toContain('User=root');
    expect(unit).toContain('EnvironmentFile=/etc/local-ai-b70/release-helper.env');
    expect(unit).not.toContain('EnvironmentFile=/etc/local-ai-b70/observatory.env');
    expect(unit).toContain('RuntimeDirectory=local-ai-b70-release-helper');
    expect(unit).toContain('StateDirectoryMode=0750');
    expect(unit).toContain('ReadOnlyPaths=/var/lib/local-ai-b70-runner/releases');
    expect(unit).toContain('ReadWritePaths=/var/lib/local-ai-b70-releases');
    expect(unit).toContain('IPAddressDeny=any');
    expect(unit).toContain('IPAddressAllow=localhost');
    expect(unit).toContain('IPAddressAllow=192.168.1.20');
    expect(unit).not.toContain('MemoryDenyWriteExecute=true');
    expect(unit).not.toContain('{{');
  });
});
