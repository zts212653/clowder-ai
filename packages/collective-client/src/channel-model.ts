import type { ChannelThread, CollectiveEventEnvelope, CollectiveTarget } from './client-types.js';

export function groupChannelThreads(events: readonly CollectiveEventEnvelope[]): readonly ChannelThread[] {
  const byId = new Map(events.map((event) => [event.eventId, event]));
  const replies = new Map<string, CollectiveEventEnvelope[]>();
  const roots: CollectiveEventEnvelope[] = [];
  for (const event of events) {
    let root = event;
    const seen = new Set([event.eventId]);
    let parentId = event.location?.rootEventId ?? event.replyToEventId;
    while (parentId && !seen.has(parentId)) {
      seen.add(parentId);
      const parent = byId.get(parentId);
      if (!parent || (event.location && parent.location?.channelId !== event.location.channelId)) break;
      root = parent;
      parentId = parent.location?.rootEventId ?? parent.replyToEventId;
    }
    if (root === event) {
      roots.push(event);
      continue;
    }
    const group = replies.get(root.eventId) ?? [];
    group.push(event);
    replies.set(root.eventId, group);
  }
  return roots.map((root) => ({ root, replies: replies.get(root.eventId) ?? [] }));
}

export function actorOrigin(event: CollectiveEventEnvelope): string {
  if (event.actor.kind === 'human') return 'Collective 成员 · 人';
  return `${event.actor.human.displayName} · ${event.actor.provenance.endpointLabel ?? '已配对的工作空间'} (${event.actor.provenance.endpointId.slice(-6)}) · 猫`;
}

export function actorId(event: CollectiveEventEnvelope): string {
  return event.actor.kind === 'human'
    ? `human:${event.actor.humanId}`
    : `agent:${event.serviceInstanceId}:${event.actor.provenance.connectionId}:${event.actor.agent.agentId}`;
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
