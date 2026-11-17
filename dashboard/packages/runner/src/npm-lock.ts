const sections = ['dependencies', 'devDependencies', 'optionalDependencies'] as const;

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Only recognize modern lockfiles with a root manifest; npm validates everything else. */
export function hasStaleRootDependencies(manifest: unknown, lock: unknown): boolean {
  const root = record(record(record(lock)?.packages)?.['']);
  const source = record(manifest);
  if (root === undefined || source === undefined) return false;
  return sections.some((section) => {
    const declared = record(source[section]) ?? {};
    const locked = record(root[section]) ?? {};
    const names = new Set([...Object.keys(declared), ...Object.keys(locked)]);
    return [...names].some((name) => declared[name] !== locked[name]);
  });
}
