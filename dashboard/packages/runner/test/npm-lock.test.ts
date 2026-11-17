import { describe, expect, it } from 'vitest';
import { hasStaleRootDependencies } from '../src/npm-lock.js';

describe('npm root dependency consistency', () => {
  it('detects the changed Sharp version and dependency section from the failed preview', () => {
    expect(
      hasStaleRootDependencies(
        { devDependencies: { sharp: '^0.34.2' } },
        { packages: { '': { dependencies: { sharp: '^0.35.5' } } } }
      )
    ).toBe(true);
  });

  it('preserves consistent locks despite metadata, order and transitive package differences', () => {
    expect(
      hasStaleRootDependencies(
        { name: 'app', dependencies: { b: '^2', a: '^1' } },
        {
          packages: {
            '': { name: 'old-name', dependencies: { a: '^1', b: '^2' } },
            'node_modules/a': { version: '1.2.3' },
          },
        }
      )
    ).toBe(false);
  });

  it('detects added and removed dependencies but leaves unsupported lock formats to npm', () => {
    expect(hasStaleRootDependencies({ dependencies: { a: '1' } }, { packages: { '': {} } })).toBe(
      true
    );
    expect(
      hasStaleRootDependencies({}, { packages: { '': { optionalDependencies: { a: '1' } } } })
    ).toBe(true);
    for (const lock of [null, [], {}, { lockfileVersion: 1, dependencies: {} }])
      expect(hasStaleRootDependencies({ dependencies: { a: '1' } }, lock)).toBe(false);
  });
});
