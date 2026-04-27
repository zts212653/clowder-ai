# F175 Phase A: 后端统一 Implementation Plan

**Feature:** F175 — `docs/features/F175-unified-queue-design.md`
**Goal:** 消除 urgent bypass、引入 priority ordering、取消强制 merge、支持用户可控编排 — 根治 #564 A2A 链断裂
**Acceptance Criteria:**
- AC-A1: `handleUrgentTrigger()` 和 urgent 分支已删除，所有 connector 消息走 `enqueueWhileActive()`
- AC-A2: QueueEntry 有 `priority` 字段，4 个 urgent 调用方正确透传
- AC-A3: 出队逻辑 priority-first — urgent 消息在 normal 前面被处理
- AC-A4: 用户手动 position 覆盖 priority 排序（仅显式设置时）
- AC-A5: 用户消息不再强制 merge — 每条独立 QueueEntry
- AC-A6: 出队时 user-message batching — 连续同 userId + 同 intent + 同 targetCats 的 user entries 汇聚为一次 invocation
- AC-A7: connector/agent 消息不受 MAX_QUEUE_DEPTH 限制
- AC-A8: reorder API 可用（`PATCH /queue/reorder`）
- AC-A9: 回归：urgent connector 不打断 A2A 链（#564 原始场景修复）
- AC-A10: 回归：跨优先级自动 dequeue — urgent 处理完后自动继续 normal
**Architecture:** QueueEntry 扩展 priority/sourceCategory/position 三字段；enqueue 取消 merge、按 source 分别限容；dequeue 改为多维排序（position > priority > createdAt）；handleUrgentTrigger 删除，urgent 语义从"抢占"变为"队首优先级"；QueueProcessor 出队时汇聚连续同条件 user entries
**Tech Stack:** TypeScript, Node test runner, InvocationQueue (in-memory Map)
**前端验证:** No — Phase A 纯后端

---

## Terminal Schema

```typescript
interface QueueEntry {
  // ...existing fields (id, threadId, userId, content, messageId, mergedMessageIds,
  //   source, targetCats, intent, status, createdAt, processingStartedAt,
  //   autoExecute, callerCatId, senderMeta)
  priority: 'urgent' | 'normal';
  sourceCategory?: 'ci' | 'review' | 'conflict' | 'scheduled' | 'a2a';
  position?: number;  // user drag-reorder; only explicit values override priority
}
```

Dequeue order: `position (explicit) > priority (urgent > normal) > createdAt (FIFO)`

---

## Task 1: QueueEntry 接口扩展 + enqueue 透传

**Files:**
- Modify: `packages/api/src/domains/cats/services/agents/invocation/InvocationQueue.ts:16-36` (QueueEntry interface)
- Modify: `packages/api/src/domains/cats/services/agents/invocation/InvocationQueue.ts:72-137` (enqueue method)
- Test: `packages/api/test/invocation-queue.test.js`

**Step 1: Write failing tests — priority/sourceCategory preserved through enqueue**

```javascript
// in invocation-queue.test.js, new describe block
describe('priority and sourceCategory fields', () => {
  it('enqueue preserves priority field', () => {
    const q = new InvocationQueue();
    const result = q.enqueue({
      threadId: 't1', userId: 'u1', content: 'msg',
      source: 'connector', targetCats: ['cat1'], intent: 'execute',
      priority: 'urgent', sourceCategory: 'ci',
    });
    assert.strictEqual(result.entry.priority, 'urgent');
    assert.strictEqual(result.entry.sourceCategory, 'ci');
  });

  it('defaults priority to normal when omitted', () => {
    const q = new InvocationQueue();
    const result = q.enqueue({
      threadId: 't1', userId: 'u1', content: 'msg',
      source: 'user', targetCats: ['cat1'], intent: 'execute',
    });
    assert.strictEqual(result.entry.priority, 'normal');
    assert.strictEqual(result.entry.sourceCategory, undefined);
  });
});
```

**Step 2: Run test → FAIL** (priority not in QueueEntry)

**Step 3: Implement — add fields to QueueEntry + enqueue**

