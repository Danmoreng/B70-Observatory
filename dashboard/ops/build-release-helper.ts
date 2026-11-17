import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectDir = resolve(fileURLToPath(new URL('..', import.meta.url)));
const output = `${projectDir}/build/local-ai-b70-release-helper.mjs`;
mkdirSync(`${projectDir}/build`, { recursive: true });
execFileSync(
  `${projectDir}/node_modules/.bin/esbuild`,
  [
    `${projectDir}/ops/release-helper.ts`,
    '--bundle',
    '--platform=node',
    '--format=esm',
    '--target=node24',
    `--outfile=${output}`,
  ],
  { stdio: 'inherit' }
);
chmodSync(output, 0o755);
execFileSync(process.execPath, ['--check', output], { stdio: 'inherit' });
