// Temporary, loopback-only validation server; uses no production database.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../packages/server/dist/app.js';
import { loadServerConfig } from '../packages/server/dist/config.js';
import { openDatabase } from '../packages/server/dist/db/database.js';
import { RequestRepository } from '../packages/server/dist/db/index.js';
const dir = mkdtempSync(join(tmpdir(), 'b70-gateway-smoke-'));
const config = loadServerConfig({
  OBSERVATORY_UPSTREAM_TIMEOUT_MS: '600000',
  OBSERVATORY_UPSTREAM_STREAM_IDLE_TIMEOUT_MS: '600000',
  OBSERVATORY_MAX_REQUEST_BYTES: '16777216',
});
const db = openDatabase({ path: join(dir, 'test.db'), busyTimeoutMs: 2000 });
const app = buildApp({
  version: 'live-smoke',
  config,
  loggerLevel: 'silent',
  database: db,
  gateway: { config, requests: new RequestRepository(db) },
});
await app.listen({ host: '127.0.0.1', port: 18090 });
console.log('Temporary gateway ready: 127.0.0.1:18090');
for (const signal of ['SIGTERM', 'SIGINT'])
  process.once(signal, async () => {
    await app.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
    process.exit(0);
  });
