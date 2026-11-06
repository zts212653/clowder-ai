import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { createCatId, isLifecycleStoredMessageMetadata, MAX_LIFECYCLE_APPEND_BOUNDARIES } from '@cat-cafe/shared';
import { InvocationTracker } from '../src/domains/cats/services/agents/invocation/InvocationTracker.js';
import { prepareLifecycleWakeCoverage } from '../src/domains/cats/services/stores/lifecycle-wake-coverage.js';
import {
  boundaryFromLiveBody,
  computeAppendBoundary,
  prepareLifecycleAppendAdmission,
  prepareLifecycleResponseTerminalMessage,
  type StoredMessage,
} from '../src/domains/cats/services/stores/ports/MessageStore.js';

const codex = createCatId('codex');
const dsh = createCatId('dsh');
const hash = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');
const boundary = (contentOffset: number, prefixSha256: string) => ({ contentOffset, prefixSha256 });

function response(overrides: Partial<StoredMessage> = {}): StoredMessage {
  return {
    id: 'response-1',
    userId: 'operator',
    threadId: 'thread-1',
    catId: codex,
    from: { kind: 'agent', catId: codex },
    mentions: [],
    timestamp: 1,
    content: '',
    lifecycle: {
      kind: 'response',
      orderKey: '1:response-1',
      invocationId: 'inv-1',
      targetId: 'codex',
      inputEntryIds: ['entry-1'],
      inputMessageIds: ['input-1'],
      status: 'processing',
      startedAt: 1,
      latestInputTimelineOrderAt: 1,
    },
    ...overrides,
  };
}

function input(id: string, overrides: Partial<StoredMessage> = {}): StoredMessage {
  return {
    id,
    userId: 'operator',
    threadId: 'thread-1',
    catId: null,
    from: { kind: 'agent', catId: dsh },
    mentions: [],
    timestamp: 2,
    content: `content ${id}`,
    lifecycle: { kind: 'input', orderKey: `${id}:order`, dispatchRefs: [] },
    ...overrides,
  };
}

function appendedResponse(lifecycle: StoredMessage['lifecycle']): StoredMessage {
  return response({ lifecycle });
}

test('computeAppendBoundary trims leading whitespace and hashes the normalized live prefix', () => {
  const body = '\n\n  first paragraph\nsecond paragraph';
  assert.deepEqual(computeAppendBoundary(body), {
    contentOffset: body.trimStart().length,
    prefixSha256: hash(body.trimStart()),
  });
  assert.deepEqual(computeAppendBoundary('   '), { contentOffset: 0, prefixSha256: hash('') });
});

test('boundaryFromLiveBody reads the exact getter and never guesses a cut', () => {
  assert.equal(boundaryFromLiveBody(undefined), undefined);
  assert.deepEqual(
    boundaryFromLiveBody(() => '  live body'),
    computeAppendBoundary('  live body'),
  );
});

test('adoption stores one public input boundary in trimStart coordinates', () => {
  const prepared = prepareLifecycleAppendAdmission([input('input-2'), response()], {
    threadId: 'thread-1',
    entryId: 'entry-2',
    inputMessageIds: ['input-2'],
    runs: [
      {
        targetId: 'codex',
        invocationId: 'inv-1',
        responseMessageId: 'response-1',
        dispatchedAt: 2,
        appendBoundary: boundary(5, 'a'.repeat(64)),
      },
    ],
  });

  assert.equal(prepared.kind, 'prepared');
  if (prepared.kind !== 'prepared') return;
  const next = prepared.lifecycles[1];
  assert.equal(next?.kind, 'response');
  assert.deepEqual(next?.appendBoundaries, [
    { inputMessageId: 'input-2', contentOffset: 5, prefixSha256: 'a'.repeat(64) },
  ]);
});

