/**
 * ConciergeReplyValidator tests (F229 KD-17)
 *
 * Scans duty cat reply text for [跳过去 R{n}] and [原地看 R{n}] markers.
 * Looks up HandleMap → validates anchor → returns CardBlock actions to inject.
 * Fail-closed: unknown handle → no action (no error).
 */

import assert from 'node:assert/strict';
import { before, beforeEach, describe, it } from 'node:test';

describe('extractConciergeActions', () => {
  let extractConciergeActions;
  let MemoryConciergeHandleMapStore;

  beforeEach(async () => {
    const validatorMod = await import('../dist/domains/concierge/concierge-reply-validator.js');
    extractConciergeActions = validatorMod.extractConciergeActions;
    const storeMod = await import('../dist/domains/concierge/ConciergeHandleMapStore.js');
    MemoryConciergeHandleMapStore = storeMod.MemoryConciergeHandleMapStore;
  });

  it('extracts teleport action from [跳过去 R1]', async () => {
    const store = new MemoryConciergeHandleMapStore();
    await store.setHandles('thread_c', [
      { label: 'R1', anchor: { threadId: 'thread_abc', messageId: 'msg_123', title: 'F229 讨论', type: 'thread' } },
    ]);

    const actions = await extractConciergeActions('你可以看看 [跳过去 R1] 里的讨论', 'thread_c', store);
    assert.equal(actions.length, 1);
    assert.equal(actions[0].action, 'concierge_teleport');
    assert.equal(actions[0].payload.threadId, 'thread_abc');
    assert.equal(actions[0].payload.messageId, 'msg_123');
    assert.equal(actions[0].label, '跳过去：F229 讨论');
    // Bug2 AC-1: handle+verb for inline marker rendering
    assert.equal(actions[0].handle, 'R1');
    assert.equal(actions[0].verb, '跳过去');
  });

  it('extracts peek action from [原地看 R1]', async () => {
    const store = new MemoryConciergeHandleMapStore();
    await store.setHandles('thread_c', [
      { label: 'R1', anchor: { threadId: 'thread_abc', messageId: 'msg_456', title: '记忆搜索', type: 'thread' } },
    ]);

    const actions = await extractConciergeActions('看看这里 [原地看 R1]', 'thread_c', store);
    assert.equal(actions.length, 1);
    assert.equal(actions[0].action, 'concierge_peek');
    assert.equal(actions[0].payload.threadId, 'thread_abc');
    assert.equal(actions[0].payload.messageId, 'msg_456');
    assert.equal(actions[0].label, '原地看：记忆搜索');
    // Bug2 AC-1: handle+verb for inline marker rendering
    assert.equal(actions[0].handle, 'R1');
    assert.equal(actions[0].verb, '原地看');
  });

  it('extracts both teleport and peek from the same reply', async () => {
    const store = new MemoryConciergeHandleMapStore();
    await store.setHandles('thread_c', [
      { label: 'R1', anchor: { threadId: 't1', messageId: 'm1', title: 'Topic A', type: 'thread' } },
    ]);

    const actions = await extractConciergeActions('你可以 [跳过去 R1] 或者 [原地看 R1]', 'thread_c', store);
    assert.equal(actions.length, 2);
    assert.equal(actions[0].action, 'concierge_teleport');
    assert.equal(actions[1].action, 'concierge_peek');
  });

  it('extracts multiple R-handles from a single reply', async () => {
    const store = new MemoryConciergeHandleMapStore();
    await store.setHandles('thread_c', [
      { label: 'R1', anchor: { threadId: 't1', title: 'Topic A', type: 'thread' } },
      { label: 'R2', anchor: { threadId: 't2', messageId: 'm2', title: 'Topic B', type: 'thread' } },
      { label: 'R3', anchor: { threadId: 't3', messageId: 'm3', title: 'Topic C', type: 'thread' } },
    ]);

    const actions = await extractConciergeActions(
      'R1 讨论了 A [跳过去 R1]，R2 是 B [跳过去 R2]，R3 见 [原地看 R3]',
      'thread_c',
      store,
    );
    assert.equal(actions.length, 3);
    assert.equal(actions[0].payload.threadId, 't1');
    assert.equal(actions[1].payload.threadId, 't2');
    assert.equal(actions[2].payload.threadId, 't3');
  });

  it('fail-closed: unknown R-handle produces no action', async () => {
    const store = new MemoryConciergeHandleMapStore();
    await store.setHandles('thread_c', [{ label: 'R1', anchor: { threadId: 't1', title: 'Known', type: 'thread' } }]);

    const actions = await extractConciergeActions('[跳过去 R99] 不存在的 handle', 'thread_c', store);
    assert.equal(actions.length, 0, 'unknown handle should produce no actions');
  });

  it('no markers → empty actions', async () => {
    const store = new MemoryConciergeHandleMapStore();
    const actions = await extractConciergeActions('纯文本回复，没有任何标记', 'thread_c', store);
    assert.deepStrictEqual(actions, []);
  });

  it('deduplicates: same R-handle + same action type → single action', async () => {
    const store = new MemoryConciergeHandleMapStore();
    await store.setHandles('thread_c', [{ label: 'R1', anchor: { threadId: 't1', title: 'Dup', type: 'thread' } }]);

    const actions = await extractConciergeActions('[跳过去 R1] 再来一次 [跳过去 R1]', 'thread_c', store);
    assert.equal(actions.length, 1, 'duplicate should be deduplicated');
  });

  // P1-3 fix: concierge_peek without messageId → no-op button on frontend (CardBlock.tsx:189 returns early)
  // Fail-closed: skip peek action when anchor has no messageId
  it('skips peek action when anchor has no messageId (fail-closed)', async () => {
    const store = new MemoryConciergeHandleMapStore();
    await store.setHandles('thread_c', [
      { label: 'R1', anchor: { threadId: 't_thread_only', title: 'Thread Level', type: 'thread' } },
    ]);

    // [原地看 R1] on a handle without messageId → should produce 0 actions
    const actions = await extractConciergeActions('[原地看 R1]', 'thread_c', store);
    assert.equal(actions.length, 0, 'peek without messageId must be skipped (fail-closed)');
  });

  // P1-3: mixed markers — teleport works without messageId, peek does NOT
  it('allows teleport but skips peek on same thread-only handle', async () => {
    const store = new MemoryConciergeHandleMapStore();
    await store.setHandles('thread_c', [
      { label: 'R1', anchor: { threadId: 't_thread_only', title: 'Thread Level', type: 'thread' } },
    ]);

    const actions = await extractConciergeActions('[跳过去 R1] 或者 [原地看 R1]', 'thread_c', store);
    assert.equal(actions.length, 1, 'only teleport should survive');
    assert.equal(actions[0].action, 'concierge_teleport');
  });

  // Cloud P1: non-thread anchors (feature/doc) can't be teleported to —
  // frontend only navigates to real threadIds. Fail-closed: skip teleport for non-thread types.
  it('skips teleport for non-thread anchor types (fail-closed)', async () => {
    const store = new MemoryConciergeHandleMapStore();
    await store.setHandles('thread_c', [
      { label: 'R1', anchor: { threadId: 'feature:F229', title: 'F229 前台猫', type: 'feature' } },
      { label: 'R2', anchor: { threadId: 'docs/decisions/ADR-030.md', title: 'ADR-030', type: 'doc' } },
    ]);

    const actions = await extractConciergeActions('[跳过去 R1] 和 [跳过去 R2]', 'thread_c', store);
    assert.equal(actions.length, 0, 'non-thread anchors must not produce teleport actions');
  });

  it('handles anchor without messageId (thread-level teleport)', async () => {
    const store = new MemoryConciergeHandleMapStore();
    await store.setHandles('thread_c', [
      { label: 'R1', anchor: { threadId: 't_no_msg', title: 'Thread Only', type: 'thread' } },
    ]);

    const actions = await extractConciergeActions('[跳过去 R1]', 'thread_c', store);
    assert.equal(actions.length, 1);
    assert.equal(actions[0].payload.threadId, 't_no_msg');
    assert.strictEqual(actions[0].payload.messageId, undefined);
  });
});

