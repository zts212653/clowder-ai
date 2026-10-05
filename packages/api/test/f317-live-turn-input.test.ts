import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CodexLiveTurnInput,
  LIVE_CONTEXT_TRIGGER,
} from '../src/domains/cats/services/agents/providers/CodexLiveTurnInput.js';
import { CodexAppServerRpcError } from '../src/domains/cats/services/agents/providers/codex-app-server-rpc-error.js';
import type { PreparedIdleFreshnessNotice } from '../src/domains/cats/services/freshness/FreshnessNoticeBroker.js';
import type { LiveProviderInputOutcome, PreparedProviderRequestV1 } from '../src/domains/cats/services/types.js';

const notice: PreparedIdleFreshnessNotice = {
  noticeId: 'notice',
  text: 'read current thread full',
  frontier: 'source',
  correlationMessageIds: ['source'],
  boundary: { threadId: 'home', toolSurface: 'other' },
  provider: 'openai_codex',
  carrier: 'codex_app_server',
  deliverySemantics: 'queued_internal_turn',
};

test('a rejected empty-input race defers; accepted idle transport remains accepted after telemetry failure', async () => {
  let reject = true;
  let deferred = 0;
  let delivered = 0;
  const input = new CodexLiveTurnInput({
    enqueue() {},
    isOpen: () => true,
    request: async () => {
      if (reject) throw new CodexAppServerRpcError({ method: 'turn/start', code: -32600, message: 'Empty input' });
      return { turn: { id: 'real-native-turn' } };
    },
  });
  const idle = {
    prepare: async () => notice,
    defer: () => {
      deferred++;
    },
    markMissed: async () => assert.fail('not missed'),
    commitDelivered: async () => {
      delivered++;
      throw new Error('telemetry offline');
    },
  };
  assert.equal(await input.startIdle('native', idle), null);
  assert.equal(deferred, 1);
  reject = false;
  assert.equal(await input.startIdle('native', idle), 'real-native-turn');
  assert.equal(delivered, 1);
});

test('each prepared Live input records its actual native acceptance, rejection, or cancellation', async () => {
  let open = true;
  let reject = true;
  let cancelAfterCommit = false;
  let ordinal = 0;
  let requests = 0;
  const queue: unknown[] = [];
  const outcomes: LiveProviderInputOutcome[] = [];
  const input = new CodexLiveTurnInput({
    enqueue: (value) => queue.push(value),
    isOpen: () => open,
    prepare: (value): PreparedProviderRequestV1 => ({
      v: 1,
      message: { body: value.kind === 'text' ? value.text : '' },
      nativeInstructions:
        value.kind === 'notice' ? [{ body: value.text, injectionDecision: 'app_server_live_freshness_context' }] : [],
      runtime: { provider: 'openai' },
      tools: { finalSurface: 'unknown' },
      providerNativeVisibility: 'unknown',
    }),
    commit: async () => {
      if (cancelAfterCommit) open = false;
      ordinal++;
      return { requestGenerationId: `request-${ordinal}`, generationOrdinal: ordinal, sessionId: 'session' };
    },
    outcome: async (receipt) => {
      outcomes.push(receipt);
      if (receipt.outcome === 'accepted') throw new Error('telemetry write failed');
    },
    request: async () => {
      requests++;
      if (reject) throw new CodexAppServerRpcError({ method: 'turn/start', code: -32600, message: 'EmptyInput' });
      return { turn: { id: 'accepted-native-id' } };
    },
  });
  const idle = {
    prepare: async () => notice,
    defer() {},
    markMissed: async () => assert.fail('not missed'),
    commitDelivered: async () => {},
  };
  assert.equal(await input.startIdle('native', idle), null);
  reject = false;
  assert.equal(await input.startIdle('native', idle), 'accepted-native-id');
  cancelAfterCommit = true;
  const receipt = input.submitText('typed', 'message');
  const rejected = assert.rejects(receipt, /Live call ended/);
  assert.ok(input.isSubmission(queue[0]));
  assert.equal(await input.sendText(queue[0], 'native', null), null);
  await rejected;
  assert.equal(requests, 2, 'cancelled prepared input must not reach the provider');
  assert.deepEqual(
    outcomes.map((value) => [value.request.requestGenerationId, value.outcome, value.nativeTurnId]),
    [
      ['request-1', 'rejected', undefined],
      ['request-2', 'accepted', 'accepted-native-id'],
      ['request-3', 'cancelled', undefined],
    ],
  );
});

