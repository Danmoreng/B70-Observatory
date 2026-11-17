import { createConnection } from 'node:net';
const raw = process.argv[2] ?? '';
if (raw.length > 1024 * 1024) throw new Error('Browser request too large');
const value = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as unknown;
const socket = createConnection('/tmp/b70-durable-browser.sock');
socket.once('connect', () => socket.write(JSON.stringify(value) + '\n'));
socket.on('data', (chunk) => {
  if (!process.stdout.write(chunk)) socket.pause();
});
process.stdout.on('drain', () => socket.resume());
socket.once('end', () => process.stdout.end());
socket.once('error', () => {
  process.exitCode = 1;
  process.stdout.end();
});
socket.setTimeout(120_000, () => {
  socket.destroy();
  process.exitCode = 1;
});
