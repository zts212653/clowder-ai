// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mentionSelectionForEvent, participantRecipient } from '../participant-identity.js';
import { TopicPanel } from '../TopicPanel.js';
import { cat, human, reply, thread } from './topic-reply.fixture.js';

let host: HTMLDivElement;
let root: Root;
const send = vi.fn(async (): Promise<void> => undefined);
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  localStorage.clear();
  send.mockClear();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});
async function render(currentThread = thread, participants = [cat], replyRequest?: { eventId: string }) {
  await act(async () =>
    root.render(
      <TopicPanel
        thread={currentThread}
        namespace="exact-topic-reply"
        replyRequest={replyRequest}
        participants={participants}
        humans={[
          { humanId: cat.humanId, displayName: 'Owner' },
          { humanId: 'human_bbbbbbbb', displayName: 'Other Human' },
        ]}
        delivery={{ kind: 'idle' }}
        currentHumanId={cat.humanId}
        humanNames={{ [cat.humanId]: 'Owner' }}
        canSteward
        works={[]}
        allWorks={[]}
        onSend={send}
        onClose={vi.fn()}
        onReturnToSource={vi.fn()}
        onOpenMember={vi.fn()}
        onProposeWork={vi.fn()}
        onCommitWork={vi.fn()}
        onDeclineWork={vi.fn()}
        onAcceptWorkResult={vi.fn()}
        onCompleteWork={vi.fn()}
      />,
    ),
  );
}
async function clickReply(eventId = reply.eventId) {
  const interaction = host.querySelector(`[data-message-interaction-event-id="${eventId}"]`);
  const button = interaction?.querySelector<HTMLButtonElement>('button[aria-label^="回复 "]');
  expect(button).toBeTruthy();
  await act(async () => button?.click());
}
async function type(body: string) {
  await act(async () => {
    const input = host.querySelector('textarea')!;
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, body);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
async function submit() {
  await act(async () => host.querySelector<HTMLButtonElement>('button[type="submit"]')!.click());
}

it('clicking a Cat reply implicitly addresses that Cat and the exact reply, then keeps the next message on that source', async () => {
  await render();
  await clickReply();
  await type('Shorten guide A');
  await submit();
  expect(send).toHaveBeenLastCalledWith('Shorten guide A', {
    location: { channelId: 'general', rootEventId: human.eventId },
    recipient: participantRecipient(cat),
    replyToEventId: reply.eventId,
  });
  await type('Keep the example');
  await submit();
  expect(send).toHaveBeenLastCalledWith('Keep the example', {
    location: { channelId: 'general', rootEventId: human.eventId },
    recipient: participantRecipient(cat),
    replyToEventId: reply.eventId,
  });
});

it('a Channel root reply action also implicitly addresses the Cat author', async () => {
  const catRoot = { ...reply, replyToEventId: undefined, location: { channelId: 'general' } };
  await render({ root: catRoot, replies: [] }, [cat], { eventId: catRoot.eventId });
  await type('Reply through the button');
  await submit();
  expect(send).toHaveBeenLastCalledWith('Reply through the button', {
    location: { channelId: 'general', rootEventId: catRoot.eventId },
    recipient: participantRecipient(cat),
    replyToEventId: catRoot.eventId,
  });
});

it('withdrawing the author blocks sending instead of using the same-name replacement or the previous recipient', async () => {
  const other = { ...cat, catId: 'other-sol', connectionId: 'con_bbbbbbbb', endpointId: 'ep_bbbbbbbb' };
  await render(thread, [other]);
  await type('Existing unsent draft');
  await clickReply();
  expect(host.querySelector('[role="alert"]')?.textContent).toMatch(/未在本频道参与/);
  expect(host.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(true);
  expect(host.querySelector('textarea')?.value).toBe('Existing unsent draft');
  await submit();
  expect(send).not.toHaveBeenCalled();
});

it('a participation revision change cannot refresh the selected authority behind the draft', async () => {
  await render();
  await clickReply();
  await type('Feedback A');
  await render(thread, [{ ...cat, participationRevision: 5 }]);
  expect(host.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(true);
  await submit();
  expect(send).not.toHaveBeenCalled();
});

it('refresh restores the exact nested reply source together with its recipient and draft', async () => {
  await render();
  await clickReply();
  await type('Persisted feedback A');
  await act(async () => root.render(null));
  await render();
  expect(host.querySelector('textarea')?.value).toBe('Persisted feedback A');
  await submit();
  expect(send).toHaveBeenLastCalledWith('Persisted feedback A', {
    location: { channelId: 'general', rootEventId: human.eventId },
    recipient: participantRecipient(cat),
    replyToEventId: reply.eventId,
  });
});

it('a restored draft whose exact reply disappeared cannot silently fall back to the Topic root', async () => {
  await render();
  await clickReply();
  await type('Must keep my source');
  await act(async () => root.render(null));
  await render({ root: human, replies: [] });
  expect(host.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(true);
  expect(host.querySelector('[role="alert"]')?.textContent).toMatch(/回复.*消息.*不可用/);
  await submit();
  expect(send).not.toHaveBeenCalled();
});

it('replying to your own Human message retains Channel routing and the exact reply source', async () => {
  await render();
  await clickReply(human.eventId);
  await type('Human discussion');
  await submit();
  expect(send).toHaveBeenLastCalledWith('Human discussion', {
    location: { channelId: 'general', rootEventId: human.eventId },
    recipient: { kind: 'channel' },
    replyToEventId: human.eventId,
  });
});

it('a new Channel reply action resets the nested reply source without erasing the draft', async () => {
  await render();
  await clickReply();
  await type('Keep this draft');
  await render(thread, [cat], { eventId: human.eventId });
  await submit();
  expect(send).toHaveBeenLastCalledWith('Keep this draft', {
    location: { channelId: 'general', rootEventId: human.eventId },
    recipient: { kind: 'channel' },
    replyToEventId: human.eventId,
  });
});

it('explicitly cancelling the implicit mention permits a Channel reply at the selected message', async () => {
  await render();
  await clickReply();
  await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="取消点名"]')?.click());
  await type('Discuss with everyone');
  expect(host.querySelector('[aria-label="回复来源"]')?.textContent).toContain('Guide A v1');
  await act(async () => root.render(null));
  await render();
  expect(host.querySelector('[aria-label="回复来源"]')?.textContent).toContain('Sol');
  await submit();
  expect(send).toHaveBeenLastCalledWith('Discuss with everyone', {
    location: { channelId: 'general', rootEventId: human.eventId },
    recipient: { kind: 'channel' },
    replyToEventId: reply.eventId,
  });
});

it('replying to another Human addresses that Human rather than the Channel', async () => {
  const other = { ...human, actor: { kind: 'human' as const, humanId: 'human_bbbbbbbb', displayName: 'Other Human' } };
  await render({ root: other, replies: [] }, [cat], { eventId: other.eventId });
  await type('A reply to another person');
  await submit();
  expect(send).toHaveBeenLastCalledWith('A reply to another person', {
    location: { channelId: 'general', rootEventId: other.eventId },
    recipient: { kind: 'human', humanId: 'human_bbbbbbbb' },
    replyToEventId: other.eventId,
  });
});

it.each([
  { ...cat, availability: 'revoked' as const },
  { ...cat, channelIds: ['another-channel'] },
])('refuses a Cat author outside current participation', (participant) => {
  expect(mentionSelectionForEvent(reply, [participant], 'general').selection).toBeUndefined();
});

it('recomputes an unavailable author warning after refresh without acquiring a new authority', async () => {
  await render(thread, [{ ...cat, availability: 'revoked' }]);
  await clickReply();
  await type('Retain my feedback');
  await act(async () => root.render(null));
  await render();
  expect(host.querySelector('[role="alert"]')?.textContent).toMatch(/重新选择/);
  expect(host.querySelector('[role="alert"]')?.textContent).not.toMatch(/未在本频道参与/);
  expect(localStorage.getItem('collective-draft:exact-topic-reply:general:evt_humanaaaa')).not.toContain('replyError');
  await submit();
  expect(send).not.toHaveBeenCalled();
  await clickReply();
  await submit();
  expect(send).toHaveBeenLastCalledWith('Retain my feedback', {
    location: { channelId: 'general', rootEventId: human.eventId },
    recipient: participantRecipient(cat),
    replyToEventId: reply.eventId,
  });
});

it('an older send response cannot undo a newer explicit reply action', async () => {
  let finish: (() => void) | undefined;
  send.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  await render();
  await clickReply();
  await type('First feedback');
  await submit();
  await clickReply(human.eventId);
  await act(async () => finish?.());
  await type('New Human reply');
  await submit();
  expect(send).toHaveBeenLastCalledWith('New Human reply', {
    location: { channelId: 'general', rootEventId: human.eventId },
    recipient: { kind: 'channel' },
    replyToEventId: human.eventId,
  });
});

it.each([
  'serviceInstanceId',
  'collectiveId',
  'connectionId',
  'endpointId',
  'humanId',
  'catId',
] as const)('cannot resolve a same-name reply author through a different %s', (key) => {
  expect(
    mentionSelectionForEvent(reply, [{ ...cat, [key]: 'different-identity' }], 'general').selection,
  ).toBeUndefined();
});

it('fails closed when a stored exact reply has lost its typed recipient', async () => {
  localStorage.setItem(
    'collective-draft:exact-topic-reply:general:evt_humanaaaa',
    JSON.stringify({
      body: 'Keep my feedback',
      replyToEventId: reply.eventId,
      recipient: { kind: 'agent' },
    }),
  );
  await render();
  expect(host.querySelector('[role="alert"]')?.textContent).toMatch(/重新选择/);
  await submit();
  expect(send).not.toHaveBeenCalled();
});