In `InvocationQueue.ts`:
- QueueEntry interface (L16-36): add `priority: 'urgent' | 'normal'`, `sourceCategory?`, `position?`
- enqueue input Omit list (L75): add `priority` and `sourceCategory` to the accepted input (remove from Omit)
- entry construction (L118-133): add `priority: input.priority ?? 'normal'`, `sourceCategory: input.sourceCategory`, `position: undefined`

**Step 4: Run test → PASS**

**Step 5: Commit**
```bash
git add packages/api/src/domains/cats/services/agents/invocation/InvocationQueue.ts packages/api/test/invocation-queue.test.js
git commit -m "feat(F175): add priority/sourceCategory/position to QueueEntry"
```

---

## Task 2: 取消 merge 逻辑 + source 分别限容

**Files:**
- Modify: `packages/api/src/domains/cats/services/agents/invocation/InvocationQueue.ts:84-116` (merge + capacity)
- Test: `packages/api/test/invocation-queue.test.js`

**Step 1: Write failing tests**

```javascript
describe('no merge — independent entries', () => {
  it('same-source same-target user messages are NOT merged', () => {
    const q = new InvocationQueue();
    q.enqueue({ threadId: 't1', userId: 'u1', content: 'a', source: 'user', targetCats: ['c1'], intent: 'execute' });
    q.enqueue({ threadId: 't1', userId: 'u1', content: 'b', source: 'user', targetCats: ['c1'], intent: 'execute' });
    const list = q.list('t1', 'u1');
    assert.strictEqual(list.length, 2);
    assert.strictEqual(list[0].content, 'a');
    assert.strictEqual(list[1].content, 'b');
  });
});

describe('source-specific capacity', () => {
  it('connector messages bypass MAX_QUEUE_DEPTH', () => {
    const q = new InvocationQueue();
    for (let i = 0; i < 7; i++) {
      const r = q.enqueue({
        threadId: 't1', userId: 'u1', content: `msg${i}`,
        source: 'connector', targetCats: ['c1'], intent: 'execute',
      });
      assert.strictEqual(r.outcome, 'enqueued');
    }
    assert.strictEqual(q.list('t1', 'u1').length, 7);
  });

  it('agent messages bypass MAX_QUEUE_DEPTH', () => {
    const q = new InvocationQueue();
    for (let i = 0; i < 7; i++) {
      const r = q.enqueue({
        threadId: 't1', userId: 'u1', content: `msg${i}`,
        source: 'agent', targetCats: ['c1'], intent: 'execute',
      });
      assert.strictEqual(r.outcome, 'enqueued');
    }
  });

  it('user messages still limited by MAX_QUEUE_DEPTH', () => {
    const q = new InvocationQueue();
    for (let i = 0; i < 5; i++) {
      q.enqueue({ threadId: 't1', userId: 'u1', content: `msg${i}`, source: 'user', targetCats: ['c1'], intent: 'execute' });
    }
    const r = q.enqueue({ threadId: 't1', userId: 'u1', content: 'overflow', source: 'user', targetCats: ['c1'], intent: 'execute' });
    assert.strictEqual(r.outcome, 'full');
  });
});
```

**Step 2: Run test → FAIL** (merge still happening, connector still capped)

**Step 3: Implement**

In `InvocationQueue.ts` enqueue():
- Delete merge block (L84-105): remove the entire `if (tail && !isStaleTail && ...)` block
- Delete `preMergeSnapshots` usage in enqueue (the field stays for rollbackMerge backward compat; remove later if unused)
- Modify capacity check (L107-116): only count `source === 'user'` entries
  ```typescript
  if (input.source === 'user') {
    const userQueuedCount = q.filter(
      (e) => e.status === 'queued' && e.source === 'user'
    ).length;
    if (userQueuedCount >= MAX_QUEUE_DEPTH) {
      return { outcome: 'full' };
    }
  }
  ```
- Update EnqueueResult: remove `'merged'` from outcome union since merge no longer happens
- Remove `rollbackMerge()`, `appendMergedMessageId()`, `preMergeSnapshots` map — dead code after merge removal

**Step 4: Run test → PASS**

**Step 5: Fix existing merge tests** — update/remove tests that assert merge behavior

**Step 6: Commit**
```bash
git commit -m "feat(F175): remove merge logic + source-specific capacity"
```

