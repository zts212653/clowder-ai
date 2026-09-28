import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import type { CollectiveParticipant } from '../client-types.js';
import { ParticipantPicker, participantKey, participantRecipient } from '../ParticipantPicker.js';

it('names both endpoint identities and requires a fresh explicit selection after revision or channel changes', () => {
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
  const render = (participants: CollectiveParticipant[], channelId = 'a') =>
    renderToStaticMarkup(
      <ParticipantPicker
        participants={participants}
        channelId={channelId}
        recipient={participantRecipient(member)}
        onChange={() => {}}
      />,
    );
  const names = render([member, other]);
  expect(names).toContain('aaaaaa');
  expect(names).toContain('bbbbbb');
  expect(render([{ ...member, participationRevision: 2 }])).toContain('参与设置已变化，请重新选择');
  expect(render([member], 'b')).toContain('参与设置已变化，请重新选择');
});
