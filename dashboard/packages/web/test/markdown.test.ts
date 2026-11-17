import { describe, expect, it } from 'vitest';
import { renderAgentMarkdown } from '../src/lib/markdown.js';

describe('agent Markdown rendering', () => {
  it('renders common Markdown used by final agent responses', () => {
    const rendered = renderAgentMarkdown(
      '# Ergebnis\n\n- **Fertig**\n- [Datei](https://example.com/file)\n\n```ts\nconst ok = true;\n```'
    );

    // Agent headings stay visually distinct without competing with the page heading hierarchy.
    expect(rendered).toContain('<p class="markdown-heading markdown-heading-2">Ergebnis</p>');
    expect(rendered).toContain('<strong>Fertig</strong>');
    expect(rendered).toContain('href="https://example.com/file"');
    expect(rendered).toContain('target="_blank"');
    expect(rendered).toContain('rel="noopener noreferrer"');
    expect(rendered).toContain('<pre><code class="language-ts">');
  });

  it('does not activate raw HTML, scripts, event handlers, unsafe links or images', () => {
    const rendered = renderAgentMarkdown(
      '<script>alert(1)</script>\n\n<a href="https://example.com" onclick="alert(1)">raw</a>\n\n[bad](javascript:alert(1))\n\n![tracker](https://example.com/pixel.png)'
    );

    const container = document.createElement('div');
    container.innerHTML = rendered;

    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('[onclick]')).toBeNull();
    expect(container.querySelector('a[href^="javascript:"]')).toBeNull();
    expect(container.querySelector('img')).toBeNull();
    expect(container.textContent).toContain('tracker');
  });
});
