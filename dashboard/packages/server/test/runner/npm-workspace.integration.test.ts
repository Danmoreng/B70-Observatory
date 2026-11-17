import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { AppPreviewManager } from '../../src/runner/app-preview.js';
import { describe, expect, it } from 'vitest';
import { createNpmRegistry } from '../../src/runner/npm-registry.js';
import { prepareNpmWorkspace } from '../../src/runner/npm-workspace.js';

describe.runIf(process.env.B70_NPM_SMOKE === '1' && existsSync('/usr/bin/bwrap'))(
  'public npm packages in a real networkless sandbox',
  () => {
    it('installs Sharp prebuilt binaries and converts images with native sandbox tools', async () => {
      const root = await mkdtemp(join(tmpdir(), 'bnpm-images-'));
      const workspace = join(root, 'workspace');
      await mkdir(workspace);
      const registry = createNpmRegistry({ socketPath: join(root, 'ipc/npm.sock') });
      await registry.start();
      try {
        await writeFile(
          join(workspace, 'package.json'),
          JSON.stringify({
            name: 'image-tools-test',
            type: 'module',
            devDependencies: { sharp: '^0.34.2' },
            scripts: { build: 'node build.mjs' },
          })
        );
        await writeFile(
          join(workspace, 'build.mjs'),
          `
          import {execFileSync} from 'node:child_process'; import sharp from 'sharp';
          await sharp({create:{width:3000,height:2000,channels:3,background:'#b43863'}}).png().toFile('original.png');
          execFileSync('/usr/bin/magick',['original.png','-auto-orient','-resize','1920x1920>','-strip','-quality','82','web.webp']);
          execFileSync('/usr/bin/ffmpeg',['-v','error','-i','original.png','-frames:v','1','-vf','scale=1200:-1','-c:v','libwebp','-quality','78','preview.webp']);
          const web=await sharp('web.webp').metadata(), preview=await sharp('preview.webp').metadata();
          if(web.format!=='webp'||web.width!==1920||web.height!==1280||preview.width!==1200||preview.height!==800)throw Error('Incorrect conversion');
          console.log('native WebP conversions passed');
        `
        );
        const log = await prepareNpmWorkspace(resolve('../runner/dist'), registry, workspace, true);
        expect(log).toContain('native WebP conversions passed');
        expect(existsSync(join(workspace, 'node_modules/@img/sharp-linux-x64'))).toBe(true);
      } finally {
        await registry.close();
        await rm(root, { recursive: true, force: true });
      }
    }, 90_000);

    it('repairs a stale lock only in the isolated preview, then clean-installs and serves the app', async () => {
      const root = await mkdtemp(join(tmpdir(), 'bnpm-stale-'));
      const workspace = join(root, 'workspace');
      await mkdir(workspace);
      const registry = createNpmRegistry({ socketPath: join(root, 'ipc/npm.sock') });
      await registry.start();
      const manager = new AppPreviewManager(
        join(root, 'apps'),
        resolve('../runner/dist'),
        '127.0.0.1',
        registry
      );
      try {
        const packagePath = join(workspace, 'package.json');
        await writeFile(
          packagePath,
          JSON.stringify({ name: 'stale-lock-test', dependencies: { 'is-number': '6.0.0' } })
        );
        await prepareNpmWorkspace(resolve('../runner/dist'), registry, workspace);
        const originalLock = await readFile(join(workspace, 'package-lock.json'), 'utf8');
        await writeFile(
          packagePath,
          JSON.stringify({ name: 'stale-lock-test', devDependencies: { 'is-number': '7.0.0' } })
        );
        // Normal agent preparation remains strict; only disposable preview builds repair locks.
        await expect(
          prepareNpmWorkspace(resolve('../runner/dist'), registry, workspace)
        ).rejects.toThrow('npm ci');
        await writeFile(
          join(workspace, 'server.mjs'),
          `import http from 'node:http'; import isNumber from 'is-number'; http.createServer((_,res)=>res.end(String(isNumber(42)))).listen(Number(process.env.PORT),'127.0.0.1');`
        );
        await writeFile(join(workspace, '.gitignore'), 'node_modules/\n');
        for (const args of [
          ['init', '-q', '-b', 'main'],
          ['config', 'user.name', 'Npm test'],
          ['config', 'user.email', 'npm@local.invalid'],
          ['add', '.'],
          ['commit', '-qm', 'stale lock fixture'],
        ])
          execFileSync('/usr/bin/git', ['-C', workspace, ...args]);
        const revision = execFileSync('/usr/bin/git', ['-C', workspace, 'rev-parse', 'HEAD'], {
          encoding: 'utf8',
        }).trim();
        const state = await manager.start(
          '11111111-1111-4111-8111-111111111111',
          workspace,
          revision
        );
        expect(state.status).toBe('running');
        expect(state.logs).toContain('isolated build snapshot');
        const base = `http://127.0.0.1:${state.port}`;
        const entry = await fetch(base + state.accessPath, { redirect: 'manual' });
        const cookie = entry.headers.get('set-cookie')!.split(';')[0]!;
        expect(await (await fetch(base, { headers: { cookie } })).text()).toBe('true');
        expect(await readFile(join(workspace, 'package-lock.json'), 'utf8')).toBe(originalLock);
      } finally {
        await manager.close();
        await registry.close();
        await rm(root, { recursive: true, force: true });
      }
    }, 90_000);

    it('installs the requested Vue/Vite/Fastify/Three/TS stack, builds and restores it in a fresh workspace', async () => {
      const root = await mkdtemp(join(tmpdir(), 'bnpm-'));
      const workspace = join(root, 'workspace');
      const sockets = join(root, 'ipc');
      await mkdir(workspace);
      await mkdir(sockets);
      const registry = createNpmRegistry({ socketPath: join(sockets, 'npm.sock') });
      await registry.start();
      try {
        await writeFile(
          join(workspace, 'package.json'),
          JSON.stringify({
            name: 'npm-sandbox-test',
            private: true,
            type: 'module',
            dependencies: {
              vue: '^3.5.0',
              vite: '^8.0.0',
              fastify: '^5.0.0',
              '@fastify/sse': '*',
              three: '*',
              typescript: '*',
            },
            scripts: { build: 'node -e "import(\'vue\').then(v=>console.log(v.version))"' },
          })
        );
        const log = await prepareNpmWorkspace(resolve('../runner/dist'), registry, workspace, true);
        expect(log).toContain('added');
        const lock = await readFile(join(workspace, 'package-lock.json'), 'utf8');
        expect(lock).toContain('node_modules/three');
        expect(lock).toContain('node_modules/fastify');
        // Reinstall lockfile from an independent task snapshot, with no shared node_modules/cache.
        const second = join(root, 'second');
        await mkdir(second);
        await writeFile(
          join(second, 'package.json'),
          await readFile(join(workspace, 'package.json'))
        );
        await writeFile(join(second, 'package-lock.json'), lock);
        await prepareNpmWorkspace(resolve('../runner/dist'), registry, second, true);
        expect(existsSync(join(second, 'node_modules/three/package.json'))).toBe(true);
        const packagePath = join(second, 'package.json');
        const manifest = JSON.parse(await readFile(packagePath, 'utf8')) as {
          scripts: Record<string, string>;
        };
        manifest.scripts.build = 'node build.mjs';
        await writeFile(packagePath, JSON.stringify(manifest));
        await writeFile(
          join(second, 'build.mjs'),
          `import { mkdir, writeFile } from 'node:fs/promises'; await Promise.all(['vue','vite','fastify','@fastify/sse','three','typescript'].map(name => import(name))); await mkdir('dist',{recursive:true}); await writeFile('dist/ready.txt','built with npm dependencies');`
        );
        await writeFile(
          join(second, 'server.mjs'),
          `import Fastify from 'fastify'; import {readFile} from 'node:fs/promises'; const app=Fastify(); app.get('/',async()=>await readFile(new URL('./dist/ready.txt',import.meta.url),'utf8')); await app.listen({port:Number(process.env.PORT),host:'127.0.0.1'});`
        );
        await writeFile(join(second, '.gitignore'), 'node_modules/\ndist/\n');
        for (const args of [
          ['init', '-q', '-b', 'main'],
          ['config', 'user.name', 'Npm test'],
          ['config', 'user.email', 'npm@local.invalid'],
          ['add', '.'],
          ['commit', '-qm', 'npm app fixture'],
        ])
          execFileSync('/usr/bin/git', ['-C', second, ...args]);
        const revision = execFileSync('/usr/bin/git', ['-C', second, 'rev-parse', 'HEAD'], {
          encoding: 'utf8',
        }).trim();
        const manager = new AppPreviewManager(
          join(root, 'apps'),
          resolve('../runner/dist'),
          '127.0.0.1',
          registry
        );
        try {
          const state = await manager.start(
            '11111111-1111-4111-8111-111111111111',
            second,
            revision
          );
          const base = `http://127.0.0.1:${state.port}`;
          const entry = await fetch(base + state.accessPath, { redirect: 'manual' });
          const cookie = entry.headers.get('set-cookie')!.split(';')[0]!;
          expect(await (await fetch(base, { headers: { cookie } })).text()).toBe(
            'built with npm dependencies'
          );
        } finally {
          await manager.close();
        }
      } finally {
        await registry.close();
        await rm(root, { recursive: true, force: true });
      }
    }, 180_000);
  }
);