test('stop during request-recording prevents native submission and settles its queued sender', async () => {
  const queue: unknown[] = [];
  let open = true;
  let requests = 0;
  const input = new CodexLiveTurnInput({
    enqueue: (value) => queue.push(value),
    isOpen: () => open,
    request: async () => {
      requests++;
      return {};
    },
    prepare: () => ({
      v: 1,
      message: { body: 'typed' },
      nativeInstructions: [],
      runtime: { provider: 'openai' },
      tools: { finalSurface: 'unknown' },
      providerNativeVisibility: 'unknown',
    }),
    commit: async () => {
      open = false;
      throw new Error('recording cancelled');
    },
  });
  const receipt = input.submitText('typed', 'source');
  const rejected = assert.rejects(receipt, /recording cancelled/);
  const value = queue[0];
  assert.ok(input.isSubmission(value));
  assert.equal(await input.sendText(value, 'native', null), null);
  await rejected;
  assert.equal(requests, 0);
});

test('application context uses the exact active turn, and revocation before native write keeps it unaccepted', async () => {
  const queue: unknown[] = [];
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const outcomes: LiveProviderInputOutcome[] = [];
  let releaseCommit!: () => void;
  const committed = new Promise<void>((resolve) => {
    releaseCommit = resolve;
  });
  let enteredCommit!: () => void;
  const entering = new Promise<void>((resolve) => {
    enteredCommit = resolve;
  });
  const input = new CodexLiveTurnInput({
    enqueue: (value) => queue.push(value),
    isOpen: () => true,
    prepare: (value): PreparedProviderRequestV1 => ({
      v: 1,
      message: { body: LIVE_CONTEXT_TRIGGER },
      nativeInstructions: [{ body: value.text, injectionDecision: 'app_server_live_context' }],
      runtime: { provider: 'openai' },
      tools: { finalSurface: 'unknown' },
      providerNativeVisibility: 'unknown',
    }),
    commit: async () => {
      enteredCommit();
      await committed;
      return { requestGenerationId: 'context-generation', generationOrdinal: 1, sessionId: 'session' };
    },
    outcome: async (receipt) => {
      outcomes.push(receipt);
    },
    request: async (method, params) => {
      calls.push({ method, params });
      return { turnId: 'active-turn' };
    },
  });
  const controller = new AbortController();
  const receipt = input.submitContextAtBoundary(
    'A bounded source notice',
    ['message-1'],
    'inbox_notice',
    controller.signal,
    async () => true,
    'native-thread',
    'active-turn',
  );
  const rejected = assert.rejects(receipt, /cancel/i);
  await entering;
  controller.abort('cancelled');
  releaseCommit();
  await rejected;
  assert.deepEqual(queue, []);
  assert.deepEqual(calls, [], 'an old generation must not write after the recording boundary');
  assert.equal(outcomes[0]?.outcome, 'cancelled');
});

