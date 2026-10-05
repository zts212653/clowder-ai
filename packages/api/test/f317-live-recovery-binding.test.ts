import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CodexLiveNativeClient } from '../src/domains/cats/services/agents/providers/CodexLiveRunPort.js';
import { ThreadStore } from '../src/domains/cats/services/stores/ports/ThreadStore.js';
import { ConciergeThreadService } from '../src/domains/concierge/ConciergeThreadService.js';
import { LiveBoundaryContexts } from '../src/domains/concierge/live/host/live-boundary-contexts.js';
import { LiveContextGate } from '../src/domains/concierge/live/host/live-controlled-context.js';
import { bindLiveRecoveryHost } from '../src/domains/concierge/live/host/live-recovery-binding.js';
import type { LiveInboxSource } from '../src/domains/concierge/live/inbox/live-inbox-contract.js';
import type { LiveCompanionCallOptions } from '../src/domains/concierge/live/live-call-options.js';
import { recoveryFixture, scope } from './helpers/f317-recovery-fixture.js';

const binding = { userId: scope.userId, threadId: scope.threadId, catId: scope.catId, callId: scope.callId };
type NativeContext = NonNullable<CodexLiveNativeClient['submitContextAtBoundary']>;

function gateFor(submitContextAtBoundary: NativeContext, acceptsInput: () => boolean = () => true): LiveContextGate {
  return new LiveContextGate({
    binding,
    acceptsInput,
    matchesInvocation: (query) => query.invocationId === scope.invocationId,
    householdToolsEnabled: () => true,
    verifyCompanion: async () => true,
    run: (operation) => operation(),
    client: () => ({ request: async () => ({}), submitText: async () => 'unused', submitContextAtBoundary }),
  });
}

test('pre-talking wake leaves the initial recovery page for the first eligible native boundary', async () => {
  const f = recoveryFixture();
  f.task('unfinished work at call start');
  let talking = false;
  let writes = 0;
  const gate = gateFor(
    async (_text, _refs, kind, _signal, authorize) => {
      assert.equal(await authorize(), true);
      assert.equal(kind, 'recovery_context');
      writes++;
      return 'accepted-turn';
    },
    () => talking,
  );
  const contexts = new LiveBoundaryContexts(
    optionsFor(f),
    gate,
    () => {},
    () => false,
  );
  contexts.configure({ CAT_CAFE_INVOCATION_ID: scope.invocationId });
  await contexts.atBoundary('idle');
  assert.equal(writes, 0, 'ready/preparing cannot consume the recovery ticket');
  talking = true;
  assert.equal(contexts.hasPendingWake(), true);
  await contexts.atBoundary('idle');
  assert.equal(writes, 1);
  contexts.close();
});

test('a preparing-state busy inbox cannot consume the recovery ticket', async () => {
  const f = recoveryFixture();
  f.task('work still needs recovery');
  let talking = false;
  let unread = true;
  const nativeKinds: string[] = [];
  const reference = {
    messageId: 'incoming-before-ready',
    queueEntryId: 'queue-before-ready',
    threadId: scope.threadId,
    sourceThreadId: 'source',
    authorCatId: 'codex-sol',
    targetCatId: scope.catId,
    priority: 'normal' as const,
    order: '0001:incoming-before-ready',
    nextWork: false,
    facts: {
      persisted: true as const,
      notified: false,
      readByInvocationIds: [],
      readInCurrentContext: false,
      handled: false,
      playback: 'unknown' as const,
    },
  };
  const gate = gateFor(
    async (_text, _refs, kind, _signal, authorize) => {
      assert.equal(await authorize(), true);
      nativeKinds.push(kind);
      return 'accepted-turn';
    },
    () => talking,
  );
  const contexts = new LiveBoundaryContexts(
    optionsFor(f, async () => true, {
      page: async () => ({ items: unread ? [reference] : [], hasMore: false }),
      read: async () => (unread ? reference : null),
    }),
    gate,
    () => {},
    () => false,
  );
  contexts.configure({ CAT_CAFE_INVOCATION_ID: scope.invocationId });
  await contexts.atBoundary('idle');
  assert.deepEqual(nativeKinds, []);
  unread = false;
  talking = true;
  await contexts.atBoundary('idle');
  assert.deepEqual(nativeKinds, ['recovery_context']);
  contexts.close();
});

