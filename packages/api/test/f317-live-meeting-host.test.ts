import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCatId } from '@cat-cafe/shared';
import type { LiveControlledContext } from '../src/domains/concierge/live/host/live-controlled-context.js';
import { LiveMeetingHost } from '../src/domains/concierge/live/host/live-meeting-host.js';
import type { F317MeetingGrant } from '../src/domains/concierge/meeting/f317-meeting-admission.js';
import { type F317MeetingContext, projectF195Context } from '../src/domains/concierge/meeting/f317-meeting-artifact.js';

const scope = {
  userId: 'owner',
  threadId: 'home',
  catId: createCatId('codex-astra'),
  invocationId: 'invocation',
  callId: 'call-1',
  generation: 1,
};

function fixture() {
  const controller = new AbortController();
  const grant: F317MeetingGrant = {
    grantId: 'grant-1',
    userId: scope.userId,
    callId: scope.callId,
    liveThreadId: scope.threadId,
    catId: scope.catId,
    generation: scope.generation,
    captureThreadId: 'capture-thread',
    meetingId: 'mtg-1',
    captureStartedAt: 1_790_000_000,
    inputId: 'app-1',
    inputLabel: 'Meeting App',
    signal: controller.signal,
  };
  let onContext!: (item: F317MeetingContext, signal: AbortSignal) => Promise<void>;
  let sourceClosed = false;
  let wakeClosed = false;
  let wakes = 0;
  const source = {
    bind: (
      _binding: unknown,
      callbacks: { onContext(item: F317MeetingContext, signal: AbortSignal): Promise<void> },
    ) => {
      onContext = callbacks.onContext;
      return {
        epoch: 1,
        cursor: 0,
        refresh: async () => ({ state: 'ready' as const, cursor: 0, delivered: 0 }),
        close: () => {
          sourceClosed = true;
        },
      };
    },
  };
  const wakeSource = {
    subscribe: async () => ({
      close: () => {
        wakeClosed = true;
      },
    }),
  };
  const item = projectF195Context(
    {
      cursor: 1,
      chunkNum: 1,
      revision: 1,
      operation: 'transcript',
      line: { ts: 1_790_000_001, chunk_num: 1, text: '项目继续', speaker_label: 'Speaker 1' },
    },
    { threadId: grant.captureThreadId, meetingId: grant.meetingId, callId: grant.callId, generation: grant.generation },
    'transcript-mtg-1.lines.jsonl',
    1,
  );
  return {
    controller,
    grant,
    source,
    wakeSource,
    item,
    emit: () => onContext(item, new AbortController().signal),
    wakeNative: () => {
      wakes++;
    },
    get wakes() {
      return wakes;
    },
    get sourceClosed() {
      return sourceClosed;
    },
    get wakeClosed() {
      return wakeClosed;
    },
  };
}

test('meeting chunks only buffer; one explicit user ticket admits source-referenced private context', async () => {
  const f = fixture();
  const submitted: LiveControlledContext[] = [];
  const host = await LiveMeetingHost.attach({
    scope,
    grant: f.grant,
    verify: async () => true,
    source: f.source,
    wakeSource: f.wakeSource,
    wakeNative: f.wakeNative,
    inject: async (input) => {
      assert.equal(await input.authorizeSource?.(input.signal), true);
      submitted.push(input);
      return 'accepted';
    },
  });
  await f.emit();
  assert.equal(submitted.length, 0, 'an idle transcript chunk cannot create a provider turn');
  assert.equal(host.hasPendingWake(), false);
  host.onUserTurn();
  assert.ok(f.wakes > 0);
  assert.equal(await host.atBoundary(), 'accepted');
  assert.equal(submitted.length, 1);
  assert.equal(submitted[0]?.kind, 'meeting_context');
  assert.deepEqual(submitted[0]?.sourceRefs, [f.item.sourceRef]);
  assert.match(submitted[0]?.text ?? '', /recent_bounded_excerpt/);
  assert.equal(await host.atBoundary(), 'idle', 'a generated turn cannot replay the same chunk');
  host.close();
  assert.equal(f.sourceClosed, true);
  assert.equal(f.wakeClosed, true);
});

