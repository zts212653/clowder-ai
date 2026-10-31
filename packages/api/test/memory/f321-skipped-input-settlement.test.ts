import assert from 'node:assert/strict';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import { parseCursor } from '../../src/domains/cats/services/stores/cursor.js';
import { MessageStore, type StoredMessage } from '../../src/domains/cats/services/stores/ports/MessageStore.js';
import { readCurationBatch } from '../../src/domains/memory/CurationMessageReader.js';
import { EvidenceWriteQueue } from '../../src/domains/memory/evidence-write-queue.js';
import { processThread, type SummaryCompactionDeps } from '../../src/domains/memory/SummaryCompactionTask.js';
import { createSummaryCompactionTaskSpec } from '../../src/domains/memory/SummaryCompactionTaskSpec.js';
import { applyMigrations } from '../../src/domains/memory/schema.js';
import { SUMMARY_CONFIG } from '../../src/domains/memory/summary-config.js';
import { reconcileSummaryPendingInput } from '../../src/domains/memory/summary-pending-input.js';

function fixture() {
  const db = new Database(':memory:');
  applyMigrations(db);
  db.prepare(
    "INSERT INTO evidence_docs(anchor,kind,status,title,summary,updated_at) VALUES ('thread-home','thread','active','Home',NULL,'now')",
  ).run();
  db.prepare("INSERT INTO summary_state(thread_id) VALUES ('home')").run();
  const messages = new MessageStore();
  const append = (content: string, options: Partial<StoredMessage> = {}) => {
    const message = messages.append({
      threadId: 'home',
      userId: 'owner',
      content,
      timestamp: Date.now() - 3600000,
      ...options,
      from: options.from ?? { kind: 'user', userId: options.userId ?? 'owner' },
    });
    db.prepare(
      "UPDATE summary_state SET pending_input_revision=pending_input_revision+1,pending_message_count=pending_message_count+1,pending_token_count=pending_token_count+?,pending_signal_flags=1 WHERE thread_id='home'",
    ).run(Math.ceil(content.length / 4));
    return message;
  };
  let calls = 0;
  const deps: SummaryCompactionDeps = {
    db,
    enabled: () => true,
    getThreadLastActivity: async () => null,
    getMessagesAfterWatermark: (thread, after, limit) => readCurationBatch(messages, 'owner', thread, after, limit, 0),
    generateAbstractive: async (input) => {
      calls++;
      return {
        segments: [
          {
            summary: 'owner idea',
            topicKey: 'overview',
            topicLabel: 'idea',
            boundaryReason: 'batch',
            boundaryConfidence: 'high',
            fromMessageId: input.messages[0].id,
            toMessageId: input.messages.at(-1)!.id,
            messageCount: input.messages.length,
          },
        ],
      };
    },
    logger: { info() {}, error() {} },
  };
  const state = () =>
    // State remains canonical in SQLite; the helper only recalibrates scheduling hints.
    db.prepare("SELECT * FROM summary_state WHERE thread_id='home'").get() as Parameters<typeof processThread>[0];
  deps.curation = {
    timezone: 'UTC',
    reconcilePendingInput: (thread, watermark, signal) => reconcileSummaryPendingInput(deps, thread, watermark, signal),
  };
  messages.onTimelineChanged = () => {
    db.prepare(
      "UPDATE summary_state SET pending_input_revision=pending_input_revision+1,pending_message_count=pending_message_count+1 WHERE thread_id='home'",
    ).run();
  };
  const spec = createSummaryCompactionTaskSpec(deps);
  return { db, messages, append, deps, state, spec, calls: () => calls };
}

for (const transition of ['cancel', 'zero_exposure_recall'] as const) {
  test(`real ${transition} leaves no invisible pending debt and later owner work can finish`, async () => {
    const f = fixture();
    try {
      const queued = f.append('queued idea', { deliveryStatus: 'queued' });
      if (transition === 'cancel') assert.equal(f.messages.markCanceled(queued.id)?.deliveryTransitioned, true);
      else {
        const recalled = f.messages.recallMessageToComposerDraft(queued.id, {
          ownerUserId: 'owner',
          threadId: 'home',
          recalledAt: Date.now(),
          expectedDraftRevision: 0,
          merge: 'replace',
        });
        assert.equal(recalled.kind, 'recalled');
        if (recalled.kind === 'recalled') assert.equal(recalled.verdict, 'zero_exposure');
      }
      assert.equal((await readCurationBatch(f.messages, 'owner', 'home', null, 200, 0)).scannedMessages.length, 0);
      assert.equal((await f.spec.admission.gate({ taskId: f.spec.id, lastRunAt: null, tickCount: 1 })).run, false);
      assert.equal(f.state().pending_message_count, 0);
      assert.equal(f.state().carry_over, 0);
      f.append('later owner');
      assert.equal(await processThread(f.state(), f.deps, SUMMARY_CONFIG), true);
      assert.equal(f.state().pending_message_count, 0);
      assert.equal((await f.spec.admission.gate({ taskId: f.spec.id, lastRunAt: null, tickCount: 2 })).run, false);
    } finally {
      f.db.close();
    }
  });
}