test('replay preserves the first boundary and never overwrites it with a later cursor', () => {
  const first = prepareLifecycleAppendAdmission([input('input-2'), response()], {
    threadId: 'thread-1',
    entryId: 'entry-2',
    inputMessageIds: ['input-2'],
    runs: [
      {
        targetId: 'codex',
        invocationId: 'inv-1',
        responseMessageId: 'response-1',
        dispatchedAt: 2,
        appendBoundary: boundary(5, 'a'.repeat(64)),
      },
    ],
  });
  assert.equal(first.kind, 'prepared');
  if (first.kind !== 'prepared') return;

  const replayed = prepareLifecycleAppendAdmission(
    [input('input-2', { lifecycle: first.lifecycles[0] }), appendedResponse(first.lifecycles[1])],
    {
      threadId: 'thread-1',
      entryId: 'entry-2',
      inputMessageIds: ['input-2'],
      runs: [
        {
          targetId: 'codex',
          invocationId: 'inv-1',
          responseMessageId: 'response-1',
          dispatchedAt: 2,
          appendBoundary: boundary(99, 'b'.repeat(64)),
        },
      ],
    },
  );

  assert.equal(replayed.kind, 'prepared');
  if (replayed.kind !== 'prepared') return;
  assert.equal(replayed.replayed, true);
  assert.deepEqual(replayed.lifecycles[1]?.appendBoundaries, [
    { inputMessageId: 'input-2', contentOffset: 5, prefixSha256: 'a'.repeat(64) },
  ]);
});

test('whisper input never leaks a public boundary', () => {
  const prepared = prepareLifecycleAppendAdmission([input('input-whisper', { visibility: 'whisper' }), response()], {
    threadId: 'thread-1',
    entryId: 'entry-whisper',
    inputMessageIds: ['input-whisper'],
    runs: [
      {
        targetId: 'codex',
        invocationId: 'inv-1',
        responseMessageId: 'response-1',
        dispatchedAt: 2,
        appendBoundary: boundary(7, 'c'.repeat(64)),
      },
    ],
  });

  assert.equal(prepared.kind, 'prepared');
  if (prepared.kind !== 'prepared') return;
  assert.equal(prepared.lifecycles[1]?.appendBoundaries, undefined);
});

test('one cumulative body keeps distinct cuts for successive public inputs', () => {
  const current = appendedResponse({
    ...response().lifecycle,
    inputEntryIds: ['entry-1', 'entry-2'],
    inputMessageIds: ['input-1', 'input-2'],
    appendBoundaries: [{ inputMessageId: 'input-2', contentOffset: 5, prefixSha256: 'a'.repeat(64) }],
  } as NonNullable<StoredMessage['lifecycle']>);

  const prepared = prepareLifecycleAppendAdmission([input('input-3'), current], {
    threadId: 'thread-1',
    entryId: 'entry-3',
    inputMessageIds: ['input-3'],
    runs: [
      {
        targetId: 'codex',
        invocationId: 'inv-1',
        responseMessageId: 'response-1',
        dispatchedAt: 3,
        appendBoundary: boundary(10, 'b'.repeat(64)),
      },
    ],
  });

  assert.equal(prepared.kind, 'prepared');
  if (prepared.kind !== 'prepared') return;
  assert.deepEqual(prepared.lifecycles[1]?.appendBoundaries, [
    { inputMessageId: 'input-2', contentOffset: 5, prefixSha256: 'a'.repeat(64) },
    { inputMessageId: 'input-3', contentOffset: 10, prefixSha256: 'b'.repeat(64) },
  ]);
});