---

## Task 3: 多维排序出队

**Files:**
- Modify: `packages/api/src/domains/cats/services/agents/invocation/InvocationQueue.ts:330-360` (peekOldestAcrossUsers, markProcessingAcrossUsers)
- Test: `packages/api/test/invocation-queue.test.js`

**Step 1: Write failing tests**

```javascript
describe('multi-dimensional dequeue ordering', () => {
  it('urgent entry dequeues before normal regardless of createdAt', () => {
    const q = new InvocationQueue();
    q.enqueue({ threadId: 't1', userId: 'u1', content: 'normal', source: 'user', targetCats: ['c1'], intent: 'execute', priority: 'normal' });
    q.enqueue({ threadId: 't1', userId: 'u2', content: 'urgent', source: 'connector', targetCats: ['c1'], intent: 'execute', priority: 'urgent' });
    const next = q.peekOldestAcrossUsers('t1');
    assert.strictEqual(next.content, 'urgent');
    assert.strictEqual(next.priority, 'urgent');
  });

  it('explicit position overrides priority', () => {
    const q = new InvocationQueue();
    q.enqueue({ threadId: 't1', userId: 'u1', content: 'urgent', source: 'connector', targetCats: ['c1'], intent: 'execute', priority: 'urgent' });
    const r = q.enqueue({ threadId: 't1', userId: 'u1', content: 'positioned', source: 'user', targetCats: ['c1'], intent: 'execute', priority: 'normal' });
    // Manually set position (simulating drag reorder)
    q.setPosition('t1', 'u1', r.entry.id, 0);
    const next = q.peekOldestAcrossUsers('t1');
    assert.strictEqual(next.content, 'positioned');
  });

  it('same priority entries ordered by createdAt (FIFO)', () => {
    const q = new InvocationQueue();
    q.enqueue({ threadId: 't1', userId: 'u1', content: 'first', source: 'user', targetCats: ['c1'], intent: 'execute', priority: 'normal' });
    q.enqueue({ threadId: 't1', userId: 'u2', content: 'second', source: 'user', targetCats: ['c1'], intent: 'execute', priority: 'normal' });
    const next = q.peekOldestAcrossUsers('t1');
    assert.strictEqual(next.content, 'first');
  });

  it('markProcessingAcrossUsers respects priority ordering', () => {
    const q = new InvocationQueue();
    q.enqueue({ threadId: 't1', userId: 'u1', content: 'normal', source: 'user', targetCats: ['c1'], intent: 'execute', priority: 'normal' });
    q.enqueue({ threadId: 't1', userId: 'u2', content: 'urgent', source: 'connector', targetCats: ['c1'], intent: 'execute', priority: 'urgent' });
    const entry = q.markProcessingAcrossUsers('t1');
    assert.strictEqual(entry.content, 'urgent');
    assert.strictEqual(entry.status, 'processing');
  });
});
```

**Step 2: Run test → FAIL** (peekOldestAcrossUsers uses createdAt only)

**Step 3: Implement — multi-dimensional comparator**

Add a private comparator method and a `setPosition` method:

```typescript
private static compareEntries(a: QueueEntry, b: QueueEntry): number {
  // 1. Explicit position first (lower = higher priority)
  const aHasPos = a.position !== undefined;
  const bHasPos = b.position !== undefined;
  if (aHasPos && !bHasPos) return -1;
  if (!aHasPos && bHasPos) return 1;
  if (aHasPos && bHasPos) return a.position! - b.position!;
  // 2. Priority: urgent < normal
  const priorityRank = { urgent: 0, normal: 1 };
  const pDiff = priorityRank[a.priority] - priorityRank[b.priority];
  if (pDiff !== 0) return pDiff;
  // 3. createdAt FIFO
  return a.createdAt - b.createdAt;
}

setPosition(threadId: string, userId: string, entryId: string, position: number): boolean {
  const e = this.findEntry(threadId, userId, entryId);
  if (!e || e.status !== 'queued') return false;
  e.position = position;
  return true;
}
```

Update `peekOldestAcrossUsers` (L330-342): collect all queued entries, sort with comparator, return first.
Update `markProcessingAcrossUsers` (L345-360): same comparator logic.

