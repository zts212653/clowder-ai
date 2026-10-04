import assert from 'node:assert/strict';
import { test } from 'node:test';
import { InvocationQueue } from '../src/domains/cats/services/agents/invocation/InvocationQueue.js';
import { createInitialQueuedMessageCustody } from '../src/domains/cats/services/agents/invocation/QueuedMessageCustodyCoordinator.js';
import { LiveContextGate } from '../src/domains/concierge/live/host/live-controlled-context.js';
import { bindLiveInboxHost } from '../src/domains/concierge/live/host/live-inbox-host.js';
import { LiveRecoveryHost } from '../src/domains/concierge/live/host/live-recovery-host.js';
import { MessageLiveInboxSource } from '../src/domains/concierge/live/inbox/MessageLiveInboxSource.js';
import type { LiveCompanionCallOptions } from '../src/domains/concierge/live/live-call-options.js';
import { LiveRecoveryReader } from '../src/domains/concierge/live/recovery/LiveRecoveryReader.js';
import { recoveryFixture, scope } from './helpers/f317-recovery-fixture.js';

test('cross-post notice and recovery reference the persisted receiving message', async () => {
  const f = recoveryFixture();
  const queue = new InvocationQueue();
  const entry = queue.enqueue({
    threadId: scope.threadId,
    userId: scope.userId,
    source: 'agent',
    ownerAuthProvenance: 'strict',
    content: 'cross-thread arrival',
    targetCats: [scope.catId],
    intent: 'coordinate',
  }).entry;
  assert.ok(entry);
  const message = f.messages.append({
    userId: scope.userId,
    threadId: scope.threadId,
    catId: scope.catId,
    content: 'cross-thread arrival',
    mentions: [scope.catId],
    timestamp: 1,
    deliveryStatus: 'queued',
    queueCustody: createInitialQueuedMessageCustody(entry),
    extra: { crossPost: { sourceThreadId: 'remote-thread', effectClass: 'coordinate' } },
  });
  queue.backfillMessageId(scope.threadId, scope.userId, entry.id, message.id);
  const canonical = f.messages.getById(message.id);
  assert.ok(canonical);
  const expectedRef = `${canonical.threadId}#${canonical.id}`;
  assert.notEqual(canonical.extra?.crossPost?.sourceThreadId, canonical.threadId);

  let recoveryRefs: readonly string[] = [];
  let recoveredSourceThread: string | undefined;
  const recovery = new LiveRecoveryHost({
    scope,
    reader: new LiveRecoveryReader(f.options),
    validate: async () => true,
    deliver: async (payload) => {
      recoveryRefs = payload.sourceRefs;
      recoveredSourceThread = payload.snapshot.inbox.items[0]?.sourceThreadId;
      return 'accepted';
    },
  });
  assert.equal(await recovery.atBoundary(), 'accepted');
  recovery.close();

  let noticeRefs: readonly string[] = [];
  const binding = { userId: scope.userId, threadId: scope.threadId, catId: scope.catId, callId: scope.callId };
  const context = new LiveContextGate({
    binding,
    acceptsInput: () => true,
    matchesInvocation: (query) => query.invocationId === scope.invocationId,
    householdToolsEnabled: () => true,
    verifyCompanion: async () => true,
    client: () => ({
      request: async () => ({}),
      submitText: async () => 'unused',
      submitContextAtBoundary: async (_text, refs, _kind, _signal, authorize) => {
        assert.equal(await authorize(), true);
        noticeRefs = refs;
        return 'accepted-turn';
      },
    }),
    run: (operation) => operation(),
  });
  const options: LiveCompanionCallOptions = {
    binding,
    messageStore: f.messages,
    mcpDistDir: '/unused',
    allowedDirectories: [],
    verifyNativeBinding: async () => true,
    publish() {},
    inbox: {
      source: () => new MessageLiveInboxSource({ store: f.messages, queue, authorize: async () => true }),
      onSuccessorRequired: async () => {},
    },
  };
  const inbox = bindLiveInboxHost({
    options,
    context,
    callbackEnv: { CAT_CAFE_INVOCATION_ID: scope.invocationId },
    wakeNative() {},
    isSameCallExposure: () => false,
  });
  assert.ok(inbox);
  assert.equal(await inbox.atBoundary('idle'), 'accepted');
  assert.deepEqual({ recoveryRefs, noticeRefs }, { recoveryRefs: [expectedRef], noticeRefs: [expectedRef] });
  assert.equal(recoveredSourceThread, 'remote-thread', 'origin attribution stays separate from the read anchor');
  inbox.close();
  context.close('test-complete');
});
