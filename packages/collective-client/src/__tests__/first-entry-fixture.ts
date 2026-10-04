import type { ClientSnapshot, CollectiveParticipant } from '../client-types.js';

export const participant: CollectiveParticipant = {
  serviceInstanceId: 'svc_12345678',
  collectiveId: 'col_12345678',
  connectionId: 'con_12345678',
  endpointId: 'ep_12345678',
  endpointLabel: 'You’s Café',
  humanId: 'human_12345678',
  humanDisplayName: 'You',
  catId: 'cat_12345678',
  displayName: '缅因猫（砚砚）',
  avatarDataUrl: 'data:image/webp;base64,UklGRg==',
  description: '一起写代码',
  channelIds: ['general'],
  participationRevision: 1,
  availability: 'declared',
};

export const snapshot: ClientSnapshot = {
  phase: 'ready',
  meta: {
    serviceInstanceId: participant.serviceInstanceId,
    bootstrapNeeded: false,
    onboardingComplete: true,
    clientBuildId: 'test',
  },
  me: {
    human: { humanId: participant.humanId, displayName: 'You', createdAt: '2026-09-25T00:00:00.000Z' },
    auth: { provider: 'github', handle: 'operator' },
    collectives: [],
  },
  collective: {
    collectiveId: participant.collectiveId,
    name: 'Alpha',
    createdByHumanId: participant.humanId,
    createdAt: '2026-09-25T00:00:00.000Z',
    role: 'steward',
  },
  providers: [],
  events: [],
  participants: [participant],
  members: {
    humans: [],
    cafes: [
      {
        connectionId: participant.connectionId,
        humanId: participant.humanId,
        endpointId: participant.endpointId,
        endpointLabel: participant.endpointLabel,
      },
    ],
  },
  connection: 'online',
  delivery: { kind: 'idle' },
};