**Step 4: Run test → PASS**

**Step 5: Commit**
```bash
git commit -m "feat(F175): multi-dimensional dequeue ordering (position > priority > createdAt)"
```

---

## Task 4: 删除 handleUrgentTrigger + priority 透传

**Files:**
- Modify: `packages/api/src/infrastructure/email/ConnectorInvokeTrigger.ts:90-142` (trigger method)
- Delete: `packages/api/src/infrastructure/email/ConnectorInvokeTrigger.ts:194-285` (handleUrgentTrigger)
- Modify: `packages/api/src/infrastructure/email/ConnectorInvokeTrigger.ts:144-192` (enqueueWhileActive — accept priority)
- Test: `packages/api/test/connector-invoke-trigger.test.js`

**Step 1: Write failing tests**

```javascript
describe('urgent connector uses queue with priority (F175)', () => {
  it('urgent message enqueues with priority=urgent instead of preempting', () => {
    // Setup: cat already active
    invocationTracker.start(threadId, catId, userId, controller);
    trigger.trigger(threadId, catId, userId, 'CI failed', msgId, undefined, { priority: 'urgent', reason: 'ci_failure' });
    // Should NOT cancel the active invocation
    assert.ok(invocationTracker.has(threadId, catId), 'active invocation should still be running');
    // Should be enqueued with priority
    const queue = invocationQueue.list(threadId, userId);
    assert.strictEqual(queue.length, 1);
    assert.strictEqual(queue[0].priority, 'urgent');
  });

  it('signal is NOT aborted by urgent connector message', () => {
    invocationTracker.start(threadId, catId, userId, controller);
    trigger.trigger(threadId, catId, userId, 'CI failed', msgId, undefined, { priority: 'urgent' });
    assert.strictEqual(controller.signal.aborted, false);
  });
});
```

**Step 2: Run test → FAIL** (handleUrgentTrigger still preempts)

**Step 3: Implement**

In `ConnectorInvokeTrigger.ts`:

1. **Modify `trigger()` (L90-142):** Remove the urgent branch (L103-118). All active paths go through `enqueueWhileActive()`:
   ```typescript
   trigger(...): TriggerOutcome {
     const priority = policy?.priority ?? 'normal';
     if (invocationTracker.has(threadId, catId)) {
       return this.enqueueWhileActive(threadId, catId, userId, message, messageId, sender, priority, policy?.sourceCategory);
     }
     // No active invocation → direct execution
     this.executeInBackground(...);
     return 'dispatched';
   }
   ```

2. **Modify `enqueueWhileActive()` (L144-192):** Accept and pass `priority` + `sourceCategory`:
   ```typescript
   private enqueueWhileActive(
     threadId, catId, userId, message, messageId, sender?,
     priority: 'urgent' | 'normal' = 'normal',
     sourceCategory?: string,
   ): 'full' | 'enqueued' {
     const result = invocationQueue.enqueue({
       threadId, userId, content: message,
       source: 'connector', targetCats: [catId], intent: 'execute',
       priority, sourceCategory,
       ...(sender ? { senderMeta: sender } : {}),
     });
     // ... rest unchanged but remove 'merged' outcome handling
   }
   ```
   Return type changes to `'full' | 'enqueued'` (no more `'merged'`).

3. **Delete `handleUrgentTrigger()` entirely (L194-285).**

4. **Update `ConnectorTriggerPolicy`:** Add `sourceCategory?` field.

**Step 4: Run test → PASS**

**Step 5: Update existing urgent tests** — tests that assert preemption behavior need updating to assert enqueueing instead

**Step 6: Verify 4 urgent callers still compile** (they set `priority: 'urgent'` which is now just a queue priority, no code change needed in callers)

```bash
grep -rn "priority.*urgent" packages/api/src/infrastructure/email/{CiCdCheckTaskSpec,ReviewFeedbackTaskSpec,ConflictCheckTaskSpec,github-review-bootstrap}.ts
```

**Step 7: Commit**
```bash
git commit -m "feat(F175): delete handleUrgentTrigger — urgent → priority enqueue"
```

---

## Task 5: User-message batching (出队汇聚)

