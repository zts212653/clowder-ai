import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { createSuggestionIntegration } from '../dist/domains/suggestions/composition.js';

const USER = 'user-operator';
const THREAD = 'thread_video';
const WATCH = 'thread_watch';
const SOL = { userId: USER, threadId: THREAD, catId: 'codex61-sol', invocationId: 'inv-sol', byline: 'watcher' };
const WORK = { contentRef: 'work:sheet', ownerRevision: 1 };

function card(reference, title = '六猫岛 · 单采肖像参考') {
  return {
    id: `work-reference-${reference.contentRef}`,
    kind: 'card',
    v: 1,
    title,
    bodyMarkdown: '第一版',
    meta: { kind: 'work_reference', reference },
  };
}

describe('F335 交付三 desk delivery', () => {
  let now;
  let messages;
  let published;
  let applied;
  let suggestions;
  let desk;
  let turnMessageId;
  let pendingBlocks;

  const save = (id, threadId, blocks = []) => {
    const message = { id, userId: USER, threadId, extra: { rich: { v: 1, blocks } } };
    messages.set(id, message);
    return message;
  };

  beforeEach(() => {
    now = 1_000_000;
    messages = new Map();
    published = [];
    applied = 0;
    turnMessageId = 'msg-sol-turn';
    pendingBlocks = [];
    let ids = 0;
    suggestions = createSuggestionIntegration({
      messageStore: { getById: (id) => messages.get(id) ?? null },
      // This turn's rich blocks wait in the buffer until the reply is finished (create-rich-block → reply).
      richBlocks: {
        hasPendingBlock: (threadId, catId, invocationIds, match) =>
          pendingBlocks.some(
            (entry) =>
              entry.threadId === threadId &&
              entry.catId === catId &&
              invocationIds.includes(entry.invocationId) &&
              match(entry.block),
          ),
      },
      invocationTracker: { getLifecycleResponseMessageId: () => turnMessageId },
      socketManager: { broadcastToRoom: (_room, _event, data) => published.push(data.suggestion) },
      threadTitle: async (threadId) =>
        ({ [THREAD]: '「视频」自媒体视频运营', [WATCH]: '守望猫' })[threadId] ?? undefined,
      now: () => now,
      newId: () => `sugg_${++ids}`,
    });
    suggestions.registry.register({
      kind: 'video-comments',
      kindLabel: '添加视频批注',
      undoLabel: 'undo',
      prepare: async (_ctx, params) => ({ ok: true, value: params }),
      apply: async () => {
        applied += 1;
        return { ok: true, value: { appliedRef: { ids: ['a'] }, receipt: { text: '已添加 7 条批注' } } };
      },
      undo: async () => ({ ok: true, value: undefined }),
    });
    desk = suggestions.desk;
  });

  const offer = async (messageId, threadId = WATCH) => {
    save(messageId, threadId);
    const result = await suggestions.service.offer(
      { userId: USER, threadId, catId: 'codex61-sol', invocationId: 'inv-w', byline: 'watcher' },
      { messageId, label: '添加 7 条视频批注', action: { kind: 'video-comments', params: { n: 7 } } },
    );
    assert.equal(result.ok, true);
    return result.value;
  };

  it('waits for the reply with the card, then hands the desk one bubble', async () => {
    const woke = [];
    desk.watch(USER, () => woke.push(now));
    const brought = await desk.bring(SOL, { sentence: '鲸鲸那三格，照他的头像画就行。', work: WORK });
    assert.deepEqual(brought, { ok: true, value: { id: 'sugg_1', status: 'waiting_for_card' } });
    assert.equal(await desk.next(USER, { returning: false }), null, 'the reply is not saved yet');

    desk.observeMessage({ userId: USER, threadId: THREAD, blocks: [] });
    assert.equal(woke.length, 1, 'bringing woke the desk once; a message without a work card does not');
    const reply = save(turnMessageId, THREAD, [card(WORK)]);
    desk.observeMessage({ userId: USER, threadId: THREAD, blocks: reply.extra.rich.blocks });
    assert.equal(woke.length, 2);

    const delivery = await desk.next(USER, { returning: false });
    assert.equal(delivery.mode, 'single');
    assert.equal(delivery.more, 0);
    assert.deepEqual(delivery.items, [
      {
        ref: 'sugg_1',
        revision: 0,
        kind: 'work',
        catId: 'codex61-sol',
        byline: 'watcher',
        title: '六猫岛 · 单采肖像参考',
        sentence: '鲸鲸那三格，照他的头像画就行。',
        work: WORK,
        threadId: THREAD,
        threadTitle: '「视频」自媒体视频运营',
        action: 'open',
        createdAt: 1_000_000,
      },
    ]);
    assert.deepEqual(published, [], 'the page never gets a button row for a brought work');
    assert.deepEqual(await suggestions.service.listThread(USER, THREAD), []);
  });

  it('the reply is saved before its card lands: this turn’s pending card waits, nothing else stands in for it', async () => {
    // Real order (11-04 real desktop): the streaming reply is saved first; publish-reference's card sits in this
    // turn's rich-block buffer and lands on that reply when the turn ends.
    save(turnMessageId, THREAD, []);
    pendingBlocks.push({ threadId: THREAD, catId: 'codex61-sol', invocationId: 'inv-sol', block: card(WORK) });
    const brought = await desk.bring(SOL, { sentence: '鲸鲸那三格，照他的头像画就行。', work: WORK });
    assert.deepEqual(brought, { ok: true, value: { id: 'sugg_1', status: 'waiting_for_card' } });
    assert.equal(await desk.next(USER, { returning: false }), null, 'nothing to carry until the card is on the reply');

    const otherVersion = await desk.bring(SOL, { sentence: '看看。', work: { ...WORK, ownerRevision: 2 } });
    assert.equal(otherVersion.code, 'invalid', 'a pending card for another version does not count');
    const otherTurn = await desk.bring({ ...SOL, invocationId: 'inv-later' }, { sentence: '看看。', work: WORK });
    assert.equal(otherTurn.code, 'invalid', 'another turn’s pending card does not count');
    save('msg-old', THREAD, []);
    const explicit = await desk.bring(SOL, { messageId: 'msg-old', sentence: '看看。', work: WORK });
    assert.equal(explicit.code, 'invalid', 'a pending card lands on this turn’s reply, never on an older message');

    pendingBlocks.length = 0;
    save(turnMessageId, THREAD, [card(WORK)]);
    const delivery = await desk.next(USER, { returning: false });
    assert.equal(delivery.mode, 'single');
    assert.equal(delivery.items[0].ref, 'sugg_1');
    assert.equal(delivery.items[0].title, '六猫岛 · 单采肖像参考');
  });

  it('refuses a saved message that does not carry that work version', async () => {
    save('msg-old', THREAD, [card({ ...WORK, ownerRevision: 2 })]);
    const result = await desk.bring(SOL, { messageId: 'msg-old', sentence: '看看这个。', work: WORK });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'invalid');
    const ready = await desk.bring(SOL, {
      messageId: 'msg-old',
      sentence: '看看这个。',
      work: { ...WORK, ownerRevision: 2 },
    });
    assert.deepEqual(ready.value?.status, 'ready');
  });

  it('countdown ran out: the bubble says 已保存到对话, counts 不理, and does not come back', async () => {
    save(turnMessageId, THREAD, [card(WORK)]);
    await desk.bring(SOL, { sentence: '照他的头像画就行。', work: WORK });
    const [item] = (await desk.next(USER, { returning: false })).items;
    const shown = await desk.settle(USER, { action: 'shown', items: [{ ref: item.ref, revision: item.revision }] });
    assert.deepEqual(shown.items, [{ ref: item.ref, revision: 1, outcome: 'settled' }]);
    assert.equal(shown.saved, undefined);

    now += 15_000;
    const timeout = await desk.settle(USER, { action: 'timeout', items: [{ ref: item.ref, revision: 1 }] });
    assert.equal(timeout.saved, true);
    assert.equal(await desk.next(USER, { returning: true }), null);
    const facts = await suggestions.service.facts({ userId: USER, catId: 'codex61-sol' }, { kind: 'brought-work' });
    assert.equal(facts.value.kinds[0].ignored, 1);
    assert.equal(facts.value.kinds[0].offered, 1);
  });

  it('打开 records 用了 and tells the Host where the work is', async () => {
    save(turnMessageId, THREAD, [card(WORK)]);
    await desk.bring(SOL, { sentence: '照他的头像画就行。', work: WORK });
    const settled = await desk.settle(USER, { action: 'open', items: [{ ref: 'sugg_1', revision: 0 }] });
    assert.deepEqual(settled.items, [{ ref: 'sugg_1', revision: 1, outcome: 'settled' }]);
    assert.deepEqual(settled.open, { threadId: THREAD, messageId: turnMessageId, work: WORK });
    const again = await desk.settle(USER, { action: 'open', items: [{ ref: 'sugg_1', revision: 0 }] });
    assert.equal(again.items[0].outcome, 'stale', 'a second click on an old bubble does nothing');
    assert.equal(again.open, undefined);
    const facts = await suggestions.service.facts({ userId: USER, catId: 'codex61-sol' }, { kind: 'brought-work' });
    assert.equal(facts.value.kinds[0].applied, 1);
  });

  it('at the desk only brought works come; back from away the open offers come too, newest first', async () => {
    save('msg-w1', THREAD, [card(WORK)]);
    save('msg-w2', THREAD, [card({ contentRef: 'work:cover', ownerRevision: 3 }, '封面 B')]);
    await desk.bring(SOL, { messageId: 'msg-w1', sentence: '照他的头像画就行。', work: WORK });
    now += 1000;
    await offer('msg-offer');
    now += 1000;
    await desk.bring(SOL, {
      messageId: 'msg-w2',
      sentence: '封面换了一版。',
      work: { contentRef: 'work:cover', ownerRevision: 3 },
    });
    now += 1000;
    // An offer whose reply is not saved yet is not something the person could find again.
    await suggestions.service.offer(
      { userId: USER, threadId: WATCH, catId: 'codex61-sol', invocationId: 'inv-x', byline: 'watcher' },
      { messageId: undefined, label: '创建定时任务', action: { kind: 'video-comments', params: {} } },
    );

    const present = await desk.next(USER, { returning: false });
    assert.equal(present.mode, 'bundle');
    assert.deepEqual(
      present.items.map((item) => item.title),
      ['封面 B', '六猫岛 · 单采肖像参考'],
    );

    const back = await desk.next(USER, { returning: true });
    assert.equal(back.mode, 'bundle');
    assert.deepEqual(
      back.items.map((item) => [item.kind, item.title, item.threadTitle, item.action]),
      [
        ['work', '封面 B', '「视频」自媒体视频运营', 'open'],
        ['suggestion', '添加 7 条视频批注', '守望猫', 'add'],
        ['work', '六猫岛 · 单采肖像参考', '「视频」自媒体视频运营', 'open'],
      ],
    );
  });

  it('添加 in the list is the same apply under the same revision lock; the page row turns into its receipt', async () => {
    const view = await offer('msg-offer');
    const back = await desk.next(USER, { returning: true });
    const [line] = back.items;
    const shown = await desk.settle(USER, { action: 'shown', items: [{ ref: line.ref, revision: line.revision }] });
    const revision = shown.items[0].revision;
    assert.equal(revision, view.revision + 1);

    const wrong = await desk.settle(USER, { action: 'open', items: [{ ref: line.ref, revision }] });
    assert.deepEqual(wrong.items[0], { ref: line.ref, revision, outcome: 'failed', code: 'not_a_work' });

    const stale = await desk.settle(USER, { action: 'add', items: [{ ref: line.ref, revision: view.revision }] });
    assert.equal(stale.items[0].outcome, 'stale');
    assert.equal(applied, 0, 'an old handle never runs the action');

    const added = await desk.settle(USER, { action: 'add', items: [{ ref: line.ref, revision }] });
    assert.equal(added.items[0].outcome, 'settled');
    assert.equal(applied, 1);
    const row = published.at(-1);
    assert.equal(row.id, line.ref);
    assert.equal(row.state, 'applied');
    assert.equal(row.receipt.text, '已添加 7 条批注');
    assert.equal(await desk.next(USER, { returning: true }), null);
  });

  it('忽略 on the list puts every line away as 忽略; the works stay in their conversations', async () => {
    save('msg-w1', THREAD, [card(WORK)]);
    await desk.bring(SOL, { messageId: 'msg-w1', sentence: '照他的头像画就行。', work: WORK });
    await offer('msg-offer');
    const back = await desk.next(USER, { returning: true });
    const settled = await desk.settle(USER, {
      action: 'dismiss',
      items: back.items.map((item) => ({ ref: item.ref, revision: item.revision })),
    });
    assert.deepEqual(
      settled.items.map((item) => item.outcome),
      ['settled', 'settled'],
    );
    assert.equal(await desk.next(USER, { returning: true }), null);
    assert.equal(messages.has('msg-w1'), true);
    const [row] = await suggestions.service.listThread(USER, WATCH);
    assert.equal(row.state, 'dismissed', 'the page shows 已忽略 · 撤销 for the offer');
  });

  it('an offer left unanswered on the desk keeps its pill under the reply and is not carried again', async () => {
    await offer('msg-offer');
    const [line] = (await desk.next(USER, { returning: true })).items;
    const timeout = await desk.settle(USER, { action: 'timeout', items: [{ ref: line.ref, revision: line.revision }] });
    assert.equal(timeout.saved, true);
    const [row] = await suggestions.service.listThread(USER, WATCH);
    assert.equal(row.state, 'open');
    assert.equal(await desk.next(USER, { returning: true }), null);
  });

  it('an offer settled in the page while it was on the desk leaves the desk', async () => {
    const view = await offer('msg-offer');
    const [line] = (await desk.next(USER, { returning: true })).items;
    const shown = await desk.settle(USER, { action: 'shown', items: [{ ref: line.ref, revision: line.revision }] });
    const dismissed = await suggestions.service.dismiss(USER, view.id, shown.items[0].revision);
    assert.equal(dismissed.ok, true);
    assert.equal(await desk.next(USER, { returning: true }), null);
    const add = await desk.settle(USER, {
      action: 'add',
      items: [{ ref: line.ref, revision: shown.items[0].revision }],
    });
    assert.equal(add.items[0].outcome, 'stale');
  });

  it('a stopped kind is not brought, and a brought work cannot be offered as a pill', async () => {
    await suggestions.service.facts({ userId: USER, catId: 'codex61-sol' }, { stopOffering: 'brought-work' });
    const stopped = await desk.bring(SOL, { sentence: '看看。', work: WORK });
    assert.equal(stopped.code, 'kind_stopped');
    save('msg-x', THREAD);
    const pill = await suggestions.service.offer(SOL, {
      messageId: 'msg-x',
      label: '打开',
      action: { kind: 'brought-work', params: {} },
    });
    assert.equal(pill.ok, false);
  });

  it('another person cannot settle this person’s desk', async () => {
    save(turnMessageId, THREAD, [card(WORK)]);
    await desk.bring(SOL, { sentence: '照他的头像画就行。', work: WORK });
    const other = await desk.settle('someone-else', { action: 'open', items: [{ ref: 'sugg_1', revision: 0 }] });
    assert.deepEqual(other.items, [{ ref: 'sugg_1', revision: 0, outcome: 'stale', code: 'not_found' }]);
  });
});