// KD-19 (P1-B): AC-A3 robustness must not depend on duty cat marker compliance.
// gemini-class cats ignore [跳过去 Rn] markers → without fallback, no actions → AC-A3 fails.
// buildConciergeActions: marker-first (honor sonnet-class curation), else surface ALL thread handles.
describe('buildConciergeActions (KD-19 fallback)', () => {
  let buildConciergeActions;
  let MemoryConciergeHandleMapStore;

  beforeEach(async () => {
    const mod = await import('../dist/domains/concierge/concierge-reply-validator.js');
    buildConciergeActions = mod.buildConciergeActions;
    const storeMod = await import('../dist/domains/concierge/ConciergeHandleMapStore.js');
    MemoryConciergeHandleMapStore = storeMod.MemoryConciergeHandleMapStore;
  });

  it('honors curated marker actions when duty cat used markers', async () => {
    const store = new MemoryConciergeHandleMapStore();
    await store.setHandles('t', [
      { label: 'R1', anchor: { threadId: 'th1', messageId: 'm1', title: 'A', type: 'thread' } },
      { label: 'R2', anchor: { threadId: 'th2', messageId: 'm2', title: 'B', type: 'thread' } },
    ]);

    const actions = await buildConciergeActions('你可以看 [跳过去 R1]', 't', store);
    // marker present → honor curation (only R1), do NOT dump the full fallback list
    assert.equal(actions.length, 1, 'marker-first: only curated R1');
    assert.equal(actions[0].action, 'concierge_teleport');
    assert.equal(actions[0].payload.threadId, 'th1');
  });

  it('falls back to all thread handles when no markers (gemini non-compliance)', async () => {
    const store = new MemoryConciergeHandleMapStore();
    await store.setHandles('t', [
      { label: 'R1', anchor: { threadId: 'th1', messageId: 'm1', title: 'A', type: 'thread' } },
      { label: 'R2', anchor: { threadId: 'th2', title: 'B', type: 'thread' } },
    ]);

    const actions = await buildConciergeActions('纯文本回复，没有任何标记', 't', store);
    const teleports = actions.filter((a) => a.action === 'concierge_teleport');
    assert.equal(teleports.length, 2, 'fallback surfaces both threads as teleport');
    const peeks = actions.filter((a) => a.action === 'concierge_peek');
    assert.equal(peeks.length, 1, 'only R1 (has messageId) gets peek');
  });

  it('fallback skips non-thread handles (only real threads navigable)', async () => {
    const store = new MemoryConciergeHandleMapStore();
    await store.setHandles('t', [
      { label: 'R1', anchor: { threadId: 'feature:F229', title: 'F', type: 'feature' } },
      { label: 'R2', anchor: { threadId: 'th2', messageId: 'm2', title: 'B', type: 'thread' } },
    ]);

    const actions = await buildConciergeActions('纯文本', 't', store);
    assert.ok(actions.length > 0, 'thread handle still produces actions');
    assert.ok(
      actions.every((a) => a.payload.threadId === 'th2'),
      'feature-type handle must be skipped (not navigable)',
    );
  });

  it('returns empty when HandleMap empty and no markers', async () => {
    const store = new MemoryConciergeHandleMapStore();
    const actions = await buildConciergeActions('纯文本', 't', store);
    assert.deepStrictEqual(actions, []);
  });
});