test('a public admission without a trusted cut clears older partial cuts', () => {
  const withOlderCut = response({
    lifecycle: {
      ...response().lifecycle,
      inputEntryIds: ['entry-1', 'entry-2'],
      inputMessageIds: ['input-1', 'input-2'],
      appendBoundaries: [{ inputMessageId: 'input-2', contentOffset: 5, prefixSha256: 'a'.repeat(64) }],
    } as NonNullable<StoredMessage['lifecycle']>,
  });
  const prepared = prepareLifecycleAppendAdmission([input('input-3'), withOlderCut], {
    threadId: 'thread-1',
    entryId: 'entry-3',
    inputMessageIds: ['input-3'],
    runs: [
      {
        targetId: 'codex',
        invocationId: 'inv-1',
        responseMessageId: 'response-1',
        dispatchedAt: 3,
      },
    ],
  });

  assert.equal(prepared.kind, 'prepared');
  if (prepared.kind !== 'prepared') return;
  assert.equal(prepared.lifecycles[1]?.appendBoundaries, undefined);
});

test('a cap overflow clears cuts instead of blocking the admission', () => {
  const atCap = Array.from({ length: MAX_LIFECYCLE_APPEND_BOUNDARIES }, (_, index) => ({
    inputMessageId: `old-${index}`,
    contentOffset: index,
    prefixSha256: 'a'.repeat(64),
  }));
  const withFullProof = response({
    lifecycle: {
      ...response().lifecycle,
      appendBoundaries: atCap,
    } as NonNullable<StoredMessage['lifecycle']>,
  });
  const prepared = prepareLifecycleAppendAdmission([input('input-new'), withFullProof], {
    threadId: 'thread-1',
    entryId: 'entry-new',
    inputMessageIds: ['input-new'],
    runs: [
      {
        targetId: 'codex',
        invocationId: 'inv-1',
        responseMessageId: 'response-1',
        dispatchedAt: 3,
        appendBoundary: boundary(200, 'b'.repeat(64)),
      },
    ],
  });

  assert.equal(prepared.kind, 'prepared');
  if (prepared.kind !== 'prepared') return;
  assert.equal(prepared.lifecycles[1]?.appendBoundaries, undefined);
});

test('admission order is preserved for equal offsets', () => {
  const prepared = prepareLifecycleAppendAdmission([input('input-z'), input('input-a'), response()], {
    threadId: 'thread-1',
    entryId: 'entry-equal',
    inputMessageIds: ['input-z', 'input-a'],
    runs: [
      {
        targetId: 'codex',
        invocationId: 'inv-1',
        responseMessageId: 'response-1',
        dispatchedAt: 3,
        appendBoundary: boundary(5, 'c'.repeat(64)),
      },
    ],
  });

  assert.equal(prepared.kind, 'prepared');
  if (prepared.kind !== 'prepared') return;
  assert.deepEqual(
    prepared.lifecycles[2]?.appendBoundaries?.map((entry) => entry.inputMessageId),
    ['input-z', 'input-a'],
  );
});

test('projected wake coverage carries the admission boundary', () => {
  const source = input('input-2', { deliveryStatus: 'delivered' });
  const entry = {
    id: 'entry-2',
    kind: 'message_wake',
    threadId: 'thread-1',
    targets: ['codex'],
    status: 'queued',
    owner: { kind: 'user', userId: 'operator' },
    payload: { messageId: 'input-2' },
    from: { kind: 'agent', catId: dsh },
    sourceCategory: 'a2a',
    execution: {},
    delivery: {},
  };
  const receiver = response();
  const prepared = prepareLifecycleWakeCoverage([source], receiver, [entry] as never, {
    threadId: 'thread-1',
    userId: 'operator',
    targetId: 'codex',
    invocationId: 'inv-1',
    responseMessageId: 'response-1',
    entries: [{ entryId: 'entry-2', messageId: 'input-2' }],
    at: 2,
    appendBoundary: boundary(5, 'a'.repeat(64)),
  });

  assert.equal(prepared.kind, 'prepared', JSON.stringify(prepared));
  if (prepared.kind !== 'prepared') return;
  assert.deepEqual(prepared.messages[1]?.lifecycle?.appendBoundaries, [
    { inputMessageId: 'input-2', contentOffset: 5, prefixSha256: 'a'.repeat(64) },
  ]);
});

