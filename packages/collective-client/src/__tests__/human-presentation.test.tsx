import { collectiveEventEnvelopeSchema } from '@cat-cafe/shared';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { ChannelConversationFlow } from '../ChannelConversationFlow.js';
import { ChannelMessage } from '../ChannelMessage.js';
import { eventChannelId } from '../channel-navigation.js';
import type { CollectiveEventEnvelope, CollectiveParticipant } from '../client-types.js';
import { DemoPlayback } from '../first-entry/DemoPlayback.js';
import { authorPresentation, defaultPresentation, isLastOfSelfRun } from '../message-presentation.js';
import { TopicMessage } from '../TopicMessage.js';

/**
 * The current shared-room presentation keeps every person and cat on the left with a visible name and avatar. Authorship
 * still decides run-level time compression, but never removes identity or changes spatial alignment.
 *
 * Identity contract (F290 owner): the viewer is the same-Service `snapshot.me.human.humanId`. A message is yours only if the
 * actor is a human, the viewer is known, and the two humanIds are equal. The sender's name and avatar are the original
 * event's. An unknown viewer is never "self": the message is on the left, named.
 */
const ME = 'human_me';
const OTHER = 'human_other';

const human = (humanId: string, displayName: string) => ({ kind: 'human' as const, humanId, displayName });
const cat = (ownerId: string, name = '缅因猫') => ({
  kind: 'agent' as const,
  human: { humanId: ownerId, displayName: ownerId === ME ? '我' : '她' },
  agent: { agentId: 'codex', displayName: name },
  provenance: {
    connectionId: 'con_1',
    endpointId: 'end_1',
    endpointLabel: '某个 Café',
    catId: 'codex',
    sessionRef: 'x',
  },
});

function event(
  id: string,
  actor: CollectiveEventEnvelope['actor'],
  body: string,
  sequence = 1,
): CollectiveEventEnvelope {
  return {
    serviceInstanceId: 'svc_12345678',
    collectiveId: 'col_12345678',
    eventId: id,
    clientEventId: id,
    sequence,
    actor,
    target: { kind: 'channel', channelId: 'general' },
    location: { channelId: 'general' },
    recipient: { kind: 'channel' },
    body,
    acceptedAt: `2026-10-01T10:0${sequence}:00.000Z`,
  } as CollectiveEventEnvelope;
}

const mine = event('evt_mine', human(ME, '阿宪'), '三版封面，暖一点。');
const theirs = event('evt_theirs', human(OTHER, '阿禾'), '我这边也想看。', 2);
const sameNameOther = event('evt_same_name', human(OTHER, '阿宪'), '我也叫阿宪。', 3);
const myCat = event('evt_my_cat', cat(ME), '好，我先出三版。', 4);

const noop = () => undefined;
const renderMessage = (root: CollectiveEventEnvelope, viewer: string | undefined, extra = {}) =>
  renderToStaticMarkup(
    <ChannelMessage
      thread={{ root, replies: [] }}
      currentHumanId={viewer}
      presentation="v2"
      onOpenTopic={noop}
      onMention={noop}
      onOpenMember={noop}
      {...extra}
    />,
  );

describe('who a message belongs to', () => {
  it('is yours only for a human whose id equals the known viewer', () => {
    expect(authorPresentation(mine, ME)).toBe('self');
    expect(authorPresentation(theirs, ME)).toBe('other-human');
  });

  it('does not take a same-name person for you: identity is the id, never the display name', () => {
    expect(authorPresentation(sameNameOther, ME)).toBe('other-human');
  });

  it('never calls anything yours when the viewer is not known', () => {
    for (const viewer of [undefined, '', '   ']) {
      expect(authorPresentation(mine, viewer)).toBe('other-human');
    }
  });

  it('leaves cats as cats, including your own', () => {
    expect(authorPresentation(myCat, ME)).toBe('agent');
    expect(authorPresentation(event('c', cat(OTHER), 'x'), ME)).toBe('agent');
  });
});

describe('new presentation: your own message stays named on the left', () => {
  const markup = renderMessage(mine, ME);

  it('keeps the avatar and name instead of relying on alignment to imply identity', () => {
    expect(markup).toContain('data-author="self"');
    expect(markup).toContain('avatar-button');
    expect(markup).toMatch(/data-testid="cat-nameplate-name"[^>]*>阿宪<\/span>/);
    expect(markup).toContain('human-nameplate');
    expect(markup).not.toContain('Collective 成员');
  });

  it('keeps the body and what you can do with the message without a private-chat bubble', () => {
    expect(markup).toMatch(/message-body message-markdown[\s\S]*三版封面，暖一点。/);
    expect(markup).not.toContain('message-bubble');
    expect(markup).toContain('data-event-id="evt_mine"');
    expect(markup).toContain('collective-event-evt_mine');
  });

  it('shows its time beside the name, once', () => {
    expect(markup.match(/<time/g)).toHaveLength(1);
    expect(markup).toMatch(/message-meta[\s\S]*<time[^>]*class="message-time"/);
  });

  it('shows no time when it is not the last of its run', () => {
    expect(renderMessage(mine, ME, { showTime: false })).not.toContain('<time');
  });
});