function optionsFor(
  f: ReturnType<typeof recoveryFixture>,
  authorize: () => Promise<boolean> = async () => true,
  source: LiveInboxSource = f.inbox,
): LiveCompanionCallOptions {
  return {
    binding,
    messageStore: f.messages,
    mcpDistDir: '/unused',
    allowedDirectories: [],
    verifyNativeBinding: async () => true,
    publish() {},
    inbox: { source: () => source, onSuccessorRequired: async () => {} },
    recovery: { tasks: f.tasks, approvals: f.approvals, messages: f.messages, epochs: f.epochs, authorize },
  };
}

test('recovery uses source-backed data at a native boundary, with owner authority at the final write', async () => {
  const f = recoveryFixture();
  const task = f.task('unfinished source-backed work');
  let ownerAllowed = true;
  let revokeAtNative = false;
  let writes = 0;
  let written = '';
  const gate = gateFor(async (text, refs, kind, _signal, authorize) => {
    if (revokeAtNative) ownerAllowed = false;
    if (!(await authorize())) throw new Error('owner source revoked before native write');
    assert.equal(kind, 'recovery_context');
    assert.deepEqual(refs, [`task:${task.id}`]);
    written = text;
    writes++;
    return 'accepted-turn';
  });
  const options = optionsFor(f, async () => ownerAllowed);
  const bind = () =>
    bindLiveRecoveryHost({
      options,
      context: gate,
      callbackEnv: { CAT_CAFE_INVOCATION_ID: scope.invocationId },
      wakeNative() {},
      isSameCallExposure: () => false,
    });
  const accepted = bind();
  assert.ok(accepted);
  assert.equal(await accepted.atBoundary(), 'accepted');
  assert.equal(writes, 1);
  assert.match(written, /unavailable_viewer_evidence/);
  assert.equal(await accepted.atBoundary(), 'idle', 'the generated turn cannot page its own recovery');
  accepted.close();

  revokeAtNative = true;
  const revoked = bind();
  assert.ok(revoked);
  await assert.rejects(revoked.atBoundary(), /owner source revoked/);
  assert.equal(writes, 1, 'revoked source never reaches a second native write');
  revoked.close();
});

test('recovery accepts only the current owner-indexed Concierge thread without creating one on read', async () => {
  const store = new ThreadStore();
  const service = new ConciergeThreadService({ threadStore: store });
  assert.equal(await service.isCurrent('owner', 'missing'), false);
  const threadId = await service.getOrCreate('owner');
  assert.equal(await service.isCurrent('owner', threadId), true);
  assert.equal(await service.isCurrent('other-owner', threadId), false);
  const thread = await store.get(threadId);
  assert.ok(thread);
  thread.createdBy = 'concierge-system';
  assert.equal(await service.isCurrent('owner', threadId), true, 'legacy user ownership comes from the index');
  await store.softDelete(threadId);
  assert.equal(await service.isCurrent('owner', threadId), false);
});

test('an empty inbox leaves its first safe boundary available for recovery without self paging', async () => {
  const f = recoveryFixture();
  f.task('one real item');
  let writes = 0;
  const gate = gateFor(async (_text, _refs, kind, _signal, authorize) => {
    assert.equal(await authorize(), true);
    assert.equal(kind, 'recovery_context');
    writes++;
    return 'native-turn';
  });
  const contexts = new LiveBoundaryContexts(
    optionsFor(f),
    gate,
    () => {},
    () => false,
  );
  contexts.configure({ CAT_CAFE_INVOCATION_ID: scope.invocationId });
  await contexts.atBoundary('idle');
  assert.equal(writes, 1);
  await contexts.atBoundary('idle');
  assert.equal(writes, 1, 'no generated idle turn may page itself');
  contexts.close();
});

