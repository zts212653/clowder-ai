import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCatId } from '@cat-cafe/shared';
import { MessageStore } from '../src/domains/cats/services/stores/ports/MessageStore.js';
import { LiveBoundaryContexts } from '../src/domains/concierge/live/host/live-boundary-contexts.js';
import { LiveContextGate } from '../src/domains/concierge/live/host/live-controlled-context.js';
import type { LiveMeetingDependencies } from '../src/domains/concierge/live/host/live-meeting-host.js';
import type { LiveCompanionCallOptions } from '../src/domains/concierge/live/live-call-options.js';
import type { F317MeetingGrant } from '../src/domains/concierge/meeting/f317-meeting-admission.js';
import { projectF195Context } from '../src/domains/concierge/meeting/f317-meeting-artifact.js';

test('call close releases meeting attach while final owner verification is unresolved', async () => {
  const binding = { userId: 'owner', threadId: 'home', catId: createCatId('codex-astra'), callId: 'call-1' };
  const options: LiveCompanionCallOptions = {
    binding,
    messageStore: new MessageStore(),
    mcpDistDir: '/unused',
    allowedDirectories: [],
    verifyNativeBinding: async () => true,
    publish() {},
  };
  const gate = new LiveContextGate({
    binding,
    acceptsInput: () => true,
    matchesInvocation: (query) => query.invocationId === 'invocation',
    householdToolsEnabled: () => true,
    verifyCompanion: async () => true,
    client: () => undefined,
    run: (operation) => operation(),
  });
  const contexts = new LiveBoundaryContexts(
    options,
    gate,
    () => {},
    () => false,
  );
  contexts.configure({ CAT_CAFE_INVOCATION_ID: 'invocation' });
  const grant: F317MeetingGrant = {
    grantId: 'grant-1',
    userId: binding.userId,
    liveThreadId: binding.threadId,
    catId: binding.catId,
    callId: binding.callId,
    generation: 1,
    captureThreadId: 'capture',
    meetingId: 'mtg-1',
    captureStartedAt: 1_790_000_000,
    inputId: 'app-1',
    inputLabel: 'Meeting App',
    signal: new AbortController().signal,
  };
  const deps: LiveMeetingDependencies = {
    source: {
      bind: () => ({
        epoch: 1,
        cursor: 0,
        refresh: async () => ({ state: 'ready', cursor: 0, delivered: 0 }),
        close() {},
      }),
    },
    wakeSource: { subscribe: async () => ({ close() {} }) },
  };
  let releaseFinal!: (value: boolean) => void;
  const finalCheck = new Promise<boolean>((resolve) => {
    releaseFinal = resolve;
  });
  let enterFinal!: () => void;
  const finalEntered = new Promise<void>((resolve) => {
    enterFinal = resolve;
  });
  let checks = 0;
  const attached = contexts.attachMeeting(
    grant,
    () => {
      checks++;
      if (checks === 2) {
        enterFinal();
        return finalCheck;
      }
      return Promise.resolve(true);
    },
    deps,
  );
  void attached.catch(() => {});
  await finalEntered;
  contexts.close();
  gate.close('stopped');
  const stopOutcome = await Promise.race([
    attached.then(
      () => 'accepted',
      () => 'rejected',
    ),
    new Promise((resolve) => setTimeout(() => resolve('pending'), 100)),
  ]);
  releaseFinal(true);
  await assert.rejects(attached, /not_admitted/);
  assert.equal(stopOutcome, 'rejected');
});

test('a pending meeting attach cannot expose replayed transcript before promotion', async () => {
  const binding = { userId: 'owner', threadId: 'home', catId: createCatId('codex-astra'), callId: 'call-1' };
  const options: LiveCompanionCallOptions = {
    binding,
    messageStore: new MessageStore(),
    mcpDistDir: '/unused',
    allowedDirectories: [],
    verifyNativeBinding: async () => true,
    publish() {},
  };
  let writes = 0;
  const gate = new LiveContextGate({
    binding,
    acceptsInput: () => true,
    matchesInvocation: (query) => query.invocationId === 'invocation',
    householdToolsEnabled: () => true,
    verifyCompanion: async () => true,
    client: () => ({
      request: async () => ({}),
      submitText: async () => 'unused',
      submitContextAtBoundary: async (_text, _refs, kind, _signal, authorize) => {
        assert.equal(kind, 'meeting_context');
        assert.equal(await authorize(), true);
        writes++;
        return 'accepted-turn';
      },
    }),
    run: (operation) => operation(),
  });
  const contexts = new LiveBoundaryContexts(
    options,
    gate,
    () => {},
    () => false,
  );
  contexts.configure({ CAT_CAFE_INVOCATION_ID: 'invocation' });
  const grant: F317MeetingGrant = {
    grantId: 'pending-grant',
    userId: binding.userId,
    liveThreadId: binding.threadId,
    catId: binding.catId,
    callId: binding.callId,
    generation: 1,
    captureThreadId: 'capture',
    meetingId: 'mtg-1',
    captureStartedAt: 1_790_000_000,
    inputId: 'app-1',
    inputLabel: 'Meeting App',
    signal: new AbortController().signal,
  };
  const item = projectF195Context(
    {
      cursor: 1,
      chunkNum: 1,
      revision: 1,
      operation: 'transcript',
      line: { ts: 1_790_000_001, chunk_num: 1, text: '私密会议内容' },
    },
    { threadId: grant.captureThreadId, meetingId: grant.meetingId, callId: grant.callId, generation: grant.generation },
    'transcript-mtg-1.lines.jsonl',
    1,
  );
  const source: LiveMeetingDependencies['source'] = {
    bind: (_binding, callbacks) => ({
      epoch: 1,
      cursor: 0,
      refresh: async () => {
        await callbacks.onContext(item, new AbortController().signal);
        return { state: 'ready', cursor: 1, delivered: 1 };
      },
      close() {},
    }),
  };
  let rejectSubscription!: (error: Error) => void;
  const subscribing = new Promise<{ close(): void }>((_resolve, reject) => {
    rejectSubscription = reject;
  });
  let entered!: () => void;
  const subscribeEntered = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const attached = contexts.attachMeeting(grant, async () => true, {
    source,
    wakeSource: {
      subscribe: () => {
        entered();
        return subscribing;
      },
    },
  });
  void attached.catch(() => {});
  await subscribeEntered;
  contexts.onUserTurn();
  await contexts.atBoundary('idle');
  assert.equal(writes, 0, 'pending owner POST cannot expose replayed private transcript');
  assert.equal(contexts.isMeetingAttached(grant), false);
  rejectSubscription(new Error('sse_failed'));
  await assert.rejects(attached);
  assert.equal(writes, 0, 'failed attach cannot leak its initial replay');

  const admitted = { ...grant, grantId: 'admitted-grant' };
  await contexts.attachMeeting(admitted, async () => true, {
    source,
    wakeSource: { subscribe: async () => ({ close() {} }) },
  });
  assert.equal(contexts.isMeetingAttached(admitted), true);
  contexts.onUserTurn();
  await contexts.atBoundary('idle');
  assert.equal(writes, 1, 'only a later user boundary consumes the promoted attachment');
  contexts.close();
  gate.close('test-complete');
});