describe('new presentation: another person', () => {
  const markup = renderMessage(theirs, ME);

  it('is on the left with an avatar, name, and time', () => {
    expect(markup).toContain('data-author="other-human"');
    expect(markup).toContain('avatar-button');
    expect(markup).toMatch(/message-meta[\s\S]*cat-nameplate-name[^>]*>阿禾<\/span>/);
    expect(markup).toMatch(/<time[^>]*>/);
  });

  it('is not a bubble: the body sits as text under the plate', () => {
    expect(markup).not.toContain('message-bubble');
    expect(markup).toContain('我这边也想看。');
  });

  it('keeps the sender from the original event when the name is the same as yours', () => {
    const same = renderMessage(sameNameOther, ME);
    expect(same).toContain('data-author="other-human"');
    expect(same).toMatch(/data-testid="cat-nameplate-name"[^>]*>阿宪<\/span>/);
    expect(same).not.toContain('data-author="self"');
  });

  it('is on the left, named, when the viewer is unknown', () => {
    const unknown = renderMessage(mine, undefined);
    expect(unknown).toContain('data-author="other-human"');
    expect(unknown).toMatch(/data-testid="cat-nameplate-name"[^>]*>阿宪<\/span>/);
    expect(unknown).not.toContain('message-bubble');
  });
});

describe('new presentation: cats are untouched', () => {
  it('keeps your own cat as a cat: avatar column, name, origin', () => {
    const markup = renderMessage(myCat, ME);

    expect(markup).toContain('avatar-button');
    expect(markup).toMatch(/data-testid="cat-nameplate-name"[^>]*>缅因猫<\/span>/);
    expect(markup).not.toContain('data-author="self"');
  });
});

describe('reply previews keep the responder visible', () => {
  it('shows the real Cat avatar and name beside each recent reply', () => {
    const avatarDataUrl = 'data:image/webp;base64,AAAA';
    const participant: CollectiveParticipant = {
      serviceInstanceId: 'svc_12345678',
      collectiveId: 'col_12345678',
      connectionId: 'con_1',
      endpointId: 'end_1',
      endpointLabel: '某个 Café',
      humanId: ME,
      humanDisplayName: '我',
      catId: 'codex',
      displayName: '缅因猫',
      avatarDataUrl,
      channelIds: ['general'],
      participationRevision: 1,
      availability: 'declared',
    };
    const markup = renderToStaticMarkup(
      <ChannelMessage
        thread={{ root: theirs, replies: [myCat] }}
        currentHumanId={ME}
        participants={[participant]}
        presentation="v2"
        onOpenTopic={noop}
        onMention={noop}
        onOpenMember={noop}
      />,
    );

    expect(markup).toMatch(/reply-preview-item[\s\S]*<img src="data:image\/webp;base64,AAAA"/);
    expect(markup).toMatch(/reply-preview-item[\s\S]*<b>缅因猫<\/b>/);
  });
});

describe('the classic author-state contract uses the same shared identity plate', () => {
  const classic = (root: CollectiveEventEnvelope, viewer: string | undefined) =>
    renderToStaticMarkup(
      <ChannelMessage
        thread={{ root, replies: [] }}
        currentHumanId={viewer}
        presentation="classic"
        onOpenTopic={noop}
        onMention={noop}
        onOpenMember={noop}
      />,
    );

  it.each([
    ['your own message', mine, ME],
    ['another person', theirs, ME],
    ['an unknown viewer', mine, undefined],
  ] as const)('%s keeps the avatar and name without an internal origin label', (_label, root, viewer) => {
    const markup = classic(root, viewer);

    expect(markup).toContain('avatar-button');
    expect(markup).toContain('class="message-meta"');
    expect(markup).not.toContain('Collective 成员 · 人');
    expect(markup).not.toContain('data-author="self"');
    expect(markup).toContain('human-nameplate');
    expect(markup).not.toContain('message-bubble');
  });
});

