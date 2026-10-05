import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
import { ChannelMessage } from '../ChannelMessage.js';
import type { CollectiveEventEnvelope, CollectiveParticipant } from '../client-types.js';

const request: CollectiveEventEnvelope = {
  serviceInstanceId: 'svc_12345678',
  collectiveId: 'col_12345678',
  eventId: 'evt_request',
  clientEventId: 'named-request',
  sequence: 1,
  actor: { kind: 'human', humanId: 'human_owner', displayName: 'You' },
  target: { kind: 'agent', humanId: 'human_owner', agentId: 'codex-sol' },
  recipient: {
    kind: 'agent',
    connectionId: 'con_owner',
    humanId: 'human_owner',
    agentId: 'codex-sol',
    participationRevision: 1,
  },
  location: { channelId: 'general' },
  body: '喵！',
  acceptedAt: '2026-09-26T12:24:13.000Z',
};
const participant: CollectiveParticipant = {
  serviceInstanceId: request.serviceInstanceId,
  collectiveId: request.collectiveId,
  connectionId: 'con_owner',
  endpointId: 'end_owner',
  endpointLabel: 'You 的 Café',
  humanId: 'human_owner',
  humanDisplayName: 'You',
  catId: 'codex-sol',
  displayName: '缅因猫（Sol）',
  channelIds: ['general'],
  participationRevision: 1,
  availability: 'declared',
};
const render = (replies: CollectiveEventEnvelope[] = []) =>
  renderToStaticMarkup(
    <ChannelMessage
      thread={{ root: request, replies }}
      participants={[participant]}
      onOpenTopic={vi.fn()}
      onMention={vi.fn()}
      onOpenMember={vi.fn()}
    />,
  );

it('keeps the exact named Cat visible and does not call a Human reply the Cat response', () => {
  expect(render()).toContain('点名 <strong>@缅因猫（Sol）</strong>');
  expect(render()).toContain('尚无公开回复');
  const humanReply: CollectiveEventEnvelope = {
    ...request,
    eventId: 'evt_human_reply',
    sequence: 2,
    recipient: { kind: 'channel' },
    replyToEventId: request.eventId,
  };
  expect(render([humanReply])).toContain('尚无公开回复');
  const catReply: CollectiveEventEnvelope = {
    ...request,
    eventId: 'evt_cat_reply',
    sequence: 3,
    actor: {
      kind: 'agent',
      human: { humanId: 'human_owner', displayName: 'You' },
      agent: { agentId: 'codex-sol', displayName: '缅因猫（Sol）' },
      provenance: {
        connectionId: 'con_owner',
        endpointId: 'end_owner',
        endpointLabel: 'You 的 Café',
        catId: 'codex-sol',
        sessionRef: 'invocation:reply',
      },
    },
    recipient: { kind: 'channel' },
    replyToEventId: request.eventId,
  };
  expect(render([catReply])).toContain('已在原处回复');
});
