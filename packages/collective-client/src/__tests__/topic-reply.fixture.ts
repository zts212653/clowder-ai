import type { ChannelThread, CollectiveEventEnvelope, CollectiveParticipant } from '../client-types.js';

export const cat: CollectiveParticipant = {
  serviceInstanceId: 'svc_aaaaaaaa',
  collectiveId: 'col_aaaaaaaa',
  connectionId: 'con_aaaaaaaa',
  endpointId: 'ep_aaaaaaaa',
  endpointLabel: 'Café',
  humanId: 'human_aaaaaaaa',
  humanDisplayName: 'Owner',
  catId: 'codex61-sol',
  displayName: 'Sol',
  participationRevision: 4,
  channelIds: ['general'],
  availability: 'declared',
};
export const human: CollectiveEventEnvelope = {
  serviceInstanceId: cat.serviceInstanceId,
  collectiveId: cat.collectiveId,
  eventId: 'evt_humanaaaa',
  clientEventId: 'human-source',
  sequence: 1,
  actor: { kind: 'human', humanId: cat.humanId, displayName: 'Owner' },
  target: { kind: 'channel', channelId: 'general' },
  location: { channelId: 'general' },
  recipient: { kind: 'channel' },
  body: 'Original request',
  acceptedAt: '2026-10-02T18:00:00Z',
};
export const reply: CollectiveEventEnvelope = {
  ...human,
  eventId: 'evt_catreplya',
  clientEventId: 'cat-result',
  sequence: 2,
  actor: {
    kind: 'agent',
    human: { humanId: cat.humanId, displayName: 'Owner' },
    agent: { agentId: cat.catId, displayName: cat.displayName },
    provenance: {
      connectionId: cat.connectionId,
      endpointId: cat.endpointId,
      catId: cat.catId,
      sessionRef: 'real-cat',
    },
  },
  target: { kind: 'message', eventId: human.eventId },
  location: { channelId: 'general', rootEventId: human.eventId },
  replyToEventId: human.eventId,
  body: 'Guide A v1',
};
export const thread: ChannelThread = { root: human, replies: [reply] };
