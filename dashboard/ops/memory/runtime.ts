import { createHash } from 'node:crypto';
import { cpSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
const files = [
  'BetterSearch-LICENSE.txt',
  'NOTICE.txt',
  'b70-memory-embedding',
  'b70-memory-vision',
  'vision-dependencies-LICENSE.txt',
  'llama-LICENSE.txt',
  'vec0.so',
  'sqlite-vec-LICENSE.txt',
  'json-LICENSE.txt',
];
export function copyMemoryRuntime(root: string, source: string, target: string): void {
  const manifest = JSON.parse(readFileSync(join(source, 'manifest.json'), 'utf8')) as {
    version: number;
    backend: string;
    sourceSha256: string;
    pins: {
      bettersearch: string;
      llama: string;
      modelSha256: string;
      vecVersion: string;
      visionProjectorSha256?: string;
    };
    files: Array<{ file: string; sha256: string }>;
  };
  const digest = createHash('sha256')
    .update(readFileSync(join(root, 'ops/memory/embedding.cpp')))
    .update(readFileSync(join(root, 'ops/memory/CMakeLists.txt')))
    .update(readFileSync(join(root, 'ops/memory/vision.cpp')))
    .digest('hex');
  if (
    manifest.version !== 1 ||
    manifest.backend !== 'cpu' ||
    manifest.sourceSha256 !== digest ||
    manifest.pins.bettersearch !== '327d8c87b3b9f543a3a9103f1e95553e4b5471b9' ||
    manifest.pins.llama !== 'ac8e1694d837b11ed0aab944a6a2eee34b9c4d80' ||
    manifest.pins.modelSha256 !==
      '68bae29d62fb8c7d23e98d21fd4662753ddd636e6b62b8a70dfe059a9844f216' ||
    manifest.pins.vecVersion !== '0.1.9' ||
    manifest.pins.visionProjectorSha256 !==
      'd2033b3cd0223cfb2e7a2b50dc80a664c78c816d375f5b017ec3ef80ee0bc766'
  )
    throw new Error(
      'Memory runtime source or dependency pins changed. Rebuild the private CPU runtime.'
    );
  if (
    JSON.stringify(readdirSync(source).sort()) !==
      JSON.stringify([...files, 'manifest.json'].sort()) ||
    manifest.files.length !== files.length
  )
    throw new Error('Unexpected memory runtime files.');
  for (const name of files) {
    const entry = manifest.files.find((item) => item.file === name),
      path = join(source, name);
    if (
      !entry ||
      !lstatSync(path).isFile() ||
      createHash('sha256').update(readFileSync(path)).digest('hex') !== entry.sha256
    )
      throw new Error('Memory runtime integrity check failed: ' + name);
  }
  if (!lstatSync(join(source, 'manifest.json')).isFile())
    throw new Error('Invalid memory manifest.');
  cpSync(source, target, { recursive: true, dereference: false });
}
