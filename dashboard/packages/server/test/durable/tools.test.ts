import { describe, expect, it } from 'vitest';
import type { Message } from '@earendil-works/pi-ai';
import { createDashboardTools, trimModelImages } from '../../src/durable/tools.js';

describe('Durable tool boundary', () => {
  it('registers desktop tools only when enabled and never replays desktop effects', () => {
    expect(
      createDashboardTools(false).tools?.some((tool) => tool.name.startsWith('desktop_'))
    ).toBe(false);
    const tools = createDashboardTools(false, true).tools ?? [];
    expect(tools.some((tool) => tool.name === 'desktop_viewer_frame')).toBe(false);
    for (const name of [
      'desktop_start',
      'desktop_launch',
      'desktop_observe',
      'desktop_action',
      'desktop_stop',
    ]) {
      const tool = tools.find((entry) => entry.name === name);
      expect(tool, name).toBeDefined();
      expect(tool?.executionMode).toBe('sequential');
      expect(tool?.replay).not.toBe('safe');
    }
  });
  it('replays reads while leaving effectful tools and browser operations unsafe', () => {
    const extension = createDashboardTools(true);
    expect(extension.tools?.find((tool) => tool.name === 'read')?.replay).toBe('safe');
    for (const name of ['write', 'edit', 'bash', 'ask_user', 'browser_open', 'browser_action']) {
      const tool = extension.tools?.find((tool) => tool.name === name);
      expect(tool, name).toBeDefined();
      expect(tool?.replay, name).not.toBe('safe');
    }
  });
  it('bounds model image input without changing the stored conversation or text', () => {
    const messages: Message[] = [];
    for (let index = 0; index < 10; index++) {
      messages.push({
        role: 'user',
        timestamp: index,
        content: [
          { type: 'text', text: 'reference ' + index },
          { type: 'image', mimeType: 'image/png', data: 'user-' + index },
        ],
      });
      messages.push({
        role: 'toolResult',
        timestamp: index,
        toolName: 'browser_open',
        toolCallId: 'call-' + index,
        isError: false,
        content: [{ type: 'image', mimeType: 'image/png', data: 'tool-' + index }],
      });
    }
    const before = JSON.stringify(messages);
    const projection = trimModelImages(messages);
    const images = projection.flatMap((message) =>
      typeof message.content === 'string'
        ? []
        : message.content.filter((block) => block.type === 'image')
    );
    expect(images).toHaveLength(6);
    expect(images.map((block) => (block.type === 'image' ? block.data : ''))).toEqual([
      'user-6',
      'user-7',
      'user-8',
      'tool-8',
      'user-9',
      'tool-9',
    ]);
    expect(JSON.stringify(messages)).toBe(before);
    expect(JSON.stringify(projection)).toContain('reference 0');
  });
});