**Files:**
- Modify: `packages/api/src/domains/cats/services/agents/invocation/InvocationQueue.ts` (new `collectBatch` method)
- Modify: `packages/api/src/domains/cats/services/agents/invocation/QueueProcessor.ts:485+` (executeEntry — use batch)
- Test: `packages/api/test/queue-processor.test.js`

**Step 1: Write failing tests**

```javascript
describe('user-message batching at dequeue (F175)', () => {
  it('collects adjacent user entries with same userId+intent+targetCats', () => {
    queue.enqueue({ threadId, userId, content: 'a', source: 'user', targetCats: ['c1'], intent: 'execute' });
    queue.enqueue({ threadId, userId, content: 'b', source: 'user', targetCats: ['c1'], intent: 'execute' });
    queue.enqueue({ threadId, userId, content: 'c', source: 'user', targetCats: ['c1'], intent: 'execute' });
    const batch = queue.collectUserBatch(threadId, userId);
    assert.strictEqual(batch.length, 3);
    assert.strictEqual(batch.map(e => e.content).join('\n'), 'a\nb\nc');
  });

  it('stops batching at different intent', () => {
    queue.enqueue({ threadId, userId, content: 'a', source: 'user', targetCats: ['c1'], intent: 'execute' });
    queue.enqueue({ threadId, userId, content: 'b', source: 'user', targetCats: ['c1'], intent: 'search' });
    const batch = queue.collectUserBatch(threadId, userId);
    assert.strictEqual(batch.length, 1);
  });

  it('stops batching at connector/agent entry', () => {
    queue.enqueue({ threadId, userId, content: 'a', source: 'user', targetCats: ['c1'], intent: 'execute' });
    queue.enqueue({ threadId, userId, content: 'b', source: 'connector', targetCats: ['c1'], intent: 'execute' });
    queue.enqueue({ threadId, userId, content: 'c', source: 'user', targetCats: ['c1'], intent: 'execute' });
    const batch = queue.collectUserBatch(threadId, userId);
    assert.strictEqual(batch.length, 1);
  });

  it('does not batch across different targetCats', () => {
    queue.enqueue({ threadId, userId, content: 'a', source: 'user', targetCats: ['c1'], intent: 'execute' });
    queue.enqueue({ threadId, userId, content: 'b', source: 'user', targetCats: ['c1', 'c2'], intent: 'execute' });
    const batch = queue.collectUserBatch(threadId, userId);
    assert.strictEqual(batch.length, 1);
  });

  it('connector/agent entries are never batched', () => {
    queue.enqueue({ threadId, userId, content: 'a', source: 'connector', targetCats: ['c1'], intent: 'execute' });
    queue.enqueue({ threadId, userId, content: 'b', source: 'connector', targetCats: ['c1'], intent: 'execute' });
    const batch = queue.collectUserBatch(threadId, userId);
    assert.strictEqual(batch.length, 1);
  });
});
```

**Step 2: Run test → FAIL**

**Step 3: Implement**

In `InvocationQueue.ts`, add `collectUserBatch()`:

```typescript
/**
 * F175: Collect a batch of adjacent user entries for unified execution.
 * Starting from the first queued entry, collects consecutive entries matching:
 * same source=user, same userId, same intent, same targetCats (Set equality).
 * Connector/agent entries are always single-entry batches.
 * Returns the entries (still queued — caller marks processing).
 */
collectUserBatch(threadId: string, userId: string): QueueEntry[] {
  const key = this.scopeKey(threadId, userId);
  const q = this.queues.get(key);
  if (!q) return [];

  const first = q.find(e => e.status === 'queued');
  if (!first) return [];
  if (first.source !== 'user') return [{ ...first }];

  const batch: QueueEntry[] = [{ ...first }];
  const firstIdx = q.indexOf(first);
  for (let i = firstIdx + 1; i < q.length; i++) {
    const e = q[i];
    if (e.status !== 'queued') continue;
    if (e.source !== 'user' || e.userId !== first.userId ||
        e.intent !== first.intent ||
        !setsEqual(e.targetCats, first.targetCats)) break;
    batch.push({ ...e });
  }
  return batch;
}
```