for (const kind of ['system', 'whisper', 'foreign', 'recalled'] as const) {
  test(`${kind} tail settles pending debt, leaves scheduler, and later owner material still runs`, async () => {
    const f = fixture();
    try {
      const owner = f.append('owner idea');
      const ignored = f.append(
        'private system debt',
        kind === 'system'
          ? { userId: 'system', from: { kind: 'system', service: 'test-log' } }
          : kind === 'foreign'
            ? { userId: 'another-owner' }
            : kind === 'whisper'
              ? { visibility: 'whisper' }
              : {},
      );
      if (kind === 'recalled') ignored.recall = { version: 1, exposure: 'seen', recalledAt: Date.now() };
      assert.equal(await processThread(f.state(), f.deps, SUMMARY_CONFIG), true);
      assert.equal(f.state().pending_message_count, 0);
      assert.equal(f.state().pending_token_count, 0);
      assert.equal(f.state().pending_signal_flags, 0);
      assert.equal(f.state().carry_over, 0);
      assert.equal(parseCursor(f.state().last_summarized_message_id)?.id, ignored.id);
      assert.equal((await f.spec.admission.gate({ taskId: f.spec.id, lastRunAt: null, tickCount: 2 })).run, false);
      const segment = f.db
        .prepare('SELECT from_message_id,to_message_id,message_count FROM summary_segments')
        .get() as Record<string, unknown>;
      assert.equal(segment.from_message_id, owner.id);
      assert.equal(segment.to_message_id, owner.id);
      assert.equal(segment.message_count, 1, 'skipped rows must never become claimed model coverage');
      f.append('later owner idea');
      assert.equal(await processThread(f.state(), f.deps, SUMMARY_CONFIG), true);
      assert.equal(f.state().pending_message_count, 0);
      assert.equal(f.calls(), 2);
    } finally {
      f.db.close();
    }
  });
}

test('a skipped-only page settles without a model; stale replay cannot subtract a concurrent append', async () => {
  const f = fixture();
  try {
    for (let i = 0; i < 201; i++)
      f.append('system log', { userId: 'scheduler', from: { kind: 'system', service: 'scheduler' } });
    f.append('later owner');
    const before = f.state();
    assert.equal(await processThread(before, f.deps, SUMMARY_CONFIG), true);
    assert.equal(f.calls(), 0, 'first tick settles only its bounded 200-row page');
    assert.equal(f.state().pending_message_count, 2);
    const currentWatermark = f.state().last_summarized_message_id;
    f.append('concurrent owner');
    assert.equal(await processThread(before, f.deps, SUMMARY_CONFIG), false, 'stale cursor cannot settle twice');
    assert.equal(f.state().last_summarized_message_id, currentWatermark);
    assert.equal(f.state().pending_message_count, 3);
    assert.equal(await processThread(f.state(), f.deps, SUMMARY_CONFIG), true);
    assert.equal(f.calls(), 1);
    assert.equal(f.state().pending_message_count, 0);
  } finally {
    f.db.close();
  }
});

test('partial model coverage and concurrent appends remain pending across the scanned raw prefix', async () => {
  const f = fixture();
  try {
    const first = f.append('owner first');
    const ignored = f.append('system log', { userId: 'system', from: { kind: 'system', service: 'test-log' } });
    const unread = f.append('owner unread');
    const generate = f.deps.generateAbstractive;
    f.deps.generateAbstractive = async (input) => {
      f.append('concurrent owner');
      return generate({ ...input, messages: input.messages.slice(0, 1) });
    };
    assert.equal(await processThread(f.state(), f.deps, SUMMARY_CONFIG), true);
    assert.equal(parseCursor(f.state().last_summarized_message_id)?.id, ignored.id);
    assert.equal(f.state().pending_message_count, 2);
    assert.equal(f.state().carry_over, 1);
    const segment = f.db.prepare('SELECT to_message_id FROM summary_segments').get() as { to_message_id: string };
    assert.equal(segment.to_message_id, first.id);
    assert.notEqual(f.state().last_summarized_message_id, unread.id);
  } finally {
    f.db.close();
  }
});

