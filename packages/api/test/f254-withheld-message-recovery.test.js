import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, test } from 'node:test';

const {
  applyRecoveryEntries,
  assertRecoveryWriteAllowed,
  extractRecoveryEntryFromEvents,
  planRecovery,
  validateRecoveryManifest,
} = await import('../dist/scripts/f254-withheld-message-recovery/core.js');
const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');
const { safeParseExtra } = await import('../dist/domains/cats/services/stores/redis/redis-message-parsers.js');

const sha256 = (value) => createHash('sha256').update(value).digest('hex');

function transcriptEvents(overrides = {}) {
  const invocationId = overrides.invocationId ?? 'inv-lost-1';
  const threadId = overrides.threadId ?? 'thread_damaged';
  const catId = overrides.catId ?? 'fable-5';
  const sessionId = overrides.sessionId ?? 'session-1';
  const base = { v: 1, threadId, catId, sessionId, cliSessionId: 'cli-1', invocationId };
  return [
    { ...base, t: 100, eventNo: 7, event: { type: 'session_init', timestamp: 100 } },
    {
      ...base,
      t: 110,
      eventNo: 8,
      event: {
        type: 'text',
        content: '买到汉堡了，',
        metadata: { provider: 'anthropic', model: 'claude-fable-5', sessionId: 'cli-1' },
      },
    },
    {
      ...base,
      t: 120,
      eventNo: 9,
      event: { type: 'text', content: '正在回家。' },
    },
    {
      ...base,
      t: 130,
      eventNo: 10,
      event: {
        type: 'done',
        metadata: { provider: 'anthropic', model: 'claude-fable-5', sessionId: 'cli-1' },
      },
    },
  ];
}

function makeEntry(overrides = {}) {
  const content = overrides.content ?? '买到汉堡了，正在回家。';
  return {
    invocationId: overrides.invocationId ?? 'inv-lost-1',
    threadId: overrides.threadId ?? 'thread_damaged',
    userId: overrides.userId ?? 'user-1',
    catId: overrides.catId ?? 'fable-5',
    timestamp: overrides.timestamp ?? 100,
    content,
    contentSha256: overrides.contentSha256 ?? sha256(content),
    sourceProof: overrides.sourceProof ?? {
      transcriptPath: 'data/transcripts/thread_damaged/fable-5/events.live.jsonl',
      sessionId: 'session-1',
      firstEventNo: 7,
      lastEventNo: 10,
      terminalEventNo: 10,
      terminalKind: 'transcript_done',
    },
    metadata: overrides.metadata ?? { provider: 'anthropic', model: 'claude-fable-5', sessionId: 'cli-1' },
  };
}

function makeManifest(entries = [makeEntry()]) {
  return {
    version: 1,
    incident: 'F254',
    generatedAt: '2026-07-12T02:00:00.000Z',
    cvoDecisionRef: '0001783820437069-000027-a6cebcce',
    entries,
  };
}

describe('F254 withheld-message transcript extraction', () => {
  test('reconstructs exact ordered text and anchors timestamp to invocation start', () => {
    const entry = extractRecoveryEntryFromEvents({
      invocationId: 'inv-lost-1',
      userId: 'user-1',
      transcriptPath: 'data/transcripts/example/events.live.jsonl',
      events: transcriptEvents(),
    });

    assert.equal(entry.content, '买到汉堡了，正在回家。');
    assert.equal(entry.contentSha256, sha256(entry.content));
    assert.equal(entry.timestamp, 100);
    assert.equal(entry.threadId, 'thread_damaged');
    assert.equal(entry.catId, 'fable-5');
    assert.equal(entry.sourceProof.firstEventNo, 7);
    assert.equal(entry.sourceProof.terminalEventNo, 10);
    assert.equal(entry.sourceProof.terminalKind, 'transcript_done');
    assert.equal(entry.metadata.model, 'claude-fable-5');
  });

  test('fails closed when the invocation has text but no terminal done event', () => {
    const events = transcriptEvents().filter((event) => event.event.type !== 'done');
    assert.throws(
      () =>
        extractRecoveryEntryFromEvents({
          invocationId: 'inv-lost-1',
          userId: 'user-1',
          transcriptPath: 'data/transcripts/example/events.live.jsonl',
          events,
        }),
      /terminal done/i,
    );
  });
});

