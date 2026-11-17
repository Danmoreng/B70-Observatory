import { fileURLToPath } from 'node:url';
import { mergeConfig } from 'vitest/config';
import base from './packages/web/vite.config.ts';

// Use the audited source, not an older dist/ from shared dependency symlinks.
export default mergeConfig(base, {
  test: { include: ['test/**/*.test.ts', 'test/**/*.repro.ts'] },
  resolve: { alias: {
    '@observatory/contracts': fileURLToPath(new URL('./packages/contracts/src/index.ts', import.meta.url)),
  } },
});
