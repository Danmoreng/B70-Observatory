import { posix } from 'node:path';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import type { ExecutionEnv } from '@earendil-works/pi-durable/env';

/** Read project guidance through the sandbox, including symlinks, never on the host. */
export async function readWorkspaceInstructions(env: ExecutionEnv): Promise<string> {
  if (env.cwd !== '/workspace' && !env.cwd.startsWith('/workspace/'))
    throw new Error('Invalid sandbox working directory');
  const directories = ['/workspace'];
  for (const part of env.cwd.slice('/workspace'.length).split('/').filter(Boolean)) {
    if (part === '.' || part === '..') throw new Error('Invalid sandbox working directory');
    directories.push(posix.join(directories.at(-1)!, part));
  }
  const sections: string[] = [];
  let remaining = 65536;
  for (const directory of directories) {
    if (remaining === 0) break;
    const path = posix.join(directory, 'AGENTS.md');
    let content = '';
    const result = await env.exec(
      ['/usr/bin/head', '-c', String(Math.min(32768, remaining)), '--', path],
      {
        timeout: 5,
        onOutput: (text) => {
          content += text.slice(0, remaining - content.length);
        },
      },
      BACKGROUND_CONTEXT
    );
    if (!result.ok || result.value.exitCode !== 0) continue;
    remaining -= content.length;
    sections.push(
      `Projektanweisungen aus ${path} (höchstens 32768 Zeichen; zusätzliche Anweisungen in Unterverzeichnissen bei Bedarf lesen):\n${content}`
    );
  }
  return sections.join('\n\n');
}
