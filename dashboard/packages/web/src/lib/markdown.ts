import createDOMPurify from 'dompurify';
import MarkdownIt from 'markdown-it';

const purifier = createDOMPurify(window);

const markdown = new MarkdownIt({
  breaks: true,
  html: false,
  linkify: true,
  typographer: false,
});

// Agent-authored images must not trigger browser requests to arbitrary hosts.
markdown.renderer.rules.image = (tokens, index) =>
  markdown.utils.escapeHtml(tokens[index]?.content ?? '');
markdown.renderer.rules.heading_open = (tokens, index) => {
  const level = Math.min(6, Math.max(2, Number(tokens[index]?.tag.slice(1) ?? 2)));
  return `<p class="markdown-heading markdown-heading-${level}">`;
};
markdown.renderer.rules.heading_close = () => '</p>';
markdown.renderer.rules.link_open = (tokens, index, options, _environment, renderer) => {
  tokens[index]?.attrSet('target', '_blank');
  tokens[index]?.attrSet('rel', 'noopener noreferrer');
  return renderer.renderToken(tokens, index, options);
};

export function renderAgentMarkdown(source: string): string {
  const rendered = `<div class="markdown-content">${markdown.render(source)}</div>`;
  return purifier.sanitize(rendered, {
    ALLOWED_ATTR: ['class', 'href', 'rel', 'target', 'title'],
    ALLOWED_TAGS: [
      'a',
      'blockquote',
      'br',
      'code',
      'del',
      'div',
      'em',
      'h1',
      'h2',
      'h3',
      'h4',
      'h5',
      'h6',
      'hr',
      'li',
      'ol',
      'p',
      'pre',
      's',
      'strong',
      'table',
      'tbody',
      'td',
      'th',
      'thead',
      'tr',
      'ul',
    ],
    ALLOW_DATA_ATTR: false,
  });
}
