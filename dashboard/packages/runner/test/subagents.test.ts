import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SubagentPool } from '../src/subagents.js';
const roots: string[] = [];
const pools: SubagentPool[] = [];
afterEach(async () => {
  for (const pool of pools.splice(0)) pool.close();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
describe('same-sandbox sub-agent pool', () => {
  it('runs two independent RPC children in one workspace, caps the third and reuses a finished child', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bsa-'));
    roots.push(root);
    const profile = join(root, 'profile');
    await mkdir(profile);
    await writeFile(join(profile, 'models.json'), '{}');
    const executable = join(root, 'fake.mjs');
    await writeFile(
      executable,
      `import readline from 'node:readline';import fs from 'node:fs';readline.createInterface({input:process.stdin}).on('line',line=>{const cmd=JSON.parse(line);console.log(JSON.stringify({type:'response',id:cmd.id,success:true}));console.log(JSON.stringify({type:'agent_start'}));fs.writeFileSync(cmd.message+'.txt',process.env.B70_SUBAGENT_CHILD);setTimeout(()=>{console.log(JSON.stringify({type:'message_end',message:{role:'assistant',content:[{type:'text',text:'done '+cmd.message}]}}));console.log(JSON.stringify({type:'agent_settled'}));},100);});`
    );
    const events: unknown[] = [];
    const pool = new SubagentPool({
      executable,
      profileRoot: profile,
      temporaryRoot: join(root, 'children'),
      workspace: root,
      provider: 'fixture',
      model: 'fixture',
      thinking: 'off',
      browser: false,
      onEvent: (id, name, event) => events.push({ id, name, event }),
    });
    pools.push(pool);
    const children = await Promise.all(['server', 'web'].map((name) => pool.start(name, name)));
    await expect(pool.start('third', 'extra')).rejects.toThrow('two');
    const results = await pool.wait(
      children.map((c) => c.id),
      5000
    );
    expect(results.every((child) => child.status === 'completed')).toBe(true);
    expect(events.length).toBeGreaterThan(4);
    pool.send(children[0]!.id, 'again');
    const next = await pool.wait([children[0]!.id], 5000);
    expect(next[0]?.result).toBe('done again');
    expect(pool.list()).toHaveLength(2);
  });
});
