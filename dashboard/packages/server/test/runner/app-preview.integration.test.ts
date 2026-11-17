import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AppPreviewManager } from '../../src/runner/app-preview.js';

const image = 'UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA';
describe.runIf(process.env.B70_APP_SMOKE === '1' && existsSync('/usr/bin/bwrap'))(
  'real sandbox app preview relay',
  () => {
    it('serves parallel image bursts and queued POSTs without exhausting its reverse connections', async () => {
      const root = await mkdtemp(join(tmpdir(), 'bapp-relay-'));
      const repository = join(root, 'repo');
      execFileSync('/usr/bin/git', ['init', '-q', '-b', 'main', repository]);
      await writeFile(
        join(repository, 'server.mjs'),
        `
        import http from 'node:http'; let posts=0;
        http.createServer((req,res)=>{
          let body='';req.on('data',chunk=>body+=chunk);req.on('end',()=>setTimeout(()=>{
            if(req.method==='POST'){res.setHeader('content-type','application/json');res.end(JSON.stringify({body,count:++posts}));}
            else {res.setHeader('content-type','image/webp');res.end(Buffer.from('${image}','base64'));}
          },20));
        }).listen(Number(process.env.PORT),'127.0.0.1');
      `
      );
      execFileSync('/usr/bin/git', ['-C', repository, 'add', '.']);
      execFileSync('/usr/bin/git', [
        '-C',
        repository,
        '-c',
        'user.name=App test',
        '-c',
        'user.email=app@local.invalid',
        'commit',
        '-qm',
        'parallel asset fixture',
      ]);
      const revision = execFileSync('/usr/bin/git', ['-C', repository, 'rev-parse', 'HEAD'], {
        encoding: 'utf8',
      }).trim();
      const manager = new AppPreviewManager(
        join(root, 'apps'),
        resolve('../runner/dist'),
        '127.0.0.1'
      );
      try {
        const state = await manager.start(
          '11111111-1111-4111-8111-111111111111',
          repository,
          revision
        );
        const base = `http://127.0.0.1:${state.port}`;
        const entry = await fetch(base + state.accessPath, { redirect: 'manual' });
        const cookie = entry.headers.get('set-cookie')!.split(';')[0]!;
        for (let round = 0; round < 3; round++) {
          const responses = await Promise.all(
            Array.from({ length: 24 }, async (_, i) => {
              const response = await fetch(base + '/asset-' + i + '.webp', {
                headers: { cookie },
                signal: AbortSignal.timeout(10000),
              });
              return {
                status: response.status,
                body: Buffer.from(await response.arrayBuffer()).toString('base64'),
              };
            })
          );
          expect(responses.every((r) => r.status === 200)).toBe(true);
          expect(responses.every((r) => r.body === image)).toBe(true);
        }
        const posts = await Promise.all(
          Array.from({ length: 16 }, async (_, i) => {
            const response = await fetch(base + '/save', {
              method: 'POST',
              headers: { cookie },
              body: 'item-' + i,
              signal: AbortSignal.timeout(10000),
            });
            expect(response.status).toBe(200);
            return (await response.json()) as { body: string; count: number };
          })
        );
        expect(posts.map((x) => x.body)).toEqual(Array.from({ length: 16 }, (_, i) => 'item-' + i));
        expect(posts.map((x) => x.count).sort((a, b) => a - b)).toEqual(
          Array.from({ length: 16 }, (_, i) => i + 1)
        );
      } finally {
        await manager.close();
        await rm(root, { recursive: true, force: true });
      }
    }, 60_000);
  }
);