// ---------------------------------------------------------------------------
// Phase B: extractTriagePlanActions — <!-- triage-plan --> marker parsing
// ---------------------------------------------------------------------------
describe('extractTriagePlanActions (Phase B)', () => {
  let extractTriagePlanActions;
  let extractTriagePlanIdsFromActions;
  let MemoryConciergeHandleMapStore;
  let MemoryConciergeTriagePlanStore;

  beforeEach(async () => {
    const mod = await import('../dist/domains/concierge/concierge-reply-validator.js');
    extractTriagePlanActions = mod.extractTriagePlanActions;
    extractTriagePlanIdsFromActions = mod.extractTriagePlanIdsFromActions;
    const handleMapMod = await import('../dist/domains/concierge/ConciergeHandleMapStore.js');
    MemoryConciergeHandleMapStore = handleMapMod.MemoryConciergeHandleMapStore;
    const storeMod = await import('../dist/domains/concierge/ConciergeTriagePlanStore.js');
    MemoryConciergeTriagePlanStore = storeMod.MemoryConciergeTriagePlanStore;
  });

  function makeDeps(store, participants = ['codex']) {
    return {
      triagePlanStore: store || new MemoryConciergeTriagePlanStore(),
      userId: 'test-user',
      sourceMessageId: 'msg-src-1',
      targetCatsResolverDeps: {
        messageStore: { getByThread: async () => [] },
        threadStore: { getParticipants: async () => participants },
      },
    };
  }

  it('extracts relay triage plan from an R-handle target and resolves targetCats', async () => {
    const triageStore = new MemoryConciergeTriagePlanStore();
    const handleMapStore = new MemoryConciergeHandleMapStore();
    await handleMapStore.setHandles('thread_c', [
      { label: 'R1', anchor: { threadId: 'thread_abc', messageId: 'msg_123', title: '砚砚的 thread', type: 'thread' } },
    ]);
    const text = `好的，我帮你传话：

<!-- triage-plan -->
**意图**: relay
**目标**: R1
**原文**: 帮我问砚砚 bug 修了没
**操作**: 传话给砚砚询问 bug 修复状态
<!-- /triage-plan -->

请确认以上操作。`;

    const actions = await extractTriagePlanActions(text, 'thread_c', handleMapStore, makeDeps(triageStore));
    assert.equal(actions.length, 2); // confirm + cancel
    assert.equal(actions[0].action, 'concierge_triage_confirm');
    assert.equal(actions[0].payload.intent, 'relay');
    assert.equal(actions[0].payload.threadId, 'thread_abc');
    assert.ok(actions[0].payload.planId);
    assert.ok(actions[0].payload.summary);
    assert.equal(actions[1].action, 'concierge_triage_cancel');
    assert.equal(actions[1].payload.planId, actions[0].payload.planId);

    // Verify plan was persisted
    const plan = await triageStore.get(actions[0].payload.planId);
    assert.ok(plan);
    assert.equal(plan.intent, 'relay');
    assert.equal(plan.status, 'proposed');
    assert.equal(plan.originalText, '帮我问砚砚 bug 修了没');
    assert.equal(plan.target.threadId, 'thread_abc');
    assert.equal(plan.target.threadTitle, '砚砚的 thread');
    assert.deepStrictEqual(plan.target.targetCats, ['codex']);
  });

  it('extracts go triage plan from an R-handle target', async () => {
    const triageStore = new MemoryConciergeTriagePlanStore();
    const handleMapStore = new MemoryConciergeHandleMapStore();
    await handleMapStore.setHandles('thread_c', [
      { label: 'R2', anchor: { threadId: 'thread_f229', title: 'F229 讨论 thread', type: 'thread' } },
    ]);
    const text = `<!-- triage-plan -->
**意图**: go
**目标**: R2
**原文**: 带我去看看 F229 的讨论
**操作**: 跳转到 F229 讨论 thread
<!-- /triage-plan -->`;

    const actions = await extractTriagePlanActions(text, 'thread_c', handleMapStore, makeDeps(triageStore));
    assert.equal(actions.length, 2);
    assert.equal(actions[0].payload.intent, 'go');
    assert.equal(actions[0].payload.threadId, 'thread_f229');
    assert.ok(actions[0].label.includes('确认跳转'));
  });

  it('extracts propose_thread triage plan', async () => {
    const store = new MemoryConciergeTriagePlanStore();
    const handleMapStore = new MemoryConciergeHandleMapStore();
    const text = `<!-- triage-plan -->
**意图**: propose_thread
**目标**: Redis 性能调查
**原文**: 帮我开个新 thread 调查 Redis 性能
**操作**: 开新 thread 调查 Redis 性能问题
<!-- /triage-plan -->`;

    const actions = await extractTriagePlanActions(text, 'thread_c', handleMapStore, makeDeps(store));
    assert.equal(actions.length, 2);
    const plan = await store.get(actions[0].payload.planId);
    assert.equal(plan.intent, 'propose_thread');
    assert.equal(plan.target.query, 'Redis 性能调查');
  });

  it('returns empty for text without triage-plan markers', async () => {
    const actions = await extractTriagePlanActions(
      '普通回复文本',
      'thread_c',
      new MemoryConciergeHandleMapStore(),
      makeDeps(),
    );
    assert.deepStrictEqual(actions, []);
  });

  it('returns empty for invalid intent', async () => {
    const text = `<!-- triage-plan -->
**意图**: invalid_thing
**目标**: something
**原文**: test
**操作**: test
<!-- /triage-plan -->`;

    const actions = await extractTriagePlanActions(text, 'thread_c', new MemoryConciergeHandleMapStore(), makeDeps());
    assert.deepStrictEqual(actions, []);
  });

  it('returns empty for missing intent field', async () => {
    const text = `<!-- triage-plan -->
**目标**: something
**原文**: test
<!-- /triage-plan -->`;

    const actions = await extractTriagePlanActions(text, 'thread_c', new MemoryConciergeHandleMapStore(), makeDeps());
    assert.deepStrictEqual(actions, []);
  });

  it('fail-closed: relay/go free-text target does not create a non-dispatchable plan', async () => {
    const triageStore = new MemoryConciergeTriagePlanStore();
    const text = `<!-- triage-plan -->
**意图**: relay
**目标**: 砚砚的 thread
**原文**: 帮我问砚砚
**操作**: 传话
<!-- /triage-plan -->`;

    const actions = await extractTriagePlanActions(
      text,
      'thread_c',
      new MemoryConciergeHandleMapStore(),
      makeDeps(triageStore),
    );
    assert.deepStrictEqual(actions, []);
    assert.deepStrictEqual(await triageStore.listByUser('test-user'), []);
  });

  it('P1: relay target with ambiguous cats creates user-selectable confirm actions', async () => {
    const triageStore = new MemoryConciergeTriagePlanStore();
    const handleMapStore = new MemoryConciergeHandleMapStore();
    await handleMapStore.setHandles('thread_c', [
      { label: 'R1', anchor: { threadId: 'thread_abc', title: '多人 thread', type: 'thread' } },
    ]);
    const text = `<!-- triage-plan -->
**意图**: relay
**目标**: R1
**原文**: 帮我问问
**操作**: 传话
<!-- /triage-plan -->`;

    const actions = await extractTriagePlanActions(
      text,
      'thread_c',
      handleMapStore,
      makeDeps(triageStore, ['codex', 'opus']),
    );
    assert.equal(actions.length, 3); // one confirm per candidate + cancel
    assert.equal(actions[0].action, 'concierge_triage_confirm');
    assert.deepStrictEqual(actions[0].payload.targetCats, ['codex']);
    assert.ok(actions[0].label.includes('@codex'));
    assert.equal(actions[1].action, 'concierge_triage_confirm');
    assert.deepStrictEqual(actions[1].payload.targetCats, ['opus']);
    assert.ok(actions[1].label.includes('@opus'));
    assert.equal(actions[2].action, 'concierge_triage_cancel');

    const plans = await triageStore.listByUser('test-user');
    assert.equal(plans.length, 1);
    assert.equal(plans[0].intent, 'relay');
    assert.deepStrictEqual(plans[0].target.candidateCats, ['codex', 'opus']);
    assert.equal(plans[0].target.targetCats, undefined);
  });

  it('P1: extracts triage plan ids from confirm/cancel actions for assistant-message linking', () => {
    const ids = extractTriagePlanIdsFromActions([
      { action: 'concierge_triage_confirm', label: '确认', payload: { planId: 'plan-1' } },
      { action: 'concierge_triage_cancel', label: '取消', payload: { planId: 'plan-1' } },
      { action: 'concierge_triage_confirm', label: '确认', payload: { planId: 'plan-2' } },
      { action: 'concierge_teleport', label: '跳过去', payload: { threadId: 'thread-1' } },
    ]);

    assert.deepStrictEqual(ids, ['plan-1', 'plan-2']);
  });
});

