import { fileURLToPath } from 'node:url';
import { mergeConfig } from 'vitest/config';
import base from './packages/server/vitest.config.ts';

export default mergeConfig(base, {
  test: { include: ['test/**/*.test.ts', 'test/**/*.repro.ts'] },
  resolve: { alias: {
    '@observatory/contracts': fileURLToPath(new URL('./packages/contracts/src/index.ts', import.meta.url)),
    '@observatory/runner': fileURLToPath(new URL('./packages/runner/src/index.ts', import.meta.url)),
  } },
});
