/** Build-time dependency binding. Never called from model tools. */
import { createHash } from 'node:crypto';
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

export function desktopSourceDigest(root: string): string {
  const files: string[] = [];
  const visit = (directory: string, prefix: string) => {
    for (const name of readdirSync(directory)) {
      if (['.git', 'target', 'node_modules'].includes(name)) continue;
      const path = join(directory, name);
      const info = lstatSync(path);
      if (info.isDirectory()) visit(path, prefix + name + '/');
      else if (info.isFile()) files.push(prefix + name);
      else throw new Error('Desktop source contains an unsupported file type');
    }
  };
  visit(root, '');
  const digest = createHash('sha256');
  for (const file of files.sort())
    digest.update(
      file +
        '\0' +
        createHash('sha256')
          .update(readFileSync(join(root, file)))
          .digest('hex') +
        '\n'
    );
  return digest.digest('hex');
}

/** Carry a previously approved native bundle into a network-isolated release build.
 * Changed native source or package pins require a fresh operator source build.
 */
export function stageApprovedDesktop(
  approved: string,
  prepared: string,
  vendor: string,
  packageLock: string
): void {
  if (!existsSync(join(approved, 'manifest.json')) || existsSync(join(prepared, 'manifest.json')))
    return;
  const manifest = JSON.parse(readFileSync(join(approved, 'manifest.json'), 'utf8')) as {
    sourceDigest?: string;
    packageLockSha256?: string;
  };
  if (
    manifest.sourceDigest !== desktopSourceDigest(vendor) ||
    manifest.packageLockSha256 !==
      createHash('sha256').update(readFileSync(packageLock)).digest('hex')
  )
    throw new Error(
      'Desktop source or package pins changed; prepare a fresh reviewed native runtime before release.'
    );
  mkdirSync(dirname(prepared), { recursive: true });
  cpSync(approved, prepared, { recursive: true, dereference: true });
}

/** Reuse only the immutable browser runtime matching the checked-in package pins. */
export function stageApprovedBrowsers(
  approved: string,
  prepared: string,
  packageLock: string
): void {
  if (!existsSync(join(approved, 'manifest.json')) || existsSync(join(prepared, 'manifest.json')))
    return;
  const manifest = JSON.parse(readFileSync(join(approved, 'manifest.json'), 'utf8')) as {
    packageLockSha256?: string;
  };
  if (
    manifest.packageLockSha256 !==
    createHash('sha256').update(readFileSync(packageLock)).digest('hex')
  )
    throw new Error('Browser package pins changed; prepare a fresh reviewed browser runtime.');
  mkdirSync(dirname(prepared), { recursive: true });
  cpSync(approved, prepared, { recursive: true });
}
