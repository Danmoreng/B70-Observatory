import type { AgentTimelineItem, SubagentRun } from '@observatory/contracts';

/** Old traces used prefixed titles; keep them navigable without rewriting user data. */
export function conversationIdentity(
  item: AgentTimelineItem
): { id: string; name: string } | undefined {
  if (item.agent) return item.agent;
  const legacy =
    /^\[Sub-Agent ([^\]]+)\]\n/.exec(item.text ?? '') ?? /^\[([^\]]+)\] /.exec(item.title);
  return legacy ? { id: `legacy:${legacy[1]}`, name: legacy[1]! } : undefined;
}

export function isInternalDiagnostic(item: AgentTimelineItem): boolean {
  return (
    item.kind === 'notice' &&
    (item.title === 'Pi-Diagnose' || /^\[[^\]]+\] Prozessausgabe$/.test(item.title))
  );
}

export function agentConversations(items: AgentTimelineItem[], agents: SubagentRun[] = []) {
  const choices = new Map<string, { id: string; name: string; status?: SubagentRun['status'] }>();
  for (const agent of agents) choices.set(agent.id, agent);
  for (const item of items) {
    if (isInternalDiagnostic(item)) continue;
    const identity = conversationIdentity(item);
    if (identity && !choices.has(identity.id)) choices.set(identity.id, identity);
  }
  return [...choices.values()];
}

export function conversationItems(
  items: AgentTimelineItem[],
  agentId: string
): AgentTimelineItem[] {
  return items.filter(
    (item) => !isInternalDiagnostic(item) && (conversationIdentity(item)?.id ?? 'main') === agentId
  );
}