describe('F254 recovery manifest validation and planning', () => {
  test('pins deterministic manifest and content hashes', () => {
    const first = validateRecoveryManifest(makeManifest());
    const second = validateRecoveryManifest(makeManifest());
    assert.equal(first.manifestSha256, second.manifestSha256);
    assert.equal(first.entries[0].contentSha256, sha256('买到汉堡了，正在回家。'));
  });

  test('rejects content hash drift and duplicate invocation identities', () => {
    assert.throws(
      () => validateRecoveryManifest(makeManifest([makeEntry({ contentSha256: '0'.repeat(64) })])),
      /contentSha256/i,
    );
    assert.throws(() => validateRecoveryManifest(makeManifest([makeEntry(), makeEntry()])), /duplicate invocationId/i);
  });

  test('rejects non-object manifests and malformed entries with an explicit validation error', () => {
    assert.throws(() => validateRecoveryManifest(null), /manifest must be an object/i);
    assert.throws(() => validateRecoveryManifest({ ...makeManifest(), entries: [null] }), /entry must be an object/i);
  });

  test('drops a recovery marker when durable source proof is absent', () => {
    const parsed = safeParseExtra(
      JSON.stringify({
        stream: { invocationId: 'inv-lost-1' },
        recovery: {
          kind: 'f254_withheld_message',
          invocationId: 'inv-lost-1',
          manifestSha256: 'a'.repeat(64),
          contentSha256: 'b'.repeat(64),
          cvoDecisionRef: 'decision-1',
          recoveredAt: 500,
        },
      }),
    );
    assert.equal(parsed.stream.invocationId, 'inv-lost-1');
    assert.equal(parsed.recovery, undefined);
  });

  test('classifies insert, callback companion, already-restored, already-formal, and identity conflict', () => {
    const validated = validateRecoveryManifest(
      makeManifest([
        makeEntry({ invocationId: 'inv-insert' }),
        makeEntry({ invocationId: 'inv-restored' }),
        makeEntry({ invocationId: 'inv-formal' }),
        makeEntry({ invocationId: 'inv-conflict' }),
        makeEntry({ invocationId: 'inv-callback-companion' }),
      ]),
    );
    const existing = [
      {
        id: 'msg-restored',
        threadId: 'thread_damaged',
        userId: 'user-1',
        catId: 'fable-5',
        content: '买到汉堡了，正在回家。',
        mentions: [],
        timestamp: 100,
        extra: {
          stream: { invocationId: 'inv-restored', turnInvocationId: 'inv-restored' },
          recovery: {
            kind: 'f254_withheld_message',
            invocationId: 'inv-restored',
            manifestSha256: validated.manifestSha256,
            contentSha256: sha256('买到汉堡了，正在回家。'),
            cvoDecisionRef: validated.cvoDecisionRef,
            recoveredAt: 500,
          },
        },
      },
      {
        id: 'msg-formal',
        threadId: 'thread_damaged',
        userId: 'user-1',
        catId: 'fable-5',
        content: '买到汉堡了，正在回家。',
        mentions: [],
        timestamp: 100,
        extra: { stream: { invocationId: 'inv-formal', turnInvocationId: 'inv-formal' } },
      },
      {
        id: 'msg-callback-companion',
        threadId: 'thread_damaged',
        userId: 'user-1',
        catId: 'fable-5',
        content: 'concise callback speech',
        mentions: [],
        timestamp: 100,
        origin: 'callback',
        extra: {
          stream: { invocationId: 'inv-callback-companion', turnInvocationId: 'inv-callback-companion' },
        },
      },
      {
        id: 'msg-conflict',
        threadId: 'thread_damaged',
        userId: 'user-1',
        catId: 'fable-5',
        content: 'different content',
        mentions: [],
        timestamp: 100,
        extra: { stream: { invocationId: 'inv-conflict', turnInvocationId: 'inv-conflict' } },
      },
    ];

    const plan = planRecovery(validated, existing);
    assert.deepEqual(
      plan.items.map((item) => [item.entry.invocationId, item.outcome]),
      [
        ['inv-callback-companion', 'insert_stream_companion'],
        ['inv-conflict', 'conflict'],
        ['inv-formal', 'already_formal'],
        ['inv-insert', 'insert'],
        ['inv-restored', 'already_restored'],
      ],
    );
    assert.equal(plan.summary.insert, 1);
    assert.equal(plan.summary.insert_stream_companion, 1);
    assert.equal(plan.summary.conflict, 1);
  });
});

describe('F254 recovery apply and production guard', () => {
  test('applies exact historical message once and rerun creates zero duplicates', async () => {
    const validated = validateRecoveryManifest(makeManifest());
    const store = new MessageStore();

    const first = await applyRecoveryEntries({
      manifest: validated,
      entries: validated.entries,
      messageStore: store,
      recoveredAt: 500,
    });
    const second = await applyRecoveryEntries({
      manifest: validated,
      entries: validated.entries,
      messageStore: store,
      recoveredAt: 600,
    });

    assert.equal(first.created.length, 1);
    assert.equal(second.created.length, 0);
    assert.equal(second.alreadyPresent.length, 1);
    const messages = await store.getByThread('thread_damaged', 10, 'user-1');
    assert.equal(messages.length, 1);
    assert.equal(messages[0].content, '买到汉堡了，正在回家。');
    assert.equal(messages[0].timestamp, 100);
    assert.equal(messages[0].origin, 'stream');
    assert.deepEqual(messages[0].extra.stream, {
      invocationId: 'inv-lost-1',
      turnInvocationId: 'inv-lost-1',
    });
    assert.equal(messages[0].extra.recovery.kind, 'f254_withheld_message');
    assert.equal(messages[0].extra.recovery.recoveredAt, 500);
  });

  test('allows 6398 preview but rejects 6399 without exact manifest-pinned approval', () => {
    const manifest = validateRecoveryManifest(makeManifest());
    assert.doesNotThrow(() => assertRecoveryWriteAllowed('redis://localhost:6398/13', manifest, { mode: 'preview' }));
    assert.throws(
      () => assertRecoveryWriteAllowed('redis://localhost:6399', manifest, { mode: 'preview' }),
      /production.*refused/i,
    );
    assert.throws(
      () =>
        assertRecoveryWriteAllowed('redis://localhost:6399', manifest, {
          mode: 'production',
          approvalRef: 'cvo-message-1',
          expectedManifestSha256: 'f'.repeat(64),
          confirmation: 'RESTORE F254 TO 6399',
        }),
      /manifest hash/i,
    );
    assert.doesNotThrow(() =>
      assertRecoveryWriteAllowed('redis://localhost:6399', manifest, {
        mode: 'production',
        approvalRef: 'cvo-message-1',
        expectedManifestSha256: manifest.manifestSha256,
        confirmation: 'RESTORE F254 TO 6399',
      }),
    );
  });
});