describe('the host said nothing: the room is the classic layout', () => {
  it('defaults to classic with no parameter, and for anything that is not v2', () => {
    expect(defaultPresentation('')).toBe('classic');
    expect(defaultPresentation('?viewer=x')).toBe('classic');
    expect(defaultPresentation('?presentation=')).toBe('classic');
    expect(defaultPresentation('?presentation=V3')).toBe('classic');
    expect(defaultPresentation('?presentation=classic')).toBe('classic');
  });

  it('is the new presentation only when the link or acceptance entry asks for it', () => {
    expect(defaultPresentation('?presentation=v2')).toBe('v2');
    expect(defaultPresentation('?viewer=x&presentation=v2')).toBe('v2');
  });

  it('draws your own message, another person and a topic message the way they always were, with no presentation given', () => {
    const channel = (root: CollectiveEventEnvelope) =>
      renderToStaticMarkup(
        <ChannelMessage
          thread={{ root, replies: [] }}
          currentHumanId={ME}
          onOpenTopic={noop}
          onMention={noop}
          onOpenMember={noop}
        />,
      );

    for (const markup of [
      channel(mine),
      channel(theirs),
      renderToStaticMarkup(<TopicMessage event={mine} currentHumanId={ME} />),
    ]) {
      expect(markup).not.toContain('data-author');
      expect(markup).toContain('human-nameplate');
      expect(markup).not.toContain('message-bubble');
    }
    expect(channel(mine)).toContain('avatar-button');
  });
});

describe('early records (legacy history) follow the same run rule', () => {
  // Real legacy records, as the schema decodes them: no location, a human target, so they are not placed in any channel and
  // the flow folds them under 早期记录 (Sol6.1's reproduction of the missing showTime, 2026-10-01).
  // The schema wants a real-looking humanId (14+ characters), which the short ids used elsewhere in this file are not.
  const VIEWER = 'human_12345678';
  const legacyMine = (id: string, minute: string): CollectiveEventEnvelope =>
    collectiveEventEnvelopeSchema.parse({
      serviceInstanceId: 'svc_12345678',
      collectiveId: 'col_12345678',
      eventId: `evt_000000${minute}`,
      clientEventId: id,
      sequence: Number(minute),
      actor: { kind: 'human', humanId: VIEWER, displayName: '阿宪' },
      target: { kind: 'human', humanId: VIEWER },
      body: `visible ${id}`,
      acceptedAt: `2026-10-01T10:${minute}:00.000Z`,
    });
  const early = [legacyMine('a', '01'), legacyMine('b', '02'), legacyMine('c', '03')];
  const renderEarly = (presentation: 'v2' | 'classic', viewer: string) =>
    renderToStaticMarkup(
      <ChannelConversationFlow
        flowRef={{ current: null }}
        threads={[]}
        legacy={early}
        search={false}
        humanName="阿宪"
        channelWorks={[]}
        channelVotes={[]}
        channelReactions={[]}
        humanId={viewer}
        canSteward={false}
        participants={[]}
        humanNames={{}}
        roadmaps={[]}
        presentation={presentation}
        actions={{ openTopic: vi.fn(), mention: vi.fn(), openMember: vi.fn() } as never}
      />,
    );

  it('are really legacy: no channel can be read from them', () => {
    for (const record of early) expect(eventChannelId(record)).toBeUndefined();
  });

  it('give a run of three of your own early records one time, under the last', () => {
    const markup = renderEarly('v2', VIEWER);

    expect(markup.match(/data-author="self"/g)).toHaveLength(3);
    for (const record of early) expect(markup).toContain(record.body);
    expect(markup.match(/class="message-time"/g)).toHaveLength(1);
  });

  it('keep every original time in the classic presentation', () => {
    const markup = renderEarly('classic', VIEWER);

    expect(markup.match(/<time/g)).toHaveLength(3);
    expect(markup).not.toContain('data-author="self"');
  });

  it('keep every time, named and on the left, when the viewer is unknown', () => {
    const markup = renderEarly('v2', '');

    expect(markup.match(/data-author="other-human"/g)).toHaveLength(3);
    expect(markup.match(/<time/g)).toHaveLength(3);
  });
});

describe('topic messages', () => {
  const topic = (root: CollectiveEventEnvelope, viewer: string | undefined, presentation: 'v2' | 'classic' = 'v2') =>
    renderToStaticMarkup(<TopicMessage event={root} currentHumanId={viewer} presentation={presentation} />);

  it('draws your own and another person with the same left-side identity grammar', () => {
    expect(topic(mine, ME)).toContain('data-author="self"');
    expect(topic(mine, ME)).toMatch(/data-testid="cat-nameplate-name"[^>]*>阿宪<\/span>/);
    expect(topic(mine, ME)).toContain('avatar');
    expect(topic(theirs, ME)).toMatch(/data-testid="cat-nameplate-name"[^>]*>阿禾<\/span>/);
    expect(topic(theirs, ME)).toContain('human-nameplate');
  });

  it('draw an unknown viewer on the left, named', () => {
    const markup = topic(mine, undefined);

    expect(markup).toContain('data-author="other-human"');
    expect(markup).toMatch(/data-testid="cat-nameplate-name"[^>]*>阿宪<\/span>/);
  });

  it('keep the classic layout in the classic presentation', () => {
    const markup = topic(mine, ME, 'classic');

    expect(markup).toContain('class="topic-message"');
    expect(markup).toContain('avatar');
    expect(markup).not.toContain('data-author');
  });
});

