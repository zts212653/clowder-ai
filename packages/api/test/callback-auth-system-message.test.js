/**
 * F174 Phase D2b-1 — In-context system_info rich block on callback auth failure.
 *
 * AC-D4: when callback auth fails (with surface-able reason + known threadId/catId),
 *        server posts a rich block to the affected thread + broadcasts via socket.
 * AC-D5: dedup within 5min window per (reason, tool, catId); "hide similar" 24h opt-out;
 *        stale_invocation / missing_creds / unknown_invocation skipped (no in-context surface).
 */

import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';

const HOUR_MS = 60 * 60 * 1000;
const MIN_MS = 60 * 1000;

function makeMessageStoreStub() {
  const appended = [];
  return {
    appended,
    async append(msg) {
      const stored = { ...msg, id: `msg-${appended.length + 1}`, threadId: msg.threadId ?? 'default' };
      appended.push(stored);
      return stored;
    },
  };
}

function makeSocketManagerStub() {
  const broadcasts = [];
  return {
    broadcasts,
    broadcastToRoom(room, event, payload) {
      broadcasts.push({ room, event, payload });
    },
  };
}

describe('CallbackAuthSystemMessageNotifier (F174-D2b-1)', () => {
  let CallbackAuthSystemMessageNotifier;
  let messageStore;
  let socketManager;
  let notifier;
  let now;

  beforeEach(async () => {
    const mod = await import('../dist/routes/callback-auth-system-message.js');
    CallbackAuthSystemMessageNotifier = mod.CallbackAuthSystemMessageNotifier;
    messageStore = makeMessageStoreStub();
    socketManager = makeSocketManagerStub();
    now = 1_700_000_000_000;
    notifier = new CallbackAuthSystemMessageNotifier({
      messageStore,
      socketManager,
      now: () => now,
    });
  });

  test('AC-D4: notify(expired) appends a system rich block + broadcasts connector_message', async () => {
    const sent = await notifier.notify({
      threadId: 't1',
      catId: 'opus',
      userId: 'u1',
      reason: 'expired',
      tool: 'register_pr_tracking',
      fallbackOk: true,
    });

    assert.equal(sent, true, 'notify should return true when message was sent');
    assert.equal(messageStore.appended.length, 1, 'one message appended');
    const msg = messageStore.appended[0];
    assert.equal(msg.threadId, 't1');
    assert.equal(msg.catId, null, 'system message uses catId=null');
    assert.equal(msg.userId, 'u1');
    assert.equal(msg.timestamp, now);
    assert.deepEqual(msg.mentions, []);
    assert.ok(msg.extra?.rich, 'has rich extra');
    assert.equal(msg.extra.rich.v, 1);
    assert.equal(msg.extra.rich.blocks.length, 1);
    const block = msg.extra.rich.blocks[0];
    assert.equal(block.kind, 'card', 'uses card kind (system_info absent in current schema)');
    assert.ok(block.id, 'block has stable id');
    assert.ok(JSON.stringify(block).includes('expired'), 'block body references reason');
    assert.ok(JSON.stringify(block).includes('register_pr_tracking'), 'block body references tool');

    assert.equal(socketManager.broadcasts.length, 1, 'one broadcast');
    const bc = socketManager.broadcasts[0];
    assert.equal(bc.room, 'thread:t1');
    assert.equal(bc.event, 'connector_message');
    assert.equal(bc.payload.threadId, 't1');
    assert.equal(bc.payload.message.id, msg.id);
    assert.equal(bc.payload.message.type, 'connector');
  });

  test('AC-D4: invalid_token also surfaces in-context', async () => {
    const sent = await notifier.notify({
      threadId: 't1',
      catId: 'opus',
      userId: 'u1',
      reason: 'invalid_token',
      tool: 'post_message',
    });
    assert.equal(sent, true);
    assert.equal(messageStore.appended.length, 1);
  });

  test('AC-D5: stale_invocation is skipped (noise policy)', async () => {
    const sent = await notifier.notify({
      threadId: 't1',
      catId: 'opus',
      userId: 'u1',
      reason: 'stale_invocation',
      tool: 'post_message',
    });
    assert.equal(sent, false, 'stale_invocation does not surface in-context');
    assert.equal(messageStore.appended.length, 0);
    assert.equal(socketManager.broadcasts.length, 0);
  });

  test('AC-D5: missing_creds skipped (no thread/cat context to attach to)', async () => {
    const sent = await notifier.notify({
      threadId: 't1',
      catId: 'opus',
      userId: 'u1',
      reason: 'missing_creds',
      tool: 'register_pr_tracking',
    });
    assert.equal(sent, false);
    assert.equal(messageStore.appended.length, 0);
  });

  test('AC-D5: unknown_invocation skipped (record gone, metadata unreliable)', async () => {
    const sent = await notifier.notify({
      threadId: 't1',
      catId: 'opus',
      userId: 'u1',
      reason: 'unknown_invocation',
      tool: 'register_pr_tracking',
    });
    assert.equal(sent, false);
    assert.equal(messageStore.appended.length, 0);
  });

  // F174 D2b-1 follow-up (alpha 验收 #5): refresh-token is a SYSTEM-DRIVEN
  // background heartbeat. Failures fire on a timer when the cat is idle —
  // user has no actionable response, so don't surface the in-context card.
  // Telemetry still records (D2b-3 panel + HubButton badge) so operator can
  // diagnose; only the thread富块 noise is suppressed.
  test('D2b-1 follow-up: refresh-token tool skipped even with surfaceable reason (background heartbeat)', async () => {
    const sent = await notifier.notify({
      threadId: 't1',
      catId: 'opus',
      userId: 'u1',
      reason: 'expired', // would normally surface (in SURFACEABLE_REASONS)
      tool: 'refresh-token', // BUT background heartbeat tool
    });
    assert.equal(sent, false, 'refresh-token failure must NOT surface in-context (alpha #5 fix)');
    assert.equal(messageStore.appended.length, 0);
    assert.equal(socketManager.broadcasts.length, 0);
  });

  // Cloud Codex P2 #1427: pruneExpired must run BEFORE any early-return guard
  // (heartbeat-tool, non-surfaceable reason) so dedup cache eviction still
  // progresses even when all failures are suppressed.
  test('Cloud P2 #1427: heartbeat-tool early return still prunes expired dedup entries', async () => {
    // Step 1: emit a real surfaceable failure — populates dedup
    const sent1 = await notifier.notify({
      threadId: 't1',
      catId: 'opus',
      userId: 'u1',
      reason: 'expired',
      tool: 'post_message',
    });
    assert.equal(sent1, true);
    assert.equal(notifier.__getDedupSizeForTest(), 1, 'one dedup entry after first surface');

    // Step 2: advance time past HIDE_WINDOW_MS (24h) so the entry is expired-eligible
    now += 25 * 60 * 60 * 1000; // 25h

    // Step 3: trigger a heartbeat-tool failure (would early-return)
    const sentHeartbeat = await notifier.notify({
      threadId: 't9',
      catId: 'opus',
      userId: 'u1',
      reason: 'expired',
      tool: 'refresh-token', // heartbeat — early return
    });
    assert.equal(sentHeartbeat, false, 'heartbeat tool skipped (D2b-1 follow-up)');

    // Critical assertion: pruneExpired ran BEFORE the heartbeat guard, so the
    // expired t1/post_message entry got evicted. Without the fix, this would
    // still be 1 (stale entry retained).
    assert.equal(
      notifier.__getDedupSizeForTest(),
      0,
      'expired dedup entry must be evicted even when notify early-returns for heartbeat tool',
    );
  });

  test('D2b-1 follow-up: user-driven tools (post_message, register_pr_tracking) still surface', async () => {
    // Sanity check: the BACKGROUND_HEARTBEAT_TOOLS allowlist is precise — only
    // refresh-token is suppressed; user-invoked tools remain surfaceable.
    const sentPost = await notifier.notify({
      threadId: 't1',
      catId: 'opus',
      userId: 'u1',
      reason: 'expired',
      tool: 'post_message',
    });
    assert.equal(sentPost, true, 'post_message remains surfaceable (user-driven)');

    const sentPr = await notifier.notify({
      threadId: 't2', // different thread to avoid dedup
      catId: 'opus',
      userId: 'u1',
      reason: 'expired',
      tool: 'register_pr_tracking',
    });
    assert.equal(sentPr, true, 'register_pr_tracking remains surfaceable (user-driven)');
  });

  test('AC-D5: dedup — same (reason+tool+cat) within 5min window only sent once', async () => {
    const sent1 = await notifier.notify({
      threadId: 't1',
      catId: 'opus',
      userId: 'u1',
      reason: 'expired',
      tool: 'register_pr_tracking',
    });
    assert.equal(sent1, true);

    now += 4 * MIN_MS;
    const sent2 = await notifier.notify({
      threadId: 't1',
      catId: 'opus',
      userId: 'u1',
      reason: 'expired',
      tool: 'register_pr_tracking',
    });
    assert.equal(sent2, false, 'duplicate within 5min window suppressed');
    assert.equal(messageStore.appended.length, 1);
  });

  test('AC-D5: dedup window expires — same key after 5min sends again', async () => {
    await notifier.notify({
      threadId: 't1',
      catId: 'opus',
      userId: 'u1',
      reason: 'expired',
      tool: 'register_pr_tracking',
    });
    now += 5 * MIN_MS + 1;
    const sent = await notifier.notify({
      threadId: 't1',
      catId: 'opus',
      userId: 'u1',
      reason: 'expired',
      tool: 'register_pr_tracking',
    });
    assert.equal(sent, true);
    assert.equal(messageStore.appended.length, 2);
  });

  test('AC-D5: different (reason, tool, cat) tuples are independent', async () => {
    await notifier.notify({
      threadId: 't1',
      catId: 'opus',
      userId: 'u1',
      reason: 'expired',
      tool: 'tool_a',
    });
    await notifier.notify({
      threadId: 't1',
      catId: 'opus',
      userId: 'u1',
      reason: 'expired',
      tool: 'tool_b',
    });
    await notifier.notify({
      threadId: 't1',
      catId: 'codex',
      userId: 'u1',
      reason: 'expired',
      tool: 'tool_a',
    });
    await notifier.notify({
      threadId: 't1',
      catId: 'opus',
      userId: 'u1',
      reason: 'invalid_token',
      tool: 'tool_a',
    });
    assert.equal(messageStore.appended.length, 4, 'all four distinct tuples send');
  });

  test('AC-D5: hideSimilar suppresses subsequent notifies within 24h', async () => {
    await notifier.notify({
      threadId: 't1',
      catId: 'opus',
      userId: 'u1',
      reason: 'expired',
      tool: 'register_pr_tracking',
    });
    notifier.hideSimilar({
      reason: 'expired',
      tool: 'register_pr_tracking',
      catId: 'opus',
      threadId: 't1',
      userId: 'u1',
    });

    now += 12 * HOUR_MS;
    const sent = await notifier.notify({
      threadId: 't1',
      catId: 'opus',
      userId: 'u1',
      reason: 'expired',
      tool: 'register_pr_tracking',
    });
    assert.equal(sent, false, 'hidden suppresses notify within 24h');
    assert.equal(messageStore.appended.length, 1);
  });

  test('AC-D5: hideSimilar expires after 24h', async () => {
    notifier.hideSimilar({
      reason: 'expired',
      tool: 'register_pr_tracking',
      catId: 'opus',
      threadId: 't1',
      userId: 'u1',
    });
    now += 24 * HOUR_MS + 1;
    const sent = await notifier.notify({
      threadId: 't1',
      catId: 'opus',
      userId: 'u1',
      reason: 'expired',
      tool: 'register_pr_tracking',
    });
    assert.equal(sent, true);
    assert.equal(messageStore.appended.length, 1);
  });

  test('Cloud P1 #1397: dedup is per-thread (different threadId same cat/tool fires both)', async () => {
    await notifier.notify({
      threadId: 't1',
      catId: 'opus',
      userId: 'u1',
      reason: 'expired',
      tool: 'register_pr_tracking',
    });
    const sent = await notifier.notify({
      threadId: 't2',
      catId: 'opus',
      userId: 'u1',
      reason: 'expired',
      tool: 'register_pr_tracking',
    });
    assert.equal(sent, true, 'dedup MUST NOT cross threads');
    assert.equal(messageStore.appended.length, 2);
  });

  test('Cloud P1 #1397: dedup is per-user (different userId same cat/tool/thread fires both)', async () => {
    await notifier.notify({
      threadId: 't1',
      catId: 'opus',
      userId: 'u1',
      reason: 'expired',
      tool: 'register_pr_tracking',
    });
    const sent = await notifier.notify({
      threadId: 't1',
      catId: 'opus',
      userId: 'u2',
      reason: 'expired',
      tool: 'register_pr_tracking',
    });
    assert.equal(sent, true, 'dedup MUST NOT cross users');
    assert.equal(messageStore.appended.length, 2);
  });

  test('Cloud P1 #1397: hideSimilar is per-thread (hide in t1 does not suppress t2)', async () => {
    notifier.hideSimilar({
      reason: 'expired',
      tool: 'register_pr_tracking',
      catId: 'opus',
      threadId: 't1',
      userId: 'u1',
    });
    const sent = await notifier.notify({
      threadId: 't2',
      catId: 'opus',
      userId: 'u1',
      reason: 'expired',
      tool: 'register_pr_tracking',
    });
    assert.equal(sent, true, 'hide in t1 must NOT suppress t2');
    assert.equal(messageStore.appended.length, 1);
  });

  test('Cloud P2 #1397: dedup map evicts entries past 5min window (no memory leak)', async () => {
    // Insert 3 distinct keys
    for (let i = 0; i < 3; i++) {
      await notifier.notify({
        threadId: `t${i}`,
        catId: 'opus',
        userId: 'u1',
        reason: 'expired',
        tool: 'register_pr_tracking',
      });
    }
    assert.equal(notifier.__getDedupSizeForTest(), 3, '3 entries inserted');

    // Advance past 5min dedup window then trigger pruning via another notify
    now += 5 * MIN_MS + 1;
    await notifier.notify({
      threadId: 't-trigger',
      catId: 'opus',
      userId: 'u1',
      reason: 'expired',
      tool: 'register_pr_tracking',
    });
    // 3 expired entries pruned, only the 1 fresh entry remains
    assert.equal(notifier.__getDedupSizeForTest(), 1, 'expired entries evicted');
  });

  test('Cloud P2 #1397: dedup map evicts hidden entries past 24h window', async () => {
    notifier.hideSimilar({
      reason: 'expired',
      tool: 't',
      catId: 'opus',
      threadId: 't1',
      userId: 'u1',
    });
    assert.equal(notifier.__getDedupSizeForTest(), 1);

    now += 24 * HOUR_MS + 1;
    // Trigger pruning via fresh notify on a different key
    await notifier.notify({
      threadId: 't2',
      catId: 'opus',
      userId: 'u1',
      reason: 'expired',
      tool: 't',
    });
    assert.equal(notifier.__getDedupSizeForTest(), 1, 'hidden expired entry evicted, only fresh remains');
  });

  test('Cloud P2 #1397: concurrent notify() for same tuple — only one emits (race-window closed)', async () => {
    // Slow-append store so two concurrent notify() calls overlap:
    //   t=0: A enters notify, passes guard, awaits append
    //   t=0: B enters notify (concurrent), MUST see A's reserved dedup slot
    //   t=10ms: both appends resolve
    //   → expect exactly 1 broadcast, not 2
    const slowStore = {
      appended: [],
      async append(msg) {
        await new Promise((r) => setTimeout(r, 5));
        const stored = { ...msg, id: `msg-${this.appended.length + 1}`, threadId: msg.threadId };
        this.appended.push(stored);
        return stored;
      },
    };
    const raceNotifier = new CallbackAuthSystemMessageNotifier({
      messageStore: slowStore,
      socketManager,
      now: () => now,
    });
    const params = {
      threadId: 't1',
      catId: 'opus',
      userId: 'u1',
      reason: 'expired',
      tool: 'register_pr_tracking',
    };
    const [a, b] = await Promise.all([raceNotifier.notify(params), raceNotifier.notify(params)]);
    assert.equal(a, true, 'first concurrent caller emits');
    assert.equal(b, false, 'second concurrent caller suppressed by reserved slot');
    assert.equal(slowStore.appended.length, 1, 'exactly one append, not two');
    assert.equal(socketManager.broadcasts.length, 1, 'exactly one broadcast, not two');
  });

  test('Cloud P2 #1397: dedup slot rolled back on append failure (so retry not suppressed)', async () => {
    const failingStore = {
      async append() {
        throw new Error('persistence boom');
      },
    };
    const failingNotifier = new CallbackAuthSystemMessageNotifier({
      messageStore: failingStore,
      socketManager,
      now: () => now,
    });
    const params = {
      threadId: 't1',
      catId: 'opus',
      userId: 'u1',
      reason: 'expired',
      tool: 'register_pr_tracking',
    };
    await assert.rejects(failingNotifier.notify(params), /persistence boom/);
    assert.equal(
      failingNotifier.__getDedupSizeForTest(),
      0,
      'failed append must roll back the dedup slot, otherwise next retry is silently suppressed',
    );
  });

  test('block.meta carries threadId + userId so frontend hide button posts the full key', async () => {
    await notifier.notify({
      threadId: 't1',
      catId: 'opus',
      userId: 'u1',
      reason: 'expired',
      tool: 'register_pr_tracking',
    });
    const meta = messageStore.appended[0].extra.rich.blocks[0].meta;
    assert.equal(meta.threadId, 't1');
    assert.equal(meta.userId, 'u1');
  });

  test('block content includes structured fields for frontend rendering', async () => {
    await notifier.notify({
      threadId: 't1',
      catId: 'opus',
      userId: 'u1',
      reason: 'expired',
      tool: 'register_pr_tracking',
      fallbackOk: true,
    });
    const block = messageStore.appended[0].extra.rich.blocks[0];
    // Structured fields the D2b-1 frontend will read to render badges/actions
    const meta = block.meta ?? {};
    assert.equal(meta.kind, 'callback_auth_failure', 'meta.kind tags the block as callback-auth surface');
    assert.equal(meta.reason, 'expired');
    assert.equal(meta.tool, 'register_pr_tracking');
    assert.equal(meta.catId, 'opus');
    assert.equal(meta.fallbackOk, true);
    assert.equal(typeof meta.failedAt, 'number');
  });
});
