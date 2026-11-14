import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { InMemorySuggestionStore } from '../dist/domains/suggestions/InMemorySuggestionStore.js';
import { STALE_TRANSITION_MS, SuggestionService } from '../dist/domains/suggestions/SuggestionService.js';
import { SuggestionActionRegistry } from '../dist/domains/suggestions/suggestion-actions.js';

const USER = 'user-operator';
const THREAD = 'thread_watch';
const ACTOR = { userId: USER, threadId: THREAD, catId: 'fable-5', invocationId: 'inv-1' };

function fakeHandler(kind, overrides = {}) {
  const calls = { apply: 0, undo: 0, inspect: 0 };
  const handler = {
    kind,
    kindLabel: kind === 'video-comments' ? '添加视频批注' : '创建定时任务',
    undoLabel: 'undo',
    async prepare(_ctx, params) {
      return params.bad ? { ok: false, error: 'bad params' } : { ok: true, value: params };
    },
    async apply(_ctx, params) {
      calls.apply += 1;
      if (params.failApply) return { ok: false, error: 'owner refused' };
      if (params.partialApply) {
        return {
          ok: false,
          error: '只加上了 1 条，其余没加上，也没能撤回',
          partial: { appliedRef: { ids: ['a'] }, receipt: { text: '已添加 1 条批注（其余没加上）' } },
        };
      }
      return {
        ok: true,
        value: {
          appliedRef: { ids: ['a', 'b'] },
          receipt: { text: '已添加 2 条批注', open: { kind: 'workspace-mode', mode: 'schedule' } },
        },
      };
    },
    async undo() {
      calls.undo += 1;
      return { ok: true, value: undefined };
    },
    async inspect() {
      calls.inspect += 1;
      return overrides.inspection ?? 'intact';
    },
    async verifyReceipt(_ctx, ref) {
      return ref.mine === true;
    },
    ...overrides.handler,
  };
  return { handler, calls };
}

