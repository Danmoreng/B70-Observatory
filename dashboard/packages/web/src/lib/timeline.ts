import type { AgentTimelineItem } from '@observatory/contracts';
import { t } from './i18n.js';

export interface TimelineViewport {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}

export function isTimelineNearEnd(viewport: TimelineViewport, threshold = 36): boolean {
  return viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop <= threshold;
}

export function newTimelineItemCount(previous: number, current: number): number {
  return Math.max(0, current - previous);
}

/** Omit only obsolete screenshot boilerplate explicitly removed from the UI.
 * Original trace records remain stored; DOM reports, diagnostics and errors stay visible.
 */
export function timelineToolOutput(item: AgentTimelineItem): string {
  const text = item.outputText ?? '';
  if (!item.toolName?.startsWith('browser_') || !item.images?.length || item.state === 'error')
    return text;
  const output = text
    .replace(
      /(?:^|\n)Aktueller Screenshot: \d+×\d+\. Dasselbe Bild wird im Transkript angezeigt\.\s*$/,
      ''
    )
    .trim();
  if (
    item.toolName === 'browser_action' &&
    /^(?:Seite neu geladen\.|Klick bei -?\d+,-?\d+ ausgeführt\.|\d+ Zeichen eingegeben\.|Taste [^\n]+ gedrückt\.|Element in Ansicht gescrolled\.|Um -?\d+px gescrolled\.)$/.test(
      output
    )
  )
    return '';
  if (
    item.toolName === 'browser_resize' &&
    /^Vorschau ohne Neuladen angepasst: \d+×\d+\.$/.test(output)
  )
    return '';
  if (item.toolName === 'browser_open') {
    const opened = output.match(/^Vorschau geöffnet \((chromium|firefox)\): ([^\n]+)\.$/);
    if (opened) {
      const [url, ...title] = opened[2]!.split(' · Titel: ');
      return JSON.stringify({ browser: opened[1], url, title: title.join(' · Titel: ') });
    }
  }
  if (
    item.toolName === 'browser_screenshot' &&
    /^Screenshot „[^\n]+\. Bild an Agenten zurückgegeben\.$/.test(output)
  )
    return output.includes('Höhe auf 8192 px begrenzt') ? t('agent.screenshotClipped') : '';
  return output;
}