test('accepted context records native identity while source data stays out of user input', async () => {
  const queue: unknown[] = [];
  const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
  const outcomes: LiveProviderInputOutcome[] = [];
  const input = new CodexLiveTurnInput({
    enqueue: (value) => queue.push(value),
    isOpen: () => true,
    prepare: (value): PreparedProviderRequestV1 => ({
      v: 1,
      message: { body: LIVE_CONTEXT_TRIGGER },
      nativeInstructions: [{ body: value.text, injectionDecision: 'app_server_live_context' }],
      runtime: { provider: 'openai' },
      tools: { finalSurface: 'unknown' },
      providerNativeVisibility: 'unknown',
    }),
    commit: async () => ({ requestGenerationId: 'context', generationOrdinal: 1, sessionId: 'session' }),
    outcome: async (receipt) => {
      outcomes.push(receipt);
    },
    request: async (method, params) => {
      requests.push({ method, params });
      return method === 'turn/start' ? { turn: { id: 'idle-turn' } } : { turnId: 'active-turn' };
    },
  });
  const signal = new AbortController().signal;
  const idleReceipt = input.submitContextAtBoundary(
    'Read exact source',
    ['thread_home#source'],
    'inbox_notice',
    signal,
    async () => true,
    'native-thread',
    null,
  );
  assert.equal(await idleReceipt, 'idle-turn');
  assert.equal(requests[0]?.method, 'turn/start');
  assert.equal(requests[0]?.params.turnTrigger, 'live_context');
  assert.deepEqual(requests[0]?.params.input, [{ type: 'text', text: LIVE_CONTEXT_TRIGGER }]);
  assert.deepEqual(requests[0]?.params.additionalContext, {
    'cat-cafe.live-context': { kind: 'application', value: 'Read exact source' },
  });
  const activeReceipt = input.submitContextAtBoundary(
    'Next source',
    ['thread_home#next'],
    'meeting_context',
    signal,
    async () => true,
    'native-thread',
    'active-turn',
  );
  assert.equal(await activeReceipt, 'active-turn');
  assert.deepEqual(queue, []);
  assert.equal(requests[1]?.method, 'turn/steer');
  assert.equal(requests[1]?.params.expectedTurnId, 'active-turn');
  assert.deepEqual(requests[1]?.params.input, [{ type: 'text', text: LIVE_CONTEXT_TRIGGER }]);
  assert.deepEqual(requests[1]?.params.additionalContext, {
    'cat-cafe.live-context': { kind: 'untrusted', value: 'Next source' },
  });
  const recoveryReceipt = input.submitContextAtBoundary(
    'Source-backed recovery page',
    ['task:task-1'],
    'recovery_context',
    signal,
    async () => true,
    'native-thread',
    'active-turn',
  );
  assert.equal(await recoveryReceipt, 'active-turn');
  assert.deepEqual(requests[2]?.params.additionalContext, {
    'cat-cafe.live-context': { kind: 'application', value: 'Source-backed recovery page' },
  });
  assert.deepEqual(
    outcomes.map((item) => [item.outcome, item.nativeTurnId]),
    [
      ['accepted', 'idle-turn'],
      ['accepted', 'active-turn'],
      ['accepted', 'active-turn'],
    ],
  );
});

test('a native safe boundary can write context inline without waiting for its own notification queue', async () => {
  const queue: unknown[] = [];
  const requests: string[] = [];
  const input = new CodexLiveTurnInput({
    enqueue: (value) => queue.push(value),
    isOpen: () => true,
    prepare: (value): PreparedProviderRequestV1 => ({
      v: 1,
      message: { body: LIVE_CONTEXT_TRIGGER },
      nativeInstructions: [{ body: value.text, injectionDecision: 'app_server_live_context' }],
      runtime: { provider: 'openai' },
      tools: { finalSurface: 'unknown' },
      providerNativeVisibility: 'unknown',
    }),
    request: async (method) => {
      requests.push(method);
      return { turnId: 'turn-1' };
    },
  });
  assert.equal(
    await input.submitContextAtBoundary(
      'notice',
      ['thread_home#message-1'],
      'inbox_notice',
      new AbortController().signal,
      async () => true,
      'native-thread',
      'turn-1',
    ),
    'turn-1',
  );
  assert.deepEqual(queue, []);
  assert.deepEqual(requests, ['turn/steer']);
});