test('invalid boundary input fails closed', () => {
  const prepared = prepareLifecycleAppendAdmission([input('input-2'), response()], {
    threadId: 'thread-1',
    entryId: 'entry-2',
    inputMessageIds: ['input-2'],
    runs: [
      {
        targetId: 'codex',
        invocationId: 'inv-1',
        responseMessageId: 'response-1',
        dispatchedAt: 2,
        appendBoundary: boundary(-1, 'a'.repeat(64)),
      },
    ],
  });
  assert.equal(prepared.kind, 'conflict');
});

test('legacy response metadata without appendBoundaries still validates', () => {
  const legacy = response().lifecycle;
  assert.equal(isLifecycleStoredMessageMetadata(legacy), true);
  assert.equal(
    isLifecycleStoredMessageMetadata({
      ...legacy,
      appendBoundaries: [{ inputMessageId: 'input-2', contentOffset: 5, prefixSha256: 'a'.repeat(64) }],
    }),
    true,
  );
  assert.equal(
    isLifecycleStoredMessageMetadata({
      ...legacy,
      appendBoundaries: [{ inputMessageId: 'input-2', contentOffset: 5, prefixSha256: 'not-a-hash' }],
    }),
    false,
  );
  assert.equal(
    isLifecycleStoredMessageMetadata({
      ...legacy,
      appendBoundaries: [
        { inputMessageId: 'input-2', contentOffset: 5, prefixSha256: 'a'.repeat(64) },
        { inputMessageId: 'input-2', contentOffset: 6, prefixSha256: 'b'.repeat(64) },
      ],
    }),
    false,
  );
});

test('terminal settlement preserves the admission cuts', () => {
  const withBoundaries = response({
    lifecycle: {
      ...response().lifecycle,
      appendBoundaries: [{ inputMessageId: 'input-2', contentOffset: 5, prefixSha256: 'a'.repeat(64) }],
    } as NonNullable<StoredMessage['lifecycle']>,
  });
  const terminal = prepareLifecycleResponseTerminalMessage(withBoundaries, {
    invocationId: 'inv-1',
    status: 'completed',
    completedAt: 10,
    content: 'body',
    mentions: [],
  });
  assert.equal(terminal.lifecycle?.kind, 'response');
  assert.deepEqual(terminal.lifecycle?.appendBoundaries, [
    { inputMessageId: 'input-2', contentOffset: 5, prefixSha256: 'a'.repeat(64) },
  ]);
});

test('InvocationTracker cursor is exact-run, replaceable, and cleared on terminal', () => {
  const tracker = new InvocationTracker();
  tracker.start('thread-1', 'codex', 'operator', ['codex'], 'exec-1');
  assert.equal(
    tracker.bindLifecycleActiveRun(
      {
        threadId: 'thread-1',
        targetId: 'codex',
        invocationId: 'inv-1',
        responseMessageId: 'response-1',
        inputEntryIds: ['entry-1'],
        inputMessageIds: ['input-1'],
        privateInputEntryIds: [],
        startedAt: 1,
      },
      'exec-1',
    ),
    true,
  );

  const exact = { invocationId: 'inv-1', responseMessageId: 'response-1' };
  const first = tracker.bindLifecycleOutputCursor('thread-1', 'codex', exact, () => 'first');
  assert.ok(first);
  assert.equal(tracker.getLifecycleOutputCursor('thread-1', 'codex', exact)?.(), 'first');
  assert.equal(
    tracker.getLifecycleOutputCursor('thread-1', 'codex', { invocationId: 'inv-1', responseMessageId: 'other' }),
    undefined,
  );

  const second = tracker.bindLifecycleOutputCursor('thread-1', 'codex', exact, () => 'second');
  assert.ok(second);
  first?.();
  assert.equal(tracker.getLifecycleOutputCursor('thread-1', 'codex', exact)?.(), 'second');

  tracker.complete('thread-1', 'codex');
  assert.equal(tracker.getLifecycleOutputCursor('thread-1', 'codex', exact), undefined);
  second?.();
});