// ---------------------------------------------------------------------------
// Cloud P2 fix: stripTriagePlanMarkers
// ---------------------------------------------------------------------------
describe('stripTriagePlanMarkers (cloud P2)', () => {
  let stripTriagePlanMarkers;

  before(async () => {
    const mod = await import('../dist/domains/concierge/concierge-reply-validator.js');
    stripTriagePlanMarkers = mod.stripTriagePlanMarkers;
  });

  it('strips triage-plan block and collapses extra newlines', () => {
    const text = `好的，我帮你传话：

<!-- triage-plan -->
**意图**: relay
**目标**: R1
**原文**: 帮我问砚砚 bug 修了没
**操作**: 传话给砚砚询问 bug 修复状态
<!-- /triage-plan -->

请确认以上操作。`;

    const result = stripTriagePlanMarkers(text);
    assert.ok(!result.includes('<!-- triage-plan -->'), 'opening marker should be stripped');
    assert.ok(!result.includes('<!-- /triage-plan -->'), 'closing marker should be stripped');
    assert.ok(!result.includes('**意图**'), 'plan fields should be stripped');
    assert.ok(result.includes('好的，我帮你传话'), 'surrounding text should be preserved');
    assert.ok(result.includes('请确认以上操作'), 'surrounding text should be preserved');
    // No triple+ newlines
    assert.ok(!result.includes('\n\n\n'), 'should not have 3+ consecutive newlines');
  });

  it('returns text unchanged when no markers present', () => {
    const text = '普通回复文本，没有 markers';
    assert.strictEqual(stripTriagePlanMarkers(text), text);
  });

  it('handles markers at the very start/end of text', () => {
    const text = `<!-- triage-plan -->
**意图**: go
**目标**: R2
<!-- /triage-plan -->`;

    const result = stripTriagePlanMarkers(text);
    assert.strictEqual(result, '');
  });
});
