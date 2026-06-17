/**
 * F-coalesce: A2A 同一只猫连发两次 at 的去重/合并 bug
 *
 * 现象（co-creator 2026-05-30 报）：cat 在一个 turn 内对同一只猫连发两条
 * post_message / cross_post（都 @ 同一只猫），期望"合并在一起 at 出来"
 * 或"去重，后者才是真实意图"。实际：第一条先被独立执行（可能是错误行动），
 * 第二条之后又独立执行 —— 队友被误导 / 先跑错第一步。
 *
 * 根因：
 *  1. A2A dedup 守卫 hasQueuedAgentForCat 只检查 status==='queued'（故意的，
 *     让 processing 时还能排新 handoff）。
 *  2. 但 A2A entry autoExecute:true → enqueueA2ATargets enqueue 后立即
 *     tryAutoExecute → 第一条几乎瞬间从 queued 变 processing。
 *  3. 第二条到达时第一条已 processing 不是 queued → dedup 失效 → 第二条
 *     照常 enqueue → 两条独立 invocation 串行跑。
 *
 * 对照：用户消息（landy 连发两条）走 collectUserBatch → content 拼接合并。
 * agent A2A 路径完全没有 coalescing。
 *
 * 修复（coalesce-or-supersede）：
 *  - 第一条还 queued（没开跑）→ 合并 content（landy 同款，无竞态，不丢信息）
 *  - 第一条 fresh processing（已开跑）→ abort 正在跑的 + enqueue 第二条
 *    （last-wins，避免重跑已部分执行的第一条；满足"后者才是真实意图"）
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

const QUEUE_PATH = '../dist/domains/cats/services/agents/invocation/InvocationQueue.js';
const TRIGGER_PATH = '../dist/routes/callback-a2a-trigger.js';

function agentEntryInput(overrides = {}) {
  return {
    threadId: 't1',
    userId: 'system',
    content: 'first handoff',
    source: 'agent',
    sourceCategory: 'a2a',
    targetCats: ['antig-opus'],
    intent: 'execute',
    autoExecute: true,
    callerCatId: 'opus',
    ...overrides,
  };
}

describe('InvocationQueue.findInFlightAgentEntry (F-coalesce)', () => {
  test('finds a QUEUED agent entry for the cat', async () => {
    const { InvocationQueue } = await import(QUEUE_PATH);
    const q = new InvocationQueue();
    const r = q.enqueue(agentEntryInput({ content: 'first' }));

    const found = q.findInFlightAgentEntry('t1', 'antig-opus');
    assert.ok(found, 'should find the in-flight agent entry');
    assert.equal(found.id, r.entry.id);
    assert.equal(found.status, 'queued');
    assert.equal(found.content, 'first');
    assert.equal(found.userId, 'system');
  });

  test('finds a FRESH PROCESSING agent entry for the cat', async () => {
    const { InvocationQueue } = await import(QUEUE_PATH);
    const q = new InvocationQueue();
    const r = q.enqueue(agentEntryInput());
    assert.equal(q.markProcessingById('t1', r.entry.id), true);

    const found = q.findInFlightAgentEntry('t1', 'antig-opus');
    assert.ok(found, 'should find the processing agent entry');
    assert.equal(found.status, 'processing');
  });

  test('returns null for a DIFFERENT cat', async () => {
    const { InvocationQueue } = await import(QUEUE_PATH);
    const q = new InvocationQueue();
    q.enqueue(agentEntryInput({ targetCats: ['antig-opus'] }));
    assert.equal(q.findInFlightAgentEntry('t1', 'codex'), null);
  });

  test('returns null for a USER-source entry (only agent entries coalesce)', async () => {
    const { InvocationQueue } = await import(QUEUE_PATH);
    const q = new InvocationQueue();
    q.enqueue(agentEntryInput({ source: 'user', sourceCategory: undefined, targetCats: ['antig-opus'] }));
    assert.equal(q.findInFlightAgentEntry('t1', 'antig-opus'), null);
  });

  // 云端 codex R4 P1: continuation entries are ALSO source:'agent' — must NOT be coalescible,
  // otherwise an A2A handoff would merge into the cat's self-continuation prompt.
  test('returns null for a CONTINUATION agent entry (sourceCategory mismatch)', async () => {
    const { InvocationQueue } = await import(QUEUE_PATH);
    const q = new InvocationQueue();
    q.enqueue(agentEntryInput({ sourceCategory: 'continuation', targetCats: ['antig-opus'] }));
    assert.equal(
      q.findInFlightAgentEntry('t1', 'antig-opus'),
      null,
      'A2A handoff must not coalesce into a self-continuation entry',
    );
  });

  test('picks the a2a entry, NOT a continuation, when both exist for the cat', async () => {
    const { InvocationQueue } = await import(QUEUE_PATH);
    const q = new InvocationQueue();
    q.enqueue(
      agentEntryInput({ sourceCategory: 'continuation', content: 'self-continuation', targetCats: ['antig-opus'] }),
    );
    const a2a = q.enqueue(
      agentEntryInput({ sourceCategory: 'a2a', content: 'real handoff', targetCats: ['antig-opus'] }),
    );
    const found = q.findInFlightAgentEntry('t1', 'antig-opus');
    assert.ok(found, 'should find the a2a entry');
    assert.equal(found.id, a2a.entry.id, 'must return the a2a entry, not the continuation');
    assert.equal(found.content, 'real handoff');
  });

  test('returns null when nothing is in flight', async () => {
    const { InvocationQueue } = await import(QUEUE_PATH);
    const q = new InvocationQueue();
    assert.equal(q.findInFlightAgentEntry('t1', 'antig-opus'), null);
  });
});

describe('InvocationQueue.coalesceContentIntoQueuedAgent (F-coalesce sourceCategory guard)', () => {
  // 云端 codex R4 P1 defense-in-depth: even if a caller passes a non-a2a entryId, coalesce must refuse.
  test('refuses to coalesce into a CONTINUATION entry', async () => {
    const { InvocationQueue } = await import(QUEUE_PATH);
    const q = new InvocationQueue();
    const cont = q.enqueue(
      agentEntryInput({ sourceCategory: 'continuation', content: 'self-work', targetCats: ['antig-opus'] }),
    );
    const ok = q.coalesceContentIntoQueuedAgent('t1', 'system', cont.entry.id, 'handoff content', 'm2');
    assert.equal(ok, false, 'must not splice a handoff into a continuation entry');
    const entry = q.list('t1', 'system').find((e) => e.id === cont.entry.id);
    assert.equal(entry.content, 'self-work', 'continuation content must stay untouched');
  });
});

// F216 c0 (砚砚 GPT-5.5 review P1): findInFlightAgentEntry must scope by callerCatId.
// Without it, cat A's queued handoff to antig-opus gets coalesced/superseded by cat B's later
// same-turn handoff to the same target — cross-caller串味. Only the SAME caller's repeated
// same-turn handoffs are semantically mergeable.
describe('InvocationQueue.findInFlightAgentEntry — caller scope (F216 c0)', () => {
  test('does NOT match an entry from a DIFFERENT caller', async () => {
    const { InvocationQueue } = await import(QUEUE_PATH);
    const q = new InvocationQueue();
    // cat A (opus) enqueued a handoff to antig-opus
    q.enqueue(agentEntryInput({ callerCatId: 'opus', content: 'A says do X', targetCats: ['antig-opus'] }));
    // cat B (gemini) now looks for an in-flight entry to coalesce its OWN handoff into
    const found = q.findInFlightAgentEntry('t1', 'antig-opus', 'gemini');
    assert.equal(found, null, "B's handoff must NOT find A's entry — cross-caller coalesce is串味");
  });

  test('DOES match an entry from the SAME caller (legit same-turn repeat)', async () => {
    const { InvocationQueue } = await import(QUEUE_PATH);
    const q = new InvocationQueue();
    const r = q.enqueue(agentEntryInput({ callerCatId: 'opus', content: 'first', targetCats: ['antig-opus'] }));
    const found = q.findInFlightAgentEntry('t1', 'antig-opus', 'opus');
    assert.ok(found, 'same caller repeated handoff should coalesce');
    assert.equal(found.id, r.entry.id);
  });

  test('does NOT match when entry.callerCatId is undefined (no任意-caller adoption)', async () => {
    const { InvocationQueue } = await import(QUEUE_PATH);
    const q = new InvocationQueue();
    q.enqueue(agentEntryInput({ callerCatId: undefined, content: 'orphan', targetCats: ['antig-opus'] }));
    const found = q.findInFlightAgentEntry('t1', 'antig-opus', 'opus');
    assert.equal(found, null, 'undefined-caller entry must not be adopted by an arbitrary caller');
  });

  test('coalesceContentIntoQueuedAgent refuses cross-caller merge', async () => {
    const { InvocationQueue } = await import(QUEUE_PATH);
    const q = new InvocationQueue();
    const r = q.enqueue(agentEntryInput({ callerCatId: 'opus', content: 'A work', targetCats: ['antig-opus'] }));
    // B tries to merge into A's entry by id — must refuse
    const ok = q.coalesceContentIntoQueuedAgent('t1', 'system', r.entry.id, 'B content', 'm2', 'gemini');
    assert.equal(ok, false, 'cross-caller coalesce must be refused');
    const entry = q.list('t1', 'system').find((e) => e.id === r.entry.id);
    assert.equal(entry.content, 'A work', "A's content must stay untouched by B");
  });
});

describe('InvocationQueue.coalesceContentIntoQueuedAgent (F-coalesce)', () => {
  test('merges new content + messageId into a queued agent entry', async () => {
    const { InvocationQueue } = await import(QUEUE_PATH);
    const q = new InvocationQueue();
    const r = q.enqueue(agentEntryInput({ content: 'do task X', messageId: 'm1' }));

    const ok = q.coalesceContentIntoQueuedAgent(
      't1',
      'system',
      r.entry.id,
      'actually, stop — answer 3 questions',
      'm2',
    );
    assert.equal(ok, true);

    const entry = q.list('t1', 'system').find((e) => e.id === r.entry.id);
    assert.match(entry.content, /do task X/, 'original content retained');
    assert.match(entry.content, /answer 3 questions/, 'new content appended');
    assert.ok(entry.mergedMessageIds.includes('m2'), 'new messageId tracked for delivery');
  });

  test('returns false when the target entry is already processing (cannot merge in-flight)', async () => {
    const { InvocationQueue } = await import(QUEUE_PATH);
    const q = new InvocationQueue();
    const r = q.enqueue(agentEntryInput());
    q.markProcessingById('t1', r.entry.id);

    assert.equal(q.coalesceContentIntoQueuedAgent('t1', 'system', r.entry.id, 'late', 'm2'), false);
  });

  test('returns false for an unknown entry id', async () => {
    const { InvocationQueue } = await import(QUEUE_PATH);
    const q = new InvocationQueue();
    assert.equal(q.coalesceContentIntoQueuedAgent('t1', 'system', 'nope', 'x'), false);
  });
});

describe('enqueueA2ATargets coalesce/supersede (F-coalesce integration)', () => {
  // Helper: build deps with a real InvocationQueue + spy tracker.
  // emitCalls captures socketManager.emitToUser so tests can assert queue_updated emission.
  async function buildDeps(queue, trackerOverrides = {}, emitCalls = [], queueProcessorOverrides = {}) {
    return {
      router: { async *routeExecution() {} },
      invocationRecordStore: { create() {}, update() {} },
      socketManager: {
        broadcastAgentMessage() {},
        broadcastToRoom() {},
        emitToUser(userId, event, data) {
          emitCalls.push({ userId, event, data });
        },
      },
      invocationTracker: {
        has() {
          return false;
        },
        start() {
          return new AbortController();
        },
        startAll() {
          return new AbortController();
        },
        tryStartThreadAll() {
          return new AbortController();
        },
        complete() {},
        completeAll() {},
        ...trackerOverrides,
      },
      queueProcessor: {
        onInvocationComplete() {},
        tryAutoExecute() {
          return Promise.resolve();
        },
        clearPause() {},
        releaseSlot() {},
        ...queueProcessorOverrides,
      },
      invocationQueue: queue,
      log: { info() {}, warn() {}, error() {} },
    };
  }

  test('SECOND handoff merges into a QUEUED first handoff — no duplicate entry', async () => {
    const { enqueueA2ATargets } = await import(TRIGGER_PATH);
    const { InvocationQueue } = await import(QUEUE_PATH);
    const queue = new InvocationQueue();

    // First handoff sits queued (slot busy, not yet auto-executed)
    queue.enqueue(agentEntryInput({ content: 'do task X', messageId: 'm1' }));

    const deps = await buildDeps(queue);
    const result = await enqueueA2ATargets(deps, {
      targetCats: ['antig-opus'],
      content: 'actually, stop — answer 3 questions first',
      userId: 'system',
      threadId: 't1',
      triggerMessage: { id: 'm2', mentions: ['antig-opus'], content: 'test' },
      callerCatId: 'opus',
    });

    // No new entry — merged into the existing queued one
    const entries = queue.list('t1', 'system').filter((e) => e.source === 'agent');
    assert.equal(entries.length, 1, 'must NOT create a duplicate agent entry');
    assert.match(entries[0].content, /do task X/, 'original content kept');
    assert.match(entries[0].content, /answer 3 questions/, 'second handoff merged in');
    // A coalesce is NOT a new route — it must NOT appear in `enqueued` (callbacks.ts derives
    // body.routed from enqueued; reporting it would falsely claim "已路由" for a merge).
    assert.deepEqual(result.enqueued, [], 'merge is not a new route — enqueued stays empty');
    assert.deepEqual(result.coalesced, ['antig-opus'], 'cat handled via coalesce, reported separately');
  });

  // 云端 codex R4 P2: coalesce mutates entry.content, which the web QueueEntryRow renders. The
  // backend MUST emit queue_updated on coalesce too, else the user sees the stale pre-merge handoff.
  test('coalesce emits queue_updated so the frontend re-renders merged content', async () => {
    const { enqueueA2ATargets } = await import(TRIGGER_PATH);
    const { InvocationQueue } = await import(QUEUE_PATH);
    const queue = new InvocationQueue();
    queue.enqueue(agentEntryInput({ content: 'do task X', messageId: 'm1' }));

    const emitCalls = [];
    const deps = await buildDeps(queue, {}, emitCalls);
    await enqueueA2ATargets(deps, {
      targetCats: ['antig-opus'],
      content: 'actually, answer 3 questions first',
      userId: 'system',
      threadId: 't1',
      triggerMessage: { id: 'm2', mentions: ['antig-opus'], content: 'test' },
      callerCatId: 'opus',
    });

    const queueUpdated = emitCalls.filter((c) => c.event === 'queue_updated');
    assert.equal(queueUpdated.length, 1, 'pure coalesce must still emit queue_updated for frontend re-render');
    assert.equal(queueUpdated[0].userId, 'system');
    // F216 AC-D7: action must be 'coalesced' (not 'enqueued') when content was merged into
    // an existing entry without creating a new queue entry — semantically accurate for observability.
    assert.equal(queueUpdated[0].data.action, 'coalesced', 'pure coalesce action must be "coalesced" not "enqueued"');
    // The emitted queue list must carry the merged content (not the stale pre-merge text).
    const mergedEntry = queueUpdated[0].data.queue.find((e) => e.targetCats.includes('antig-opus'));
    assert.ok(mergedEntry, 'merged entry present in emitted queue');
    assert.match(mergedEntry.content, /answer 3 questions/, 'emitted queue carries merged content');
  });

  // F216 c3: when the first handoff is already PROCESSING, the second same-turn handoff from the
  // same caller→target SUPERSEDES it (last-wins): abort the running invocation and restart with the
  // follow-up. The superseded first handoff must NOT continue and must NOT re-run. This reuses the
  // force-send abort-resume coordinate system (cancelInvocation + clearPause + releaseSlot) so we do
  // NOT fork a second abort path that races the QueueProcessor processingSlots mutex (LL-064). The
  // follow-up is enqueued (fall-through) and restarted by tryAutoExecute once the slot frees.
  test('SUPERSEDE: second handoff to a PROCESSING cat aborts the running one and restarts with the follow-up', async () => {
    const { enqueueA2ATargets } = await import(TRIGGER_PATH);
    const { InvocationQueue } = await import(QUEUE_PATH);
    const queue = new InvocationQueue();

    // First handoff is already processing (autoExecute kicked it off)
    const r1 = queue.enqueue(agentEntryInput({ content: 'do task X' }));
    queue.markProcessingById('t1', r1.entry.id);
    const firstEntryId = r1.entry.id;

    // Spy the abort-resume coordinate system — supersede MUST drive all three.
    const controller = new AbortController();
    const cancelCalls = [];
    const clearPauseCalls = [];
    const releaseSlotCalls = [];
    const deps = await buildDeps(
      queue,
      {
        has: () => true,
        getController: () => controller,
        cancelInvocation: (threadId, cats, userId, reason) => {
          cancelCalls.push({ threadId, cats, userId, reason });
          controller.abort(reason);
          return cats; // cancelledCatIds
        },
      },
      [],
      {
        clearPause: (threadId, catId) => clearPauseCalls.push({ threadId, catId }),
        releaseSlot: (threadId, catId) => releaseSlotCalls.push({ threadId, catId }),
      },
    );

    const result = await enqueueA2ATargets(deps, {
      targetCats: ['antig-opus'],
      content: 'STOP — answer 3 questions first',
      userId: 'system',
      threadId: 't1',
      triggerMessage: { id: 'm2', mentions: ['antig-opus'], content: 'test' },
      callerCatId: 'opus',
    });

    // 1. The running handoff is aborted (last-wins).
    assert.equal(controller.signal.aborted, true, 'supersede MUST abort the running handoff');
    // 2. cancelInvocation called once for the target cat with the 'preempted' reason (force-send model).
    assert.equal(cancelCalls.length, 1, 'cancelInvocation called exactly once');
    assert.deepEqual(cancelCalls[0].cats, ['antig-opus']);
    assert.equal(cancelCalls[0].reason, 'preempted');
    // 3. clearPause + releaseSlot called — drop the stale pause and free the mutex so the follow-up restarts.
    assert.equal(clearPauseCalls.length, 1, 'clearPause called to drop the stale pause');
    assert.equal(releaseSlotCalls.length, 1, 'releaseSlot called to free the mutex for restart');
    // 4. The superseded first handoff is removed — it must NOT re-run.
    const firstStillPresent = queue.list('t1', 'system').some((e) => e.id === firstEntryId);
    assert.equal(firstStillPresent, false, 'superseded first handoff removed — must not re-run');
    // 5. The follow-up is enqueued as the only executable next entry.
    const queued = queue.list('t1', 'system').filter((e) => e.source === 'agent' && e.status === 'queued');
    assert.equal(queued.length, 1, 'follow-up enqueued as the next entry');
    assert.match(queued[0].content, /answer 3 questions/, 'follow-up carries the second handoff intent');
    assert.deepEqual(result.enqueued, ['antig-opus']);
  });

  // F216 c3 pre-start window: when markProcessing happened but tracker.startAll hasn't
  // registered yet (the await invocationRecordStore.create() gap), cancelInvocation would return
  // empty. The trigger uses removeProcessed as a TOMBSTONE signal — QueueProcessor.executeEntry
  // checks entry presence after startAll and self-aborts if removed. Trigger must NOT
  // releaseSlot/clearPause (slot freed by executeEntry's .then chain after self-abort).
  test('SUPERSEDE pre-start window: tracker not registered → tombstone removal, no releaseSlot, follow-up queued', async () => {
    const { enqueueA2ATargets } = await import(TRIGGER_PATH);
    const { InvocationQueue } = await import(QUEUE_PATH);
    const queue = new InvocationQueue();

    // First handoff marked processing (by QueueProcessor) but startAll not yet called
    const r1 = queue.enqueue(agentEntryInput({ content: 'do task X' }));
    queue.markProcessingById('t1', r1.entry.id);
    const firstEntryId = r1.entry.id;

    // Tracker has() returns false = pre-start window (startAll not yet reached)
    const controller = new AbortController();
    const cancelCalls = [];
    const releaseSlotCalls = [];
    const deps = await buildDeps(
      queue,
      {
        has: () => false, // <-- pre-start window: tracker not registered
        getController: () => controller,
        cancelInvocation: (threadId, cats, userId, reason) => {
          cancelCalls.push({ threadId, cats, userId, reason });
          return []; // would return empty since not registered
        },
      },
      [],
      {
        clearPause: () => {},
        releaseSlot: (threadId, catId) => releaseSlotCalls.push({ threadId, catId }),
      },
    );

    const result = await enqueueA2ATargets(deps, {
      targetCats: ['antig-opus'],
      content: 'STOP — answer 3 questions first',
      userId: 'system',
      threadId: 't1',
      triggerMessage: { id: 'm2', mentions: ['antig-opus'], content: 'test' },
      callerCatId: 'opus',
    });

    // 1. Controller NOT aborted (cannot abort via tracker — not registered yet)
    assert.equal(controller.signal.aborted, false, 'pre-start window: must NOT abort via tracker');
    // 2. cancelInvocation NOT called (tracker unregistered, would return empty)
    assert.equal(cancelCalls.length, 0, 'cancelInvocation not called in pre-start window');
    // 3. releaseSlot NOT called (slot freed by executeEntry's self-abort → finally → .then chain)
    assert.equal(releaseSlotCalls.length, 0, 'releaseSlot NOT called — executeEntry handles slot release');
    // 4. First entry REMOVED from queue (tombstone signal for QueueProcessor.executeEntry guard —
    //    executeEntry checks entry presence after startAll and self-aborts if removed)
    const firstStillPresent = queue.list('t1', 'system').some((e) => e.id === firstEntryId);
    assert.equal(firstStillPresent, false, 'first entry removed as tombstone — executeEntry will self-abort');
    // 5. Follow-up still enqueued (not lost — will run after onInvocationComplete)
    const queued = queue.list('t1', 'system').filter((e) => e.source === 'agent' && e.status === 'queued');
    assert.equal(queued.length, 1, 'follow-up enqueued for deferred execution');
    assert.match(queued[0].content, /answer 3 questions/, 'follow-up carries second handoff intent');
    assert.deepEqual(result.enqueued, ['antig-opus']);
  });

  test('THIRD same-turn handoff coalesces into the queued follow-up (no unbounded duplicates)', async () => {
    const { enqueueA2ATargets } = await import(TRIGGER_PATH);
    const { InvocationQueue } = await import(QUEUE_PATH);
    const queue = new InvocationQueue();

    // First processing, second enqueued as follow-up (queued)
    const r1 = queue.enqueue(agentEntryInput({ content: 'task A' }));
    queue.markProcessingById('t1', r1.entry.id);
    queue.enqueue(agentEntryInput({ content: 'task B (follow-up)' }));

    const deps = await buildDeps(queue, { has: () => true, getController: () => new AbortController() });

    await enqueueA2ATargets(deps, {
      targetCats: ['antig-opus'],
      content: 'task C (final intent)',
      userId: 'system',
      threadId: 't1',
      triggerMessage: { id: 'm3', mentions: ['antig-opus'], content: 'test' },
      callerCatId: 'opus',
    });

    // Third coalesces into the queued follow-up — still exactly one queued entry, not two
    const queued = queue.list('t1', 'system').filter((e) => e.source === 'agent' && e.status === 'queued');
    assert.equal(queued.length, 1, 'third handoff must merge into the queued follow-up, not add a duplicate');
    assert.match(queued[0].content, /task B/, 'follow-up retains earlier queued content');
    assert.match(queued[0].content, /task C/, 'follow-up gains the final intent');
  });

  test('does NOT coalesce across different cats (only same-cat)', async () => {
    const { enqueueA2ATargets } = await import(TRIGGER_PATH);
    const { InvocationQueue } = await import(QUEUE_PATH);
    const queue = new InvocationQueue();

    // antig-opus has a queued entry; new handoff targets codex → independent, no merge
    queue.enqueue(agentEntryInput({ targetCats: ['antig-opus'], content: 'for antig' }));
    const deps = await buildDeps(queue);

    await enqueueA2ATargets(deps, {
      targetCats: ['codex'],
      content: 'review please',
      userId: 'system',
      threadId: 't1',
      triggerMessage: { id: 'm2', mentions: ['codex'], content: 'test' },
      callerCatId: 'opus',
    });

    const antigEntries = queue.list('t1', 'system').filter((e) => e.targetCats.includes('antig-opus'));
    const codexEntries = queue.list('t1', 'system').filter((e) => e.targetCats.includes('codex'));
    assert.equal(antigEntries.length, 1, 'antig-opus entry untouched');
    assert.ok(!/review please/.test(antigEntries[0].content), 'codex content must NOT leak into antig entry');
    assert.equal(codexEntries.length, 1, 'codex handoff enqueued independently');
  });

  // F216 P1-1 (砚砚 review): the PRODUCTION lookup must be caller-scoped, not just the merge guard.
  // When A and B BOTH have a queued handoff to the same target, B's repeat must coalesce into B's
  // OWN entry. Without callerCatId at the lookup, findInFlightAgentEntry returns A's entry first;
  // the merge guard refuses (cross-caller) and the repeat falls through to a 3rd duplicate entry.
  test('F216 P1-1: B repeat coalesces into B own entry when A and B both queued to same target', async () => {
    const { enqueueA2ATargets } = await import(TRIGGER_PATH);
    const { InvocationQueue } = await import(QUEUE_PATH);
    const queue = new InvocationQueue();

    // A (opus) and B (gemini) BOTH have a queued handoff to antig-opus.
    queue.enqueue(agentEntryInput({ content: 'A: do X', callerCatId: 'opus', messageId: 'mA' }));
    queue.enqueue(agentEntryInput({ content: 'B: do Y', callerCatId: 'gemini', messageId: 'mB' }));

    const deps = await buildDeps(queue);
    const result = await enqueueA2ATargets(deps, {
      targetCats: ['antig-opus'],
      content: 'B: actually do Z',
      userId: 'system',
      threadId: 't1',
      triggerMessage: { id: 'mB2', mentions: ['antig-opus'], content: 'test' },
      callerCatId: 'gemini',
    });

    const entries = queue
      .list('t1', 'system')
      .filter((e) => e.source === 'agent' && e.targetCats.includes('antig-opus'));
    assert.equal(entries.length, 2, "B's repeat must merge into B's own entry, not create a 3rd duplicate");
    const bEntry = entries.find((e) => e.callerCatId === 'gemini');
    assert.ok(bEntry, "B's entry present");
    assert.match(bEntry.content, /do Y/, "B's original content retained");
    assert.match(bEntry.content, /do Z/, "B's repeat merged into B's own entry");
    const aEntry = entries.find((e) => e.callerCatId === 'opus');
    assert.ok(aEntry, "A's entry present");
    assert.match(aEntry.content, /do X/, "A's entry retained");
    assert.ok(!/do Z/.test(aEntry.content), "B's content must NOT leak into A's entry");
    assert.deepEqual(result.coalesced, ['antig-opus'], 'B repeat reported as coalesced, not a new route');
  });
});
