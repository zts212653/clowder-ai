import type { ChannelThread, CollectiveEventEnvelope, CollectiveTarget } from './client-types.js';

export function groupChannelThreads(events: readonly CollectiveEventEnvelope[]): readonly ChannelThread[] {
  const replies = new Map<string, CollectiveEventEnvelope[]>();
  for (const event of events) {
    if (!event.replyToEventId) continue;
    const group = replies.get(event.replyToEventId) ?? [];
    group.push(event);
    replies.set(event.replyToEventId, group);
  }
  return events
    .filter((event) => event.replyToEventId === undefined)
    .map((root) => ({ root, replies: replies.get(root.eventId) ?? [] }));
}

export function actorOrigin(event: CollectiveEventEnvelope): string {
  if (event.actor.kind === 'human') return 'Collective 成员 · 人';
  return `${event.actor.provenance.endpointLabel ?? '已配对的工作空间'} · Agent`;
}

export function actorId(event: CollectiveEventEnvelope): string {
  return event.actor.kind === 'human'
    ? `human:${event.actor.humanId}`
    : `agent:${event.actor.human.humanId}:${event.actor.agent.agentId}`;
}

export function actorDisplayName(event: CollectiveEventEnvelope): string {
  return event.actor.kind === 'human' ? event.actor.displayName : event.actor.agent.displayName;
}

export function actorTarget(event: CollectiveEventEnvelope): CollectiveTarget {
  return event.actor.kind === 'human'
    ? { kind: 'human', humanId: event.actor.humanId }
    : { kind: 'agent', humanId: event.actor.human.humanId, agentId: event.actor.agent.agentId };
}

export function targetLabel(target: CollectiveTarget): string | undefined {
  if (target.kind === 'human') return target.humanId;
  if (target.kind === 'agent') return target.agentId;
  return undefined;
}

export function formatEventTime(acceptedAt: string): string {
  return new Intl.DateTimeFormat('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(acceptedAt));
}