describe('a run of your own messages shows its time once, under the last one', () => {
  const roots = [
    mine,
    event('evt_mine_2', human(ME, '阿宪'), '再来一版。', 5),
    event('evt_mine_3', human(ME, '阿宪'), '就这版。', 6),
  ];
  const thread = (root: CollectiveEventEnvelope) => ({ root, replies: [] });

  it('is the last of its run only when the next thread is not also yours', () => {
    const threads = roots.map(thread);

    expect(isLastOfSelfRun(threads, 0, ME)).toBe(false);
    expect(isLastOfSelfRun(threads, 1, ME)).toBe(false);
    expect(isLastOfSelfRun(threads, 2, ME)).toBe(true);
  });

  it('ends at someone else, at a cat, and at a new day', () => {
    expect(isLastOfSelfRun([thread(mine), thread(theirs)], 0, ME)).toBe(true);
    expect(isLastOfSelfRun([thread(mine), thread(myCat)], 0, ME)).toBe(true);
    const nextDay = { ...roots[1], acceptedAt: '2026-10-02T10:00:00.000Z' };
    expect(isLastOfSelfRun([thread(mine), thread(nextDay)], 0, ME)).toBe(true);
  });

  it('is always the last when the viewer is unknown, since nothing is yours', () => {
    expect(isLastOfSelfRun(roots.map(thread), 0, undefined)).toBe(true);
  });

  it('puts one time under a run of three in the conversation flow, and none under the first two', () => {
    const markup = renderToStaticMarkup(
      <ChannelConversationFlow
        flowRef={{ current: null }}
        threads={roots.map(thread)}
        legacy={[]}
        search={false}
        humanName="阿宪"
        channelWorks={[]}
        channelVotes={[]}
        channelReactions={[]}
        humanId={ME}
        canSteward={false}
        participants={[]}
        humanNames={{}}
        roadmaps={[]}
        presentation="v2"
        actions={{ openTopic: vi.fn(), mention: vi.fn(), openMember: vi.fn() } as never}
      />,
    );

    expect(markup.match(/data-author="self"/g)).toHaveLength(3);
    expect(markup.match(/class="message-time"/g)).toHaveLength(1);
  });
});

describe('the places that draw an event without the channel flow around it', () => {
  const flow = (legacy: CollectiveEventEnvelope[], humanId: string) =>
    renderToStaticMarkup(
      <ChannelConversationFlow
        flowRef={{ current: null }}
        threads={[]}
        legacy={legacy}
        search={false}
        humanName="阿宪"
        channelWorks={[]}
        channelVotes={[]}
        channelReactions={[]}
        humanId={humanId}
        canSteward={false}
        participants={[]}
        humanNames={{}}
        roadmaps={[]}
        presentation="v2"
        actions={{ openTopic: vi.fn(), mention: vi.fn(), openMember: vi.fn() } as never}
      >
        <i />
      </ChannelConversationFlow>,
    );

  it('draws the early records the same way: yours as the block, another person on the left', () => {
    const markup = flow([mine, theirs], ME);

    expect(markup).toContain('data-author="self"');
    expect(markup).toContain('data-author="other-human"');
  });

  it('draws the early records with the viewer unknown on the left, named', () => {
    const markup = flow([mine], '');

    expect(markup).not.toContain('data-author="self"');
    expect(markup).toMatch(/data-testid="cat-nameplate-name"[^>]*>阿宪<\/span>/);
  });

  it("plays the first-entry demo with the narrator as the viewer: the host's question is yours, the neighbour is another person", () => {
    const narrator: CollectiveParticipant = {
      serviceInstanceId: 'svc_12345678',
      collectiveId: 'col_12345678',
      connectionId: 'con_demo',
      endpointId: 'end_demo',
      endpointLabel: '阿宪的 Café',
      humanId: ME,
      humanDisplayName: '阿宪',
      catId: 'codex',
      displayName: '缅因猫',
      channelIds: ['general'],
      participationRevision: 1,
      availability: 'declared',
    };
    const first = renderToStaticMarkup(
      <DemoPlayback beat={1} narrator={narrator} humanName="阿宪" presentation="v2" />,
    );
    const second = renderToStaticMarkup(
      <DemoPlayback beat={2} narrator={narrator} humanName="阿宪" presentation="v2" />,
    );

    expect(first).toContain('data-author="self"');
    expect(first).toContain('aria-label="查看 阿宪"');
    expect(second).toContain('data-author="other-human"');
    expect(second).toContain('阿禾');
  });
});
