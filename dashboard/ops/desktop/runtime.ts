import { createHash } from 'node:crypto';
import {
  copyFileSync,
  chmodSync,
  constants,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/** Verify all prepared files, including symlinks, before copying into a release. */
export function verifyDesktopRuntime(
  root: string,
  binding?: { sourceDigest: string; packageLockSha256: string }
): void {
  root = realpathSync(root);
  const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8')) as {
    version: number;
    sourceDigest?: string;
    packageLockSha256?: string;
    files: Array<{ path: string; sha256?: string; symlink?: string }>;
  };
  if (manifest.version !== 1 || !Array.isArray(manifest.files))
    throw new Error('Invalid desktop runtime manifest');
  if (
    binding &&
    (manifest.sourceDigest !== binding.sourceDigest ||
      manifest.packageLockSha256 !== binding.packageLockSha256)
  )
    throw new Error('Desktop runtime no longer matches its source or package pins; rebuild it.');
  const expected = new Set<string>();
  for (const file of manifest.files) {
    if (
      typeof file.path !== 'string' ||
      !file.path.length ||
      file.path.split('/').some((part) => !part || part === '..' || part === '.') ||
      expected.has(file.path)
    )
      throw new Error('Invalid desktop artifact path');
    const path = resolve(root, file.path);
    if (!path.startsWith(root + '/')) throw new Error('Invalid desktop artifact path');
    expected.add(file.path);
    const info = lstatSync(path);
    if (info.isSymbolicLink()) {
      if (
        typeof file.symlink !== 'string' ||
        readlinkSync(path) !== file.symlink ||
        !realpathSync(path).startsWith(root + '/') ||
        !lstatSync(realpathSync(path)).isFile()
      )
        throw new Error('Invalid desktop symlink');
    } else if (
      !info.isFile() ||
      typeof file.sha256 !== 'string' ||
      createHash('sha256').update(readFileSync(path)).digest('hex') !== file.sha256
    )
      throw new Error(`Desktop artifact integrity mismatch: ${file.path}`);
  }
  const visit = (directory: string, prefix: string) => {
    for (const name of readdirSync(directory)) {
      const relative = prefix + name;
      if (relative === 'manifest.json') continue;
      const path = join(directory, name);
      if (lstatSync(path).isDirectory()) visit(path, relative + '/');
      else if (!expected.delete(relative))
        throw new Error(`Unlisted desktop artifact: ${relative}`);
    }
  };
  visit(root, '');
  if (expected.size) throw new Error('Missing desktop artifact');
}

/** Releases intentionally allow regular files only; materialize verified library links. */
export function copyDesktopRuntime(source: string, destination: string): void {
  verifyDesktopRuntime(source);
  const manifest = JSON.parse(readFileSync(join(source, 'manifest.json'), 'utf8')) as {
    files: Array<{ path: string }>;
  };
  mkdirSync(destination);
  for (const { path } of manifest.files) {
    const target = join(destination, path);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(join(source, path), target, constants.COPYFILE_EXCL);
    chmodSync(target, statSync(join(source, path)).mode & 0o111 ? 0o755 : 0o644);
  }
  const files = manifest.files.map(({ path }) => ({
    path,
    sha256: createHash('sha256')
      .update(readFileSync(join(destination, path)))
      .digest('hex'),
  }));
  writeFileSync(
    join(destination, 'manifest.json'),
    JSON.stringify({ ...manifest, representation: 'regular-files', files }, null, 2) + '\n'
  );
  verifyDesktopRuntime(destination);
}
