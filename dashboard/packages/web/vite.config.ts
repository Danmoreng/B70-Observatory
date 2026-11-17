import vue from '@vitejs/plugin-vue';
import { defineConfig } from 'vitest/config';

/**
 * The web app talks to the API same-origin (`/api`). In development the Vite
 * dev server proxies `/api` to the local API on port 8090, so no CORS
 * configuration is needed and the browser never sees a foreign origin.
 */
export default defineConfig({
  cacheDir: process.env.B70_READONLY_DEPS === '1' ? '/tmp/b70-vite-web' : undefined,
  plugins: [vue()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8090',
        changeOrigin: false,
      },
    },
  },
  preview: {
    host: '127.0.0.1',
    port: 5174,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8090',
        changeOrigin: false,
      },
    },
  },
  test: {
    environment: 'happy-dom',
    include: ['test/**/*.test.ts'],
  },
});
