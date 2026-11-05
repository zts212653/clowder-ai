import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { ChannelMessage } from '../ChannelMessage.js';
import { cat, human, reply } from './topic-reply.fixture.js';

const render = (root = reply, replies = [reply]) =>
  renderToStaticMarkup(
    <ChannelMessage
      thread={{ root, replies }}
      currentHumanId={cat.humanId}
      participants={[cat]}
      presentation="v2"
      onOpenTopic={() => undefined}
      onMention={() => undefined}
      onOpenMember={() => undefined}
    />,
  );

it('uses the home nameplate for a real cat reply and omits internal origin labels', () => {
  const html = render(reply, []);
  expect(html).toContain('data-testid="cat-nameplate"');
  expect(html).not.toContain('Collective 成员');
});

it('only acknowledges a reply from the exact requested cat and connection', () => {
  const request = {
    ...human,
    recipient: {
      kind: 'agent' as const,
      humanId: cat.humanId,
      agentId: cat.catId,
      connectionId: cat.connectionId,
      participationRevision: cat.participationRevision,
    },
  };
  expect(render(request, [reply])).toContain('已回复');
  const unrelated = {
    ...reply,
    actor: { ...reply.actor, kind: 'human' as const, humanId: cat.humanId, displayName: 'Owner' },
  };
  expect(render(request, [unrelated])).not.toContain('已回复');
  expect(render(request, [unrelated])).toContain('回应状态待确认');
});

it('distinguishes identical public names and cat handles across connections without changing identity', async () => {
  const { participantLabel } = await import('../participant-label.js');
  const other = {
    ...cat,
    connectionId: 'other-connection',
    endpointId: 'other-endpoint',
    endpointLabel: cat.endpointLabel,
  };
  const roster = [cat, other];
  expect(participantLabel(cat, roster)).not.toBe(participantLabel(other, roster));
  expect(cat.connectionId).not.toBe(other.connectionId);
});

it('shows another Café’s actual public progress for me, with no stop control or unrelated Work', async () => {
  const { PublicChannelActivity } = await import('../PublicChannelActivity.js');
  const { work, participant } = await import('./collaboration-cards.fixture.js');
  const active = {
    ...work,
    status: 'in_progress' as const,
    lifecycle: 'in_progress' as const,
    accountableHumanId: 'another-owner',
    assignment: {
      humanId: participant.humanId,
      connectionId: participant.connectionId,
      catId: participant.catId,
      displayName: participant.displayName,
      participationRevision: 1,
      assignedAt: work.createdAt,
    },
  };
  const html = renderToStaticMarkup(
    <PublicChannelActivity
      works={[
        active,
        {
          ...active,
          workId: 'unrelated',
          title: 'PRIVATE_OTHER_WORK',
          sourceEventId: 'unrelated-source',
          accountableHumanId: 'other',
        },
      ]}
      humanId="me"
      requestedEventIds={new Set([active.sourceEventId])}
      participants={[participant]}
      hostAvailable
      onOpen={() => undefined}
    />,
  );
  expect(html).toContain(active.title);
  expect(html).not.toContain('PRIVATE_OTHER_WORK');
  expect(html).not.toContain('停止');
});