describe('F335 SuggestionService', () => {
  let now;
  let store;
  let registry;
  let video;
  let schedule;
  let published;
  let messages;
  let service;
  let ids;

  beforeEach(() => {
    now = 1_000_000;
    ids = 0;
    store = new InMemorySuggestionStore();
    registry = new SuggestionActionRegistry();
    video = fakeHandler('video-comments');
    schedule = fakeHandler('scheduled-task');
    registry.register(video.handler);
    registry.register(schedule.handler);
    published = [];
    messages = new Map([
      ['msg-fable-282', { userId: USER, threadId: THREAD }],
      ['msg-operator', { userId: USER, threadId: THREAD }],
      ['msg-other-thread', { userId: USER, threadId: 'thread_other' }],
    ]);
    service = new SuggestionService({
      store,
      registry,
      loadMessage: async (id) => messages.get(id) ?? null,
      resolveTurnMessageId: (actor) => (actor.invocationId === 'inv-1' ? 'msg-turn-1' : undefined),
      publish: (threadId, view) => published.push({ threadId, view }),
      now: () => now,
      newId: () => `sugg-${++ids}`,
    });
  });

  const offer = (input = {}) =>
    service.offer(ACTOR, {
      label: '添加 7 条视频批注',
      action: { kind: 'video-comments', params: { comments: 7 } },
      ...input,
    });

  it('hangs under this turn’s reply by default and under a named message in the same conversation', async () => {
    const own = await offer();
    assert.equal(own.ok, true);
    assert.equal(own.value.messageId, 'msg-turn-1');
    assert.equal(own.value.state, 'open');
    assert.equal(own.value.kindLabel, '添加视频批注');

    const named = await offer({ messageId: 'msg-fable-282' });
    assert.equal(named.ok, true);
    assert.equal(named.value.messageId, 'msg-fable-282');

    const elsewhere = await offer({ messageId: 'msg-other-thread' });
    assert.deepEqual([elsewhere.ok, elsewhere.code], [false, 'message_not_found']);
    assert.equal(published.length, 2, 'every created row is pushed to the open page');
  });

  it('keeps one row per message', async () => {
    assert.equal((await offer({ messageId: 'msg-fable-282' })).ok, true);
    const second = await service.postReceipt(ACTOR, { messageId: 'msg-fable-282', text: '已向宪宪补了一条先例' });
    assert.deepEqual([second.ok, second.code], [false, 'message_taken']);
  });

  it('rejects unknown kinds and params the action cannot run, before the person sees a pill', async () => {
    const unknown = await offer({ action: { kind: 'buy-coffee', params: {} } });
    assert.deepEqual([unknown.ok, unknown.code], [false, 'unknown_kind']);
    const bad = await offer({ action: { kind: 'video-comments', params: { bad: true } } });
    assert.deepEqual([bad.ok, bad.code], [false, 'invalid']);
  });

  it('runs the action once for a double click and turns the pill into an undoable receipt', async () => {
    const offered = await offer();
    const [first, second] = await Promise.all([
      service.apply(USER, offered.value.id, offered.value.revision),
      service.apply(USER, offered.value.id, offered.value.revision),
    ]);
    assert.equal(video.calls.apply, 1);
    const applied = first.ok ? first : second;
    const refused = first.ok ? second : first;
    assert.equal(applied.value.state, 'applied');
    assert.deepEqual(applied.value.receipt, {
      text: '已添加 2 条批注',
      open: { kind: 'workspace-mode', mode: 'schedule' },
    });
    assert.equal(applied.value.undo, 'undo');
    assert.equal(refused.code, 'conflict');
  });

  it('puts the pill back when the action fails', async () => {
    const offered = await offer({ action: { kind: 'video-comments', params: { failApply: true } } });
    const result = await service.apply(USER, offered.value.id, offered.value.revision);
    assert.deepEqual([result.ok, result.code, result.error], [false, 'action_failed', 'owner refused']);
    const [row] = await service.listThread(USER, THREAD);
    assert.equal(row.state, 'open');
  });

  it('undoes an applied suggestion back to the pill, and a dismissal back to the pill', async () => {
    const offered = await offer();
    const applied = await service.apply(USER, offered.value.id, offered.value.revision);
    const undone = await service.undo(USER, applied.value.id, applied.value.revision);
    assert.equal(video.calls.undo, 1);
    assert.equal(undone.value.state, 'open');
    assert.equal(undone.value.receipt, undefined);

    const dismissed = await service.dismiss(USER, undone.value.id, undone.value.revision);
    assert.equal(dismissed.value.state, 'dismissed');
    const restored = await service.undo(USER, dismissed.value.id, dismissed.value.revision);
    assert.equal(restored.value.state, 'open');
    assert.equal(video.calls.undo, 1, 'bringing back a dismissed pill runs no action');
  });

  it('refuses another person’s row and a stale revision', async () => {
    const offered = await offer();
    assert.equal((await service.apply('someone-else', offered.value.id, 0)).code, 'not_found');
    assert.equal((await service.apply(USER, offered.value.id, 7)).code, 'conflict');
  });

  it('lets an unanswered suggestion expire as “不理” and leaves the page', async () => {
    await offer({ expiresInMinutes: 30 });
    now += 31 * 60_000;
    assert.deepEqual(await service.listThread(USER, THREAD), []);
    const facts = await service.facts(ACTOR, { kind: 'video-comments' });
    assert.equal(facts.value.kinds[0].ignored, 1);
    assert.equal(facts.value.kinds[0].open, 0);
  });

  it('reports per-kind facts, including 改了 read back from what was applied', async () => {
    const editing = fakeHandler('video-comments', { inspection: 'gone' });
    registry = new SuggestionActionRegistry();
    registry.register(editing.handler);
    registry.register(schedule.handler);
    service = new SuggestionService({
      store,
      registry,
      loadMessage: async (id) => messages.get(id) ?? null,
      resolveTurnMessageId: () => undefined,
      now: () => now,
      newId: () => `sugg-${++ids}`,
    });
    const a = await offer({ messageId: 'msg-fable-282' });
    await service.apply(USER, a.value.id, a.value.revision);
    const b = await offer({ messageId: 'msg-operator' });
    await service.dismiss(USER, b.value.id, b.value.revision);

    const facts = await service.facts(ACTOR, {});
    const video = facts.value.kinds.find((kind) => kind.kind === 'video-comments');
    assert.deepEqual(
      [video.offered, video.applied, video.edited, video.dismissed, video.ignored, video.open],
      [2, 1, 1, 1, 0, 0],
    );
    assert.equal(video.recent.length, 2);
    const scheduled = facts.value.kinds.find((kind) => kind.kind === 'scheduled-task');
    assert.equal(scheduled.offered, 0, 'kinds never offered still show, with zeros');
    const again = await service.facts(ACTOR, { kind: 'video-comments' });
    assert.equal(again.value.kinds[0].edited, 1, '改了 is recorded once, not on every read');
  });

  it('lets a cat stop offering a kind and the person restore it', async () => {
    const stopped = await service.facts(ACTOR, { stopOffering: 'video-comments' });
    assert.equal(stopped.value.stopped, 'video-comments');
    assert.ok(stopped.value.kinds.find((kind) => kind.kind === 'video-comments').stoppedAt);
    assert.equal((await offer()).code, 'kind_stopped');
    const hidden = await service.listHidden(USER);
    assert.deepEqual(
      hidden.map((row) => [row.catId, row.kind, row.kindLabel]),
      [['fable-5', 'video-comments', '添加视频批注']],
    );
    assert.equal(await service.restoreKind(USER, 'fable-5', 'video-comments'), true);
    assert.equal((await offer()).ok, true);
  });

  it('only lets a cat attach undo to a receipt that points at its own work', async () => {
    const forged = await service.postReceipt(ACTOR, {
      messageId: 'msg-operator',
      text: '已创建定时任务',
      action: { kind: 'scheduled-task', appliedRef: { taskId: 'someone-elses' } },
    });
    assert.deepEqual([forged.ok, forged.code], [false, 'invalid']);
    const receipt = await service.postReceipt(ACTOR, {
      messageId: 'msg-operator',
      text: '已创建定时任务',
      action: { kind: 'scheduled-task', appliedRef: { mine: true } },
    });
    assert.equal(receipt.value.state, 'applied');
    assert.equal(receipt.value.receiptOnly, true);
    const undone = await service.undo(USER, receipt.value.id, receipt.value.revision);
    assert.equal(undone.value.state, 'undone', 'an undone receipt does not turn into a pill');

    const plain = await service.recordReceipt({
      actor: ACTOR,
      messageId: 'msg-fable-282',
      text: '已向宪宪补了一条先例',
    });
    assert.equal(plain.value.undo, null);
  });

  it('frees a row whose click never settled, so the person can tap again', async () => {
    const offered = await offer();
    const stored = await store.get(offered.value.id);
    await store.swap({ ...stored, state: 'applying', revision: 1, updatedAt: now }, 0);
    assert.equal((await service.listThread(USER, THREAD))[0].state, 'applying');
    now += STALE_TRANSITION_MS + 1;
    const [row] = await service.listThread(USER, THREAD);
    assert.equal(row.state, 'open');
    const applied = await service.apply(USER, row.id, row.revision);
    assert.equal(applied.value.state, 'applied');
  });
  it('keeps a part that could not be taken back as an honest, undoable receipt', async () => {
    const offered = await offer({ action: { kind: 'video-comments', params: { partialApply: true } } });
    const result = await service.apply(USER, offered.value.id, offered.value.revision);
    assert.deepEqual([result.ok, result.code], [false, 'action_partial']);
    assert.equal(result.view.state, 'applied');
    assert.equal(result.view.receipt.text, '已添加 1 条批注（其余没加上）');
    assert.equal(published.at(-1).view.state, 'applied', 'the open page learns what actually happened');
    const undone = await service.undo(USER, result.view.id, result.view.revision);
    assert.equal(undone.value.state, 'open');
  });

  it('pushes an expiry to open pages when it is settled', async () => {
    await offer({ expiresInMinutes: 30 });
    published.length = 0;
    now += 31 * 60_000;
    await service.listThread(USER, THREAD);
    assert.deepEqual(
      published.map((entry) => entry.view.state),
      ['ignored'],
    );
  });

  it('counts every offer of a kind, not just the most recent ones', async () => {
    for (let index = 0; index < 201; index += 1) {
      messages.set(`msg-${index}`, { userId: USER, threadId: THREAD });
      assert.equal((await offer({ messageId: `msg-${index}` })).ok, true);
    }
    const first = (await store.listUserKind(USER, 'video-comments', 500)).at(-1);
    await service.dismiss(USER, first.id, first.revision);
    const facts = await service.facts(ACTOR, { kind: 'video-comments' });
    const [video] = facts.value.kinds;
    assert.deepEqual([video.offered, video.dismissed, video.open], [201, 1, 200]);
    assert.equal(video.recent.length, 5);
  });
});