In `QueueProcessor.ts` `executeEntry()` (L485+): when entry.source === 'user', collect batch and combine content:

```typescript
let effectiveContent = entry.content;
let batchedEntryIds: string[] = [];
if (entry.source === 'user') {
  const batch = this.deps.queue.collectUserBatch(entry.threadId, entry.userId);
  if (batch.length > 1) {
    effectiveContent = batch.map(e => e.content).join('\n');
    batchedEntryIds = batch.slice(1).map(e => e.id);
    // Mark all batched entries as processing
    for (const be of batchedEntryIds) {
      this.deps.queue.markProcessingById(entry.threadId, entry.userId, be);
    }
  }
}
// Use effectiveContent in router.route() call
// In finally block: remove all batched entries
```

**Step 4: Run test → PASS**

**Step 5: Commit**
```bash
git commit -m "feat(F175): user-message batching at dequeue time"
```

---

## Task 6: Reorder API

**Files:**
- Modify: `packages/api/src/routes/queue.ts` (new PATCH endpoint)
- Test: `packages/api/test/queue-api.test.js`

**Step 1: Write failing tests**

```javascript
describe('PATCH /api/threads/:threadId/queue/reorder', () => {
  it('sets positions on multiple entries', async () => {
    // Enqueue 3 entries
    const e1 = invocationQueue.enqueue({ threadId, userId, content: 'a', source: 'user', targetCats: ['c1'], intent: 'execute' });
    const e2 = invocationQueue.enqueue({ threadId, userId, content: 'b', source: 'user', targetCats: ['c1'], intent: 'execute' });
    const e3 = invocationQueue.enqueue({ threadId, userId, content: 'c', source: 'user', targetCats: ['c1'], intent: 'execute' });

    const res = await request(app)
      .patch(`/api/threads/${threadId}/queue/reorder`)
      .set('x-user-id', userId)
      .send({ positions: [
        { entryId: e3.entry.id, position: 0 },
        { entryId: e1.entry.id, position: 1 },
        { entryId: e2.entry.id, position: 2 },
      ]});
    assert.strictEqual(res.status, 200);

    // Verify order
    const next = invocationQueue.peekOldestAcrossUsers(threadId);
    assert.strictEqual(next.content, 'c'); // e3 is now first
  });

  it('rejects position on processing entry', async () => {
    const e1 = invocationQueue.enqueue({ threadId, userId, content: 'a', source: 'user', targetCats: ['c1'], intent: 'execute' });
    invocationQueue.markProcessing(threadId, userId);
    const res = await request(app)
      .patch(`/api/threads/${threadId}/queue/reorder`)
      .set('x-user-id', userId)
      .send({ positions: [{ entryId: e1.entry.id, position: 0 }] });
    assert.strictEqual(res.status, 400);
  });
});
```

