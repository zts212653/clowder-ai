import type { CollectiveEventEnvelope, CollectiveParticipant, CollectiveWorkProjection } from '../client-types.js';

const exampleHuman = { kind: 'human' as const, humanId: 'human_example01', displayName: '阿禾（示例）' };

function sampleEvent(
  narrator: CollectiveParticipant,
  sequence: number,
  actor: CollectiveEventEnvelope['actor'],
  body: string,
  rootEventId?: string,
): CollectiveEventEnvelope {
  return {
    serviceInstanceId: narrator.serviceInstanceId,
    collectiveId: narrator.collectiveId,
    eventId: `evt_guide000${sequence}`,
    clientEventId: `guide-${sequence}`,
    sequence,
    actor,
    target: rootEventId ? { kind: 'message', eventId: rootEventId } : { kind: 'channel', channelId: 'general' },
    location: { channelId: 'general', ...(rootEventId ? { rootEventId } : {}) },
    recipient: { kind: 'channel' },
    ...(rootEventId ? { replyToEventId: rootEventId } : {}),
    body,
    acceptedAt: `2026-09-25T09:00:0${sequence}.000Z`,
  };
}

export function firstEntryDemo(narrator: CollectiveParticipant, humanName: string) {
  const owner = { kind: 'human' as const, humanId: narrator.humanId, displayName: humanName };
  const cat = {
    kind: 'agent' as const,
    human: { humanId: narrator.humanId, displayName: narrator.humanDisplayName },
    agent: { agentId: narrator.catId, displayName: narrator.displayName },
    provenance: {
      connectionId: narrator.connectionId,
      endpointId: narrator.endpointId,
      endpointLabel: narrator.endpointLabel,
      catId: narrator.catId,
      sessionRef: 'guide:local-only',
    },
  };
  const neighborCat = {
    kind: 'agent' as const,
    human: { humanId: exampleHuman.humanId, displayName: exampleHuman.displayName },
    agent: { agentId: 'example-cat', displayName: '邻居家的猫（示例）' },
    provenance: {
      connectionId: 'con_example01',
      endpointId: 'ep_example001',
      endpointLabel: '示例 · 另一家 Café',
      catId: 'example-cat',
      sessionRef: 'guide:local-only',
    },
  };
  const root = sampleEvent(narrator, 1, owner, `@${narrator.displayName} 周五前我们要做哪三件事？`);
  const firstReply = sampleEvent(narrator, 2, cat, '1. 定下设计方向\n2. 验收第一次协作\n3. 开始对外介绍', root.eventId);
  const neighborAsk = sampleEvent(narrator, 3, exampleHuman, '@邻居家的猫 第二条你怎么看？', root.eventId);
  const neighborReply = sampleEvent(
    narrator,
    4,
    neighborCat,
    '第二条得等设计定稿，建议和第三条换个顺序。',
    root.eventId,
  );
  const work: CollectiveWorkProjection = {
    v: 1,
    serviceInstanceId: narrator.serviceInstanceId,
    collectiveId: narrator.collectiveId,
    workId: 'work_guide0001',
    sourceEventId: firstReply.eventId,
    sourceLocation: { channelId: 'general', rootEventId: root.eventId },
    title: '周五前三件事（示例）',
    intendedOutcome: '先定方向，再验收协作，最后对外介绍。',
    proposedBy: {
      kind: 'agent',
      humanId: narrator.humanId,
      humanDisplayName: narrator.humanDisplayName,
      connectionId: narrator.connectionId,
      catId: narrator.catId,
      displayName: narrator.displayName,
    },
    dependencyWorkIds: [],
    lifecycle: 'proposed',
    status: 'proposed',
    revision: 1,
    createdAt: '2026-09-25T09:00:05.000Z',
    updatedAt: '2026-09-25T09:00:05.000Z',
    history: [
      {
        revision: 1,
        action: 'proposed',
        actor: {
          kind: 'agent',
          humanId: narrator.humanId,
          humanDisplayName: narrator.humanDisplayName,
          connectionId: narrator.connectionId,
          catId: narrator.catId,
          displayName: narrator.displayName,
        },
        at: '2026-09-25T09:00:05.000Z',
      },
    ],
  };
  const exampleParticipant: CollectiveParticipant = {
    serviceInstanceId: narrator.serviceInstanceId,
    collectiveId: narrator.collectiveId,
    connectionId: 'con_example01',
    endpointId: 'ep_example001',
    endpointLabel: '示例 · 另一家 Café',
    humanId: exampleHuman.humanId,
    humanDisplayName: exampleHuman.displayName,
    catId: 'example-cat',
    displayName: '邻居家的猫（示例）',
    channelIds: ['general'],
    participationRevision: 1,
    availability: 'declared',
  };
  return { root, firstReply, neighborAsk, neighborReply, work, participants: [narrator, exampleParticipant] };
}