test('a transcript arriving after an empty user boundary cannot start another provider turn', async () => {
  const f = fixture();
  let submissions = 0;
  const host = await LiveMeetingHost.attach({
    scope,
    grant: f.grant,
    verify: async () => true,
    source: f.source,
    wakeSource: f.wakeSource,
    wakeNative: f.wakeNative,
    inject: async () => {
      submissions++;
      return 'accepted';
    },
  });
  host.onUserTurn();
  assert.equal(await host.atBoundary(), 'idle');
  const wakesBeforeChunk = f.wakes;
  await f.emit();
  assert.equal(host.hasPendingWake(), false);
  assert.equal(f.wakes, wakesBeforeChunk, 'the chunk must not open a turn after the question boundary');
  assert.equal(await host.atBoundary(), 'idle');
  assert.equal(submissions, 0);
  host.onUserTurn();
  assert.equal(await host.atBoundary(), 'accepted');
  assert.equal(submissions, 1);
  host.close();
});

test('revocation aborts a pending meeting context before its native write', async () => {
  const f = fixture();
  let nativeSignal: AbortSignal | undefined;
  let enterWrite = () => {};
  const entered = new Promise<void>((resolve) => {
    enterWrite = resolve;
  });
  const host = await LiveMeetingHost.attach({
    scope,
    grant: f.grant,
    verify: async () => !f.controller.signal.aborted,
    source: f.source,
    wakeSource: f.wakeSource,
    wakeNative: f.wakeNative,
    inject: async (input) => {
      nativeSignal = input.signal;
      enterWrite();
      return new Promise<'accepted'>(() => {});
    },
  });
  await f.emit();
  host.onUserTurn();
  const pending = host.atBoundary();
  await entered;
  f.controller.abort();
  assert.equal(nativeSignal?.aborted, true);
  assert.equal(await pending, 'cancelled');
  assert.equal(host.hasPendingWake(), false);
  assert.equal(f.sourceClosed, true);
});

test('a real user interruption cancels meeting delivery until the next user turn', async () => {
  const f = fixture();
  let entered!: () => void;
  const writing = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const delivered: string[] = [];
  let attempts = 0;
  const host = await LiveMeetingHost.attach({
    scope,
    grant: f.grant,
    verify: async () => true,
    source: f.source,
    wakeSource: f.wakeSource,
    wakeNative: f.wakeNative,
    inject: async (input) => {
      attempts++;
      if (attempts === 1) {
        entered();
        await new Promise<void>((resolve) => input.signal.addEventListener('abort', () => resolve(), { once: true }));
        throw new Error('cancelled');
      }
      delivered.push(input.sourceRefs[0] ?? 'missing');
      return 'accepted';
    },
  });
  await f.emit();
  host.onUserTurn();
  const first = host.atBoundary();
  await writing;
  host.onUserSpeaking();
  assert.equal(await first, 'cancelled');
  assert.equal(host.hasPendingWake(), false, 'speech cannot trigger a private turn');
  assert.equal(await host.atBoundary(), 'idle');
  host.onUserTurn();
  assert.equal(await host.atBoundary(), 'accepted');
  assert.deepEqual(delivered, [f.item.sourceRef]);
  host.close();
});

test('revocation releases a pending event-stream attach and closes a late stream', async () => {
  const f = fixture();
  let release!: (stream: { close(): void }) => void;
  const subscribing = new Promise<{ close(): void }>((resolve) => {
    release = resolve;
  });
  let lateClosed = false;
  const attached = LiveMeetingHost.attach({
    scope,
    grant: f.grant,
    verify: async () => true,
    source: f.source,
    wakeSource: { subscribe: () => subscribing },
    wakeNative: f.wakeNative,
    inject: async () => 'accepted',
  });
  await new Promise((resolve) => setImmediate(resolve));
  f.controller.abort();
  await assert.rejects(attached);
  assert.equal(f.sourceClosed, true);
  release({
    close: () => {
      lateClosed = true;
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(lateClosed, true);
});

test('closing a pending Host attachment releases an unresolved admission read', async () => {
  const f = fixture();
  let finishVerify!: (allowed: boolean) => void;
  const verification = new Promise<boolean>((resolve) => {
    finishVerify = resolve;
  });
  let pending!: LiveMeetingHost;
  const attached = LiveMeetingHost.attach(
    {
      scope,
      grant: f.grant,
      verify: () => verification,
      source: f.source,
      wakeSource: f.wakeSource,
      wakeNative: f.wakeNative,
      inject: async () => 'accepted',
    },
    (host) => {
      pending = host;
    },
  );
  void attached.catch(() => {});
  await new Promise((resolve) => setImmediate(resolve));
  pending.close();
  const stopOutcome = await Promise.race([
    attached.then(
      () => 'accepted',
      () => 'rejected',
    ),
    new Promise((resolve) => setTimeout(() => resolve('pending'), 100)),
  ]);
  finishVerify(true);
  await assert.rejects(attached);
  assert.equal(stopOutcome, 'rejected');
});