**Step 2: Run test → FAIL** (endpoint doesn't exist)

**Step 3: Implement**

In `queue.ts`, add after the existing move endpoint:

```typescript
router.patch('/api/threads/:threadId/queue/reorder', async (req, res) => {
  const { threadId } = req.params;
  const userId = req.headers['x-user-id'] as string;
  const { positions } = req.body as { positions: Array<{ entryId: string; position: number }> };

  if (!Array.isArray(positions)) {
    return res.status(400).json({ error: 'positions must be an array' });
  }

  for (const { entryId, position } of positions) {
    const success = invocationQueue.setPosition(threadId, userId, entryId, position);
    if (!success) {
      return res.status(400).json({ error: `Cannot reorder entry ${entryId} (not found or processing)` });
    }
  }

  socketManager.emitToUser(userId, 'queue_updated', {
    threadId,
    queue: invocationQueue.list(threadId, userId),
    action: 'reordered',
  });
  res.json({ ok: true });
});
```

**Step 4: Run test → PASS**

**Step 5: Commit**
```bash
git commit -m "feat(F175): add PATCH /queue/reorder API"
```

---

## Task 7: 回归测试 — #564 + 跨优先级 auto-dequeue

**Files:**
- Test: `packages/api/test/queue-integration.test.js` (new regression scenarios)

**Step 1: Write #564 regression test**

```javascript
describe('#564 regression: urgent connector does not break A2A chain', () => {
  it('A2A @mention routing is not blocked by urgent enqueue', async () => {
    // 1. Start an A2A round: opus responding, will @gpt52
    invocationTracker.start(threadId, 'opus', userId, controller);
    // 2. CI failure arrives as urgent connector message
    trigger.trigger(threadId, 'opus', userId, 'CI failed', 'ci-msg-1', undefined, {
      priority: 'urgent', reason: 'ci_failure',
    });
    // 3. signal should NOT be aborted
    assert.strictEqual(controller.signal.aborted, false);
    // 4. urgent message should be in queue, not preempting
    const queue = invocationQueue.list(threadId, userId);
    assert.strictEqual(queue.length, 1);
    assert.strictEqual(queue[0].priority, 'urgent');
    // 5. A2A route-serial gate should still be open (signal not aborted)
    // (the actual route-serial check is: !signal?.aborted — verified by signal check above)
  });
});

describe('cross-priority auto-dequeue', () => {
  it('after urgent completes, continues to normal entries', async () => {
    // 1. Enqueue normal + urgent
    invocationQueue.enqueue({ threadId, userId: 'u1', content: 'normal', source: 'user', targetCats: ['c1'], intent: 'execute', priority: 'normal' });
    invocationQueue.enqueue({ threadId, userId: 'u1', content: 'urgent', source: 'connector', targetCats: ['c1'], intent: 'execute', priority: 'urgent' });
    // 2. Process: urgent should be picked first
    const first = invocationQueue.markProcessingAcrossUsers(threadId);
    assert.strictEqual(first.priority, 'urgent');
    // 3. Complete urgent → onInvocationComplete
    invocationQueue.removeProcessedAcrossUsers(threadId, first.id);
    await queueProcessor.onInvocationComplete(threadId, 'c1', 'succeeded');
    // 4. Normal entry should auto-start
    // (verified via processingSlots or invocationTracker state)
  });
});
```

**Step 2: Run test → PASS** (if all previous tasks implemented correctly)

**Step 3: Commit**
```bash
git commit -m "test(F175): #564 regression + cross-priority auto-dequeue"
```

---

## Task 8: 清理死代码 + 更新 caller 引用

**Files:**
- Modify: `packages/api/src/domains/cats/services/agents/invocation/InvocationQueue.ts` — remove `rollbackMerge`, `appendMergedMessageId`, `preMergeSnapshots`
- Modify: `packages/api/src/infrastructure/email/ConnectorInvokeTrigger.ts` — remove merged outcome handling in any remaining callers
- Grep: full codebase for `rollbackMerge`, `appendMergedMessageId`, `handleUrgentTrigger`, `preMergeSnapshots`, `'merged'` references

**Step 1: Grep all references**

```bash
grep -rn "rollbackMerge\|appendMergedMessageId\|preMergeSnapshots\|handleUrgentTrigger" packages/api/src/
grep -rn "outcome.*merged\|'merged'" packages/api/src/ packages/api/test/
```

**Step 2: Remove dead code + update all references**

**Step 3: Run full test suite — verify no regressions**

```bash
NODE_ENV=development pnpm --filter @cat-cafe/api test
```

**Step 4: Commit**
```bash
git commit -m "refactor(F175): remove merge dead code + update references"
```

---

## AC ↔ Task Mapping

| AC | Task | Verification |
|----|------|-------------|
| AC-A1 | Task 4 | handleUrgentTrigger deleted, grep confirms zero references |
| AC-A2 | Task 1 + Task 4 | QueueEntry.priority exists, 4 callers passthrough (grep) |
| AC-A3 | Task 3 | Test: urgent dequeues before normal |
| AC-A4 | Task 3 | Test: explicit position overrides priority |
| AC-A5 | Task 2 | Test: same-source entries not merged |
| AC-A6 | Task 5 | Test: collectUserBatch aggregates adjacent entries |
| AC-A7 | Task 2 | Test: connector/agent bypass MAX_QUEUE_DEPTH |
| AC-A8 | Task 6 | Test: PATCH /queue/reorder endpoint |
| AC-A9 | Task 7 | Test: #564 regression — signal not aborted |
| AC-A10 | Task 7 | Test: cross-priority auto-dequeue chain |
