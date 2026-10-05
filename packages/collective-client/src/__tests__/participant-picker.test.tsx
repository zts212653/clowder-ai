import { expect, it } from 'vitest';
import type { CollectiveParticipant } from '../client-types.js';
import { participantKey, participantRecipient } from '../participant-identity.js';

it('keeps identically named cats in separate Cafés as distinct recipient identities', () => {
  const member: CollectiveParticipant = {
    serviceInstanceId: 'svc_aaaaaaaa',
    collectiveId: 'col_aaaaaaaa',
    connectionId: 'con_aaaaaaaa',
    endpointId: 'ep_aaaaaaaa',
    endpointLabel: 'Same Café',
    humanId: 'human_aaaaaaaa',
    humanDisplayName: 'Owner',
    catId: 'codex-sol',
    displayName: 'Same Cat',
    participationRevision: 1,
    channelIds: ['a'],
    availability: 'declared',
  };
  const other = { ...member, connectionId: 'con_bbbbbbbb', endpointId: 'ep_bbbbbbbb' };
  expect(participantKey(member)).not.toBe(participantKey(other));
  expect(participantRecipient(member)).toMatchObject({ connectionId: 'con_aaaaaaaa', participationRevision: 1 });
  expect(participantRecipient(other)).toMatchObject({ connectionId: 'con_bbbbbbbb', participationRevision: 1 });
});
