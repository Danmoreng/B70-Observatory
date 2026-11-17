import { defineConfig } from 'vitest/config';

export default defineConfig({
  cacheDir: process.env.B70_READONLY_DEPS === '1' ? '/tmp/b70-vite-server' : undefined,
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
  },
});