test('append deltas waiting in the real writer queue cannot recreate already settled debt', async () => {
  const f = fixture();
  const queue = new EvidenceWriteQueue();
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  try {
    f.append('owner idea');
    const head = queue.enqueue(() => blocked);
    const system = f.messages.append({
      threadId: 'home',
      userId: 'system',
      from: { kind: 'system', service: 'test-log' },
      content: 'late delta',
      timestamp: Date.now() - 3600000,
    });
    const delta = queue.enqueue(() =>
      f.db
        .prepare(
          "UPDATE summary_state SET pending_message_count=pending_message_count+1,pending_token_count=pending_token_count+3,pending_signal_flags=1 WHERE thread_id='home'",
        )
        .run(),
    );
    f.deps.runExclusive = (fn) => queue.enqueue(fn);
    const pending = processThread(f.state(), f.deps, SUMMARY_CONFIG);
    await new Promise((resolve) => setImmediate(resolve));
    release();
    assert.equal(await pending, true);
    await head;
    await delta;
    assert.equal(parseCursor(f.state().last_summarized_message_id)?.id, system.id);
    assert.equal(f.state().pending_message_count, 0);
    assert.equal(f.state().pending_signal_flags, 0);
    assert.equal((await f.spec.admission.gate({ taskId: f.spec.id, lastRunAt: null, tickCount: 3 })).run, false);
  } finally {
    release();
    f.db.close();
  }
});

test('suppression prepared during a skipped-only scan leaves counters and watermark untouched', async () => {
  const f = fixture();
  try {
    f.append('system log', { userId: 'system', from: { kind: 'system', service: 'test-log' } });
    const before = f.state();
    const read = f.deps.getMessagesAfterWatermark;
    f.deps.getMessagesAfterWatermark = async (...args) => {
      const batch = await read(...args);
      f.db
        .prepare(
          "INSERT INTO message_recall_index_suppressions(doc_anchor,passage_id,lease_id,state,prepared_at) VALUES ('thread-home','source','lease','prepared','now')",
        )
        .run();
      return batch;
    };
    assert.equal(await processThread(before, f.deps, SUMMARY_CONFIG), false);
    assert.deepEqual(f.state(), before);
    assert.equal(f.calls(), 0);
  } finally {
    f.db.close();
  }
});

test('an append during canonical rebase invalidates its revision and cannot be cleared as empty debt', async () => {
  const f = fixture();
  try {
    const queued = f.append('queued', { deliveryStatus: 'queued' });
    f.messages.markCanceled(queued.id);
    const read = f.deps.getMessagesAfterWatermark;
    f.deps.getMessagesAfterWatermark = async (...args) => {
      const batch = await read(...args);
      f.append('concurrent owner');
      return batch;
    };
    assert.equal(await reconcileSummaryPendingInput(f.deps, 'home'), false);
    assert.ok(f.state().pending_message_count > 0);
    f.deps.getMessagesAfterWatermark = read;
    assert.equal((await f.spec.admission.gate({ taskId: f.spec.id, lastRunAt: null, tickCount: 1 })).run, true);
    assert.equal(await processThread(f.state(), f.deps, SUMMARY_CONFIG), true);
    assert.equal(f.state().pending_message_count, 0);
  } finally {
    f.db.close();
  }
});

test('Stop while waiting for the writer queue cannot commit an already generated overview', async () => {
  const f = fixture();
  const controller = new AbortController();
  const queue = new EvidenceWriteQueue();
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  let generated!: () => void;
  const ready = new Promise<void>((resolve) => {
    generated = resolve;
  });
  let queued!: () => void;
  const waitingForWriter = new Promise<void>((resolve) => {
    queued = resolve;
  });
  try {
    f.append('owner idea');
    const before = f.state();
    let head: Promise<void> | undefined;
    let providerFinished = false;
    f.deps.runExclusive = (fn) => {
      if (providerFinished) queued();
      return queue.enqueue(fn);
    };
    const generate = f.deps.generateAbstractive;
    f.deps.generateAbstractive = async (...args) => {
      const result = await generate(...args);
      head = queue.enqueue(() => blocked);
      providerFinished = true;
      generated();
      return result;
    };
    const pending = processThread(before, f.deps, SUMMARY_CONFIG, controller.signal);
    await ready;
    await waitingForWriter;
    controller.abort(new Error('owner Stop'));
    release();
    await assert.rejects(pending, /owner Stop/);
    await head;
    assert.equal(f.state().last_summarized_message_id, before.last_summarized_message_id);
    assert.equal(f.state().pending_message_count, before.pending_message_count);
    assert.equal((f.db.prepare('SELECT count(*) AS n FROM summary_segments').get() as { n: number }).n, 0);
  } finally {
    release();
    f.db.close();
  }
});
