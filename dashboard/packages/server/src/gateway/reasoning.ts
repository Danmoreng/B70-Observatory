/**
 * Qwen's serving profile accepts low, medium and xhigh. Map the client spelling
 * high to xhigh across the native inference APIs. Other settings are left to
 * upstream validation. Preserve the original bytes when no translation occurs.
 */
export function normalizeReasoningEffort(body: Record<string, unknown>, raw: Buffer): Buffer {
  if (body.model === 'inkling2-mini-exl3-b70') return raw;
  let changed = false;
  const map = (object: Record<string, unknown>, key: string): void => {
    if (object[key] === 'high') {
      object[key] = 'xhigh';
      changed = true;
    }
  };
  map(body, 'reasoning_effort'); // Chat Completions
  for (const [container, key] of [
    ['reasoning', 'effort'], // Responses
    ['output_config', 'effort'], // Anthropic Messages / Claude Code
    ['chat_template_kwargs', 'reasoning_effort'], // Explicit template override
  ] as const) {
    const value = body[container];
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      map(value as Record<string, unknown>, key);
    }
  }
  return changed ? Buffer.from(JSON.stringify(body)) : raw;
}
