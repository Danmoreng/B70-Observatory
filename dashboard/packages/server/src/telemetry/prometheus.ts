/**
 * Minimal, defensive parser for the Prometheus text exposition format
 * (https://prometheus.io/docs/instrumenting/exposition_formats/).
 *
 * This is a boundary parser: the input is external (the vLLM `/metrics`
 * endpoint) and is treated as untrusted text. Rules:
 *
 * - lines starting with `#` (HELP, TYPE, …) are meta lines and ignored –
 *   counter-reset handling is driven by the metric names selected in the
 *   normalizer, so no type registry is needed; the series map only contains
 *   names that actually carried samples;
 * - a sample line is `<name>[{<labels>}] <value>[ <timestamp>]`;
 * - values must be finite decimal numbers (`NaN`, `+Inf`, `-Inf` are
 *   skipped together with their series – they are useless for rates);
 * - malformed lines (unparsable labels, missing value, garbage) are skipped
 *   individually; the parser never throws on bad input.
 */

/** One parsed sample: metric name, label set and finite numeric value. */
export interface PrometheusSeries {
  name: string;
  labels: Record<string, string>;
  value: number;
}

/** Parsed exposition text: metric name → all series carrying that name. */
export type ParsedPrometheus = Map<string, PrometheusSeries[]>;

/** Metric name grammar: `vllm:num_requests_running`, `vllm:foo:bar`, `a.b`, `a_c`. */
const NAME_REGEX = /^[A-Za-z_:][A-Za-z0-9_:.-]*$/;
const SAMPLE_REGEX = /^([A-Za-z_:][A-Za-z0-9_:.-]*)(?:\{([^}]*)\})?\s+(.+)$/;
const LABEL_PAIR_REGEX = /([A-Za-z_][A-Za-z0-9_]*)="((?:[^"\\]|\\.)*)"/g;
/** Finite decimal numbers; deliberately excludes `NaN`, `+Inf`, `-Inf`. */
const NUMBER_REGEX = /^[+-]?(?:\d+|\d*\.\d+|\d+\.)(?:[eE][+-]?\d+)?$/;

function unescapeLabelValue(raw: string): string {
  return raw.replace(/\\(.)/g, (match, char: string) => {
    if (char === 'n') return '\n';
    if (char === 't') return '\t';
    return char === '"' || char === '\\' ? char : match;
  });
}

function parseLabels(block: string): Record<string, string> | undefined {
  const labels: Record<string, string> = {};
  LABEL_PAIR_REGEX.lastIndex = 0;
  let matchedAny = false;
  let match: RegExpExecArray | null;
  while ((match = LABEL_PAIR_REGEX.exec(block)) !== null) {
    matchedAny = true;
    const key = match[1];
    const rawValue = match[2];
    if (key !== undefined && rawValue !== undefined) {
      labels[key] = unescapeLabelValue(rawValue);
    }
  }
  // If the block contained anything that is not a clean label pair (dangling
  // quotes, missing equals sign, nested braces), treat the line as malformed.
  const cleaned = block.replace(LABEL_PAIR_REGEX, () => '').replace(/[\s,]/g, '');
  if (block.length > 0 && cleaned.length > 0) return undefined;
  return matchedAny || block.length === 0 ? labels : undefined;
}

/**
 * Parse Prometheus text exposition data.
 *
 * - `# HELP …` / `# TYPE …` meta lines are ignored (counter reset handling
 *   is driven by the metric names selected in the normalizer, so no type
 *   registry is needed);
 * - a sample line is `<name>[{<labels>}] <value>[ <timestamp>]`;
 * - values must be finite decimal numbers (`NaN`, `+Inf`, `-Inf` are
 *   skipped together with their series – they are useless for rates);
 * - malformed lines (unparsable labels, missing value, garbage) are skipped
 *   individually; the parser never throws on bad input.
 */
export function parsePrometheus(text: string): ParsedPrometheus {
  const parsed: ParsedPrometheus = new Map();

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (line.length === 0) continue;
    if (line.startsWith('#')) continue; // HELP/TYPE and other meta lines

    const sampleMatch = SAMPLE_REGEX.exec(line);
    if (sampleMatch === null) continue;
    const name = sampleMatch[1];
    const labelBlock = sampleMatch[2];
    const valuePart = sampleMatch[3];
    if (name === undefined || !NAME_REGEX.test(name)) continue;

    // The value may be followed by a (ignored) UNIX timestamp.
    if (valuePart === undefined) continue;
    const valueToken = valuePart.split(/\s+/)[0];
    if (valueToken === undefined || !NUMBER_REGEX.test(valueToken)) continue;
    const value = Number(valueToken);
    if (!Number.isFinite(value)) continue;

    const labels = labelBlock === undefined ? {} : parseLabels(labelBlock);
    if (labelBlock !== undefined && labels === undefined) continue;

    const series = parsed.get(name) ?? [];
    series.push({ name, labels: labels ?? {}, value });
    parsed.set(name, series);
  }

  return parsed;
}
