import { describe, expect, it } from 'vitest';

import { actorOrigin, actorTarget, groupChannelThreads } from '../channel-model.js';
import type { CollectiveEventEnvelope } from '../client-types.js';

const base = {
  serviceInstanceId: 'svc_12345678',
  collectiveId: 'col_12345678',
  clientEventId: 'client-1',
  target: { kind: 'channel', channelId: 'general' } as const,
  body: 'message',
  acceptedAt: '2026-08-29T00:00:00.000Z',
};

function humanEvent(sequence: number, replyToEventId?: string): CollectiveEventEnvelope {
  return {
    ...base,
    eventId: `evt_${String(sequence).padStart(8, '0')}`,
    sequence,
    actor: { kind: 'human', humanId: 'human_12345678', displayName: 'You' },
    ...(replyToEventId ? { replyToEventId } : {}),
  };
}

describe('canonical Channel projection', () => {
  it('keeps replies in the root Topic instead of flattening them into the Channel', () => {
    const root = humanEvent(1);
    const reply = humanEvent(2, root.eventId);
    expect(groupChannelThreads([root, reply])).toEqual([{ root, replies: [reply] }]);
  });

  it('shows resident identity language rather than protocol actor enums', () => {
    expect(actorOrigin(humanEvent(1))).toBe('Collective 成员 · 人');
    expect(
      actorOrigin({
        ...humanEvent(2),
        actor: {
          kind: 'agent',
          human: { humanId: 'human_12345678', displayName: 'You' },
          agent: { agentId: 'opus', displayName: 'Opus' },
          provenance: {
            connectionId: 'con_12345678',
            endpointId: 'ep_12345678',
            endpointLabel: 'You 的工作空间',
            catId: 'opus',
            sessionRef: 'invocation:123',
          },
        },
      }),
    ).toBe('You 的工作空间 · Agent');
  });

  it('mentions an Agent under the exact Human identity that authorizes it', () => {
    const event: CollectiveEventEnvelope = {
      ...humanEvent(2),
      actor: {
        kind: 'agent',
        human: { humanId: 'human_12345678', displayName: 'You' },
        agent: { agentId: 'opus', displayName: 'Opus' },
        provenance: {
          connectionId: 'con_12345678',
          endpointId: 'ep_12345678',
          catId: 'opus',
          sessionRef: 'invocation:123',
        },
      },
    };
    expect(actorTarget(event)).toEqual({ kind: 'agent', humanId: 'human_12345678', agentId: 'opus' });
  });
});
