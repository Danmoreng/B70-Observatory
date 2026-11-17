import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectDir = resolve(fileURLToPath(new URL('..', import.meta.url)));
const source = `${projectDir}/native/gpu-helper.cpp`;
const output = `${projectDir}/build/local-ai-b70-gpu-helper`;
const compiler = ['/usr/local/bin/g++', '/usr/bin/g++', '/usr/bin/clang++'].find(existsSync);

if (compiler === undefined) {
  throw new Error('A C++ compiler (g++ or clang++) is required to build the native GPU helper');
}

mkdirSync(`${projectDir}/build`, { recursive: true });
execFileSync(
  compiler,
  [
    '-std=c++20',
    '-O2',
    '-Wall',
    '-Wextra',
    '-Wpedantic',
    '-Werror',
    '-D_FORTIFY_SOURCE=3',
    '-fstack-protector-strong',
    '-fPIE',
    '-pie',
    '-Wl,-z,relro,-z,now',
    source,
    '-o',
    output,
  ],
  { stdio: 'inherit' }
);
chmodSync(output, 0o755);
execFileSync(output, ['--self-test'], { stdio: 'inherit' });
