import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LiveContextGate } from '../src/domains/concierge/live/host/live-controlled-context.js';
import { bindLiveRecoveryHost } from '../src/domains/concierge/live/host/live-recovery-binding.js';
import { MessageLiveInboxSource } from '../src/domains/concierge/live/inbox/MessageLiveInboxSource.js';
import type { LiveCompanionCallOptions } from '../src/domains/concierge/live/live-call-options.js';
import { recoveryFixture, scope } from './helpers/f317-recovery-fixture.js';

test('cross-post recovery references the persisted receiving message', async () => {
  const f = recoveryFixture();
  const queue = f.queue;
  const from = { kind: 'agent' as const, catId: scope.catId };
  const admitted = await queue.send(
    f.messages,
    {
      userId: scope.userId,
      threadId: scope.threadId,
      from,
      content: 'cross-thread arrival',
      mentions: [scope.catId],
      timestamp: 1,
      deliveryStatus: 'queued',
      extra: { crossPost: { sourceThreadId: 'remote-thread', effectClass: 'coordinate' } },
    },
    {
      kind: 'conversation_input',
      threadId: scope.threadId,
      userId: scope.userId,
      from,
      ownerAuthProvenance: 'strict',
      content: 'cross-thread arrival',
      targetCats: [scope.catId],
      intent: 'coordinate',
      authorIntentByCatId: { [scope.catId]: { requested: 'continue_current', boundParentInvocationId: 'live-parent' } },
    },
  );
  assert.ok(admitted.message);
  const message = admitted.message;
  const canonical = f.messages.getById(message.id);
  assert.ok(canonical);
  const expectedRef = `${canonical.threadId}#${canonical.id}`;
  assert.notEqual(canonical.extra?.crossPost?.sourceThreadId, canonical.threadId);

  let recoveryRefs: readonly string[] = [];
  let recoveredSourceThread: string | undefined;
  let recoveredNextWork: boolean | undefined;

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
      submitContextAtBoundary: async (text, refs, kind, _signal, authorize) => {
        assert.equal(await authorize(), true);
        if (kind === 'recovery_context') {
          recoveryRefs = refs;
          const encoded = text.split('\n').at(-1);
          assert.ok(encoded);
          const envelope = JSON.parse(encoded);
          const snapshot = JSON.parse(envelope.text);
          recoveredSourceThread = snapshot.inbox.items[0]?.sourceThreadId;
          recoveredNextWork = snapshot.inbox.items[0]?.nextWork;
        }
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
    recovery: f.options,
    inbox: {
      source: () => new MessageLiveInboxSource({ store: f.messages, queue, authorize: async () => true }),
    },
  };
  const hostInput = {
    options,
    context,
    callbackEnv: { CAT_CAFE_INVOCATION_ID: scope.invocationId, CAT_CAFE_EXECUTION_ID: 'live-parent' },
    wakeNative() {},
    isSameCallExposure: () => false,
  };
  const recovery = bindLiveRecoveryHost(hostInput);
  assert.ok(recovery);
  assert.equal(await recovery.atBoundary(), 'accepted');
  assert.equal(
    recoveredNextWork,
    false,
    'recovery retains the exact parent policy instead of inventing successor work',
  );
  recovery.close();
  assert.deepEqual(recoveryRefs, [expectedRef]);
  assert.equal(recoveredSourceThread, 'remote-thread', 'origin attribution stays separate from the read anchor');
  context.close('test-complete');
});