test('an accepted inbox notice cannot make its generated turn page recovery', async () => {
  const f = recoveryFixture();
  f.task('still open');
  const nativeKinds: string[] = [];
  const gate = gateFor(async (_text, _refs, kind, _signal, authorize) => {
    assert.equal(await authorize(), true);
    nativeKinds.push(kind);
    return 'native-turn';
  });
  const reference = {
    messageId: 'incoming',
    queueEntryId: 'queue-incoming',
    threadId: scope.threadId,
    sourceThreadId: 'source',
    authorCatId: 'codex-sol',
    targetCatId: scope.catId,
    priority: 'normal' as const,
    order: '0001:incoming',
    nextWork: false,
    facts: {
      persisted: true as const,
      notified: false,
      readByInvocationIds: [],
      readInCurrentContext: false,
      handled: false,
      playback: 'unknown' as const,
    },
  };
  const contexts = new LiveBoundaryContexts(
    optionsFor(f, async () => true, {
      page: async () => ({ items: [reference], hasMore: false }),
      read: async () => reference,
    }),
    gate,
    () => {},
    () => false,
  );
  contexts.configure({ CAT_CAFE_INVOCATION_ID: scope.invocationId });
  await contexts.atBoundary('tool_complete');
  assert.deepEqual(nativeKinds, ['inbox_notice']);
  await contexts.atBoundary('turn_complete');
  assert.deepEqual(nativeKinds, ['inbox_notice'], 'the notice-generated turn is not a new user ticket');
  contexts.onUserTurn();
  await contexts.atBoundary('tool_complete');
  assert.deepEqual(nativeKinds, ['inbox_notice', 'recovery_context']);
  contexts.close();
});

test('compaction after projection but before the native write revokes the recovery page', async () => {
  const f = recoveryFixture();
  f.task('old epoch item');
  await f.epochOwner.resolve({
    ...scope,
    disposition: { state: 'fresh', runtimeSessionId: 'native', evidenceRef: 'provider:fresh' },
  });
  let writes = 0;
  const gate = gateFor(async (_text, _refs, _kind, _signal, authorize) => {
    await f.epochOwner.observeCompaction({
      ...scope,
      event: { eventId: 'compact-after-read', runtimeSessionId: 'native', evidenceRef: 'provider:compact' },
    });
    if (!(await authorize())) throw new Error('epoch revoked before native write');
    writes++;
    return 'native-turn';
  });
  const host = bindLiveRecoveryHost({
    options: optionsFor(f),
    context: gate,
    callbackEnv: { CAT_CAFE_INVOCATION_ID: scope.invocationId },
    wakeNative() {},
    isSameCallExposure: () => false,
  });
  assert.ok(host);
  await assert.rejects(host.atBoundary(), /epoch revoked/);
  assert.equal(writes, 0);
  host.close();
});

test('a real V3 user transcript revokes in-flight recovery and preserves its next user ticket', async () => {
  const f = recoveryFixture();
  f.task('source-backed work');
  let firstSignal: AbortSignal | undefined;
  let beginFirstWrite = () => {};
  const firstWriteStarted = new Promise<void>((resolve) => {
    beginFirstWrite = resolve;
  });
  let writes = 0;
  const gate = gateFor(async (_text, _refs, _kind, signal, authorize) => {
    if (!firstSignal) {
      firstSignal = signal;
      beginFirstWrite();
      return new Promise<string>(() => {});
    }
    assert.equal(await authorize(), true);
    writes++;
    return 'native-turn';
  });
  const contexts = new LiveBoundaryContexts(
    optionsFor(f),
    gate,
    () => {},
    () => false,
  );
  contexts.configure({ CAT_CAFE_INVOCATION_ID: scope.invocationId });
  const firstBoundary = contexts.atBoundary('tool_complete');
  try {
    await firstWriteStarted;
    contexts.observe({ method: 'thread/realtime/transcript/delta', params: { role: 'user', delta: '先等我说完' } });
    assert.equal(firstSignal?.aborted, true, 'the first user delta must revoke the pending provider write');
    await firstBoundary;
    contexts.observe({ method: 'thread/realtime/transcript/done', params: { role: 'user', text: '先等我说完' } });
    await contexts.atBoundary('tool_complete');
    assert.equal(writes, 1, 'the retained source resumes on the next real user boundary');
  } finally {
    contexts.close();
    await firstBoundary;
  }
});
