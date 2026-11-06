import assert from 'node:assert/strict';
import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { mock, test } from 'node:test';
import { appendTestLifecycleResponseSource } from '../helpers/message-from-fixtures.js';
import { routingJourneyDeps } from '../helpers/routing-journey-deps.js';

const { AcpAgentService } = await import('../../dist/domains/cats/services/agents/providers/acp/AcpAgentService.js');
const { AcpProtocolError } = await import('../../dist/domains/cats/services/agents/providers/acp/AcpClient.js');
const { kimiSessionTurnLedgerPath } = await import(
  '../../dist/domains/cats/services/agents/providers/acp/kimi/kimi-turn-outcome.js'
);

const KIMI_NATIVE = {
  command: 'kimi',
  args: ['acp'],
  env: {},
  projectRoot: '/tmp',
  accountRef: 'kimi-test',
  packagePath: '/opt/kimi-code/package.json',
};

const QUOTA_ERROR = {
  code: 'provider.api_error',
  message:
    "429 You've reached your weekly (7-day) usage limit. Your quota will reset when the current 7-day window ends.",
  name: 'APIProviderQuotaExhaustedError',
  details: { statusCode: 429, requestId: null, traceId: 'trace-1' },
  retryable: false,
};

function turnEnded({ time = 1_000_100, reason = 'failed', error } = {}) {
  return { type: 'turn.ended', agentId: 'main', turnId: 0, reason, ...(error ? { error } : {}), time };
}

function ledgerText(entries) {
  return `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`;
}

/**
 * Native CLI ledger for one session. `cwd` is the session's effective workspace
 * (what the reader hashes); `spawnCwd` is the process bootstrap dir (deliberately
 * different when a test needs to prove which one the reader uses).
 */
async function kimiLedger({ sessionId, cwd = '/tmp', spawnCwd = cwd, shareDir, env, pre = [] }) {
  const root = shareDir ?? (await mkdtemp(join(tmpdir(), 'kimi-service-ledger-')));
  const path = kimiSessionTurnLedgerPath({ shareDir: root, cwd, sessionId });
  await mkdir(dirname(path), { recursive: true });
  if (pre.length > 0) await writeFile(path, ledgerText(pre), 'utf8');
  return {
    shareDir: root,
    path,
    spawnContext: { cwd: spawnCwd, env: env ?? { KIMI_CODE_HOME: root } },
    append: (entries) => appendFile(path, ledgerText(entries), 'utf8'),
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

function fixture({
  events = [],
  elapsedMs = 8_000,
  failure,
  freshEvents = events,
  stopReason = 'end_turn',
  onEnd,
  kimi,
} = {}) {
  let now = 1_000_000;
  const clock = mock.method(Date, 'now', () => now);
  const prompts = [];
  const client = {
    recentCapacitySignal: null,
    async newSession() {
      return { sessionId: 'fresh' };
    },
    async loadSession(sessionId) {
      return { sessionId };
    },
    async setSessionConfigOption() {},
    cancelSession() {},
    async *promptStream(sessionId) {
      prompts.push(sessionId);
      for (const update of sessionId === 'fresh' ? freshEvents : events) yield { sessionId, update };
      now += elapsedMs;
      await onEnd?.(sessionId);
      if (failure) throw failure;
      return typeof stopReason === 'function' ? stopReason(sessionId) : stopReason;
    },
    onCapacity() {},
    offCapacity() {},
    clearRecentCapacitySignal() {},
    ...(kimi ? { spawnContext: kimi } : {}),
  };
  const service = new AcpAgentService({
    catId: 'kimi',
    providerName: 'kimi',
    modelName: 'kimi-acp',
    projectRoot: '/tmp',
    ...(kimi ? { nativeKimi: KIMI_NATIVE } : {}),
    poolKey: { projectPath: '/tmp', providerProfile: 'empty-response-test' },
    pool: {
      async acquire() {
        return { client, release() {} };
      },
      rememberSession() {},
    },
  });
  return { service, prompts, cleanup: () => clock.mock.restore() };
}

// Kimi maps non-auth provider failures to end_turn without exposing the cause.
// Exercise the real adapter; advance a fake clock instead of waiting eight seconds.
test('slow resumed ACP end_turn without output is a failure, never silent success', async () => {
  const f = fixture();
  try {
    const messages = await Array.fromAsync(f.service.invoke('hello', { sessionId: 'resumed' }));
    const error = messages.find((message) => message.type === 'error');
    assert.equal(error?.errorCode, 'empty_response');
    assert.match(error.error, /未返回.*回复.*工具调用/);
    assert.match(error.error, /未提供.*原因/);
    assert.deepEqual(f.prompts, ['resumed'], 'slow empty turns must not be replayed');
    assert.equal(messages.at(-1).type, 'done');
  } finally {
    f.cleanup();
  }
});

test('usage-only ACP updates do not establish a successful reply', async () => {
  const f = fixture({ events: [{ sessionUpdate: 'usage_update', used: 10, size: 100 }] });
  try {
    const messages = await Array.fromAsync(f.service.invoke('hello'));
    assert.equal(messages.find((message) => message.type === 'error')?.errorCode, 'empty_response');
    assert.deepEqual(f.prompts, ['fresh']);
  } finally {
    f.cleanup();
  }
});

test('an empty fresh-session retry also fails, while a successful retry stays successful', async () => {
  for (const freshEvents of [
    [],
    [{ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'reply' } }],
  ]) {
    const f = fixture({ elapsedMs: 100, freshEvents });
    try {
      const messages = await Array.fromAsync(f.service.invoke('hello', { sessionId: 'resumed' }));
      assert.deepEqual(f.prompts, ['resumed', 'fresh']);
      assert.equal(
        messages.some((message) => message.type === 'error'),
        freshEvents.length === 0,
      );
      if (freshEvents.length === 0)
        assert.equal(messages.find((message) => message.type === 'error').errorCode, 'empty_response');
    } finally {
      f.cleanup();
    }
  }
});

test('explicit non-success ACP stop reasons are failures even after partial output', async () => {
  for (const stopReason of ['refusal', 'cancelled', 'max_tokens', 'max_turn_requests']) {
    const f = fixture({
      stopReason,
      events: [{ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'partial' } }],
    });
    try {
      const messages = await Array.fromAsync(f.service.invoke('hello'));
      assert.equal(messages.find((message) => message.type === 'text')?.content, 'partial');
      assert.match(messages.find((message) => message.type === 'error')?.error, new RegExp(stopReason));
      assert.deepEqual(f.prompts, ['fresh'], 'terminal failures must not be replayed');
    } finally {
      f.cleanup();
    }
  }
});

test('a tool-only reply is valid output and an explicit upstream error retains its cause', async () => {
  for (const input of [
    { events: [{ sessionUpdate: 'tool_call', toolCallId: 'tool-1', title: 'Read', kind: 'read', status: 'pending' }] },
    { failure: new AcpProtocolError(-32603, 'Internal error', { error: 'Insufficient quota' }) },
  ]) {
    const f = fixture(input);
    try {
      const messages = await Array.fromAsync(f.service.invoke('hello'));
      const error = messages.find((message) => message.type === 'error');
      if (input.failure) assert.match(error.error, /Insufficient quota/);
      else {
        assert.equal(error, undefined);
        assert.ok(messages.some((message) => message.type === 'tool_use'));
      }
    } finally {
      f.cleanup();
    }
  }
});

test('a user cancel is never reported as an empty or failed turn', async () => {
  const partial = [{ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'partial' } }];
  const cases = [
    { name: 'cancelled with no output', input: { stopReason: 'cancelled' }, text: undefined },
    { name: 'cancelled after partial output', input: { stopReason: 'cancelled', events: partial }, text: 'partial' },
    {
      name: 'cancelled during the fresh-session retry',
      input: { elapsedMs: 100, stopReason: (id) => (id === 'fresh' ? 'cancelled' : 'end_turn') },
      options: { sessionId: 'resumed' },
      abortOn: 'fresh',
    },
  ];
  for (const { name, input, options, text, abortOn } of cases) {
    const controller = new AbortController();
    const f = fixture({ ...input, onEnd: (id) => (abortOn === undefined || id === abortOn) && controller.abort() });
    try {
      const messages = await Array.fromAsync(f.service.invoke('hello', { ...options, signal: controller.signal }));
      assert.equal(
        messages.some((message) => message.type === 'error'),
        false,
        `${name}: a user-requested stop must not surface as an error`,
      );
      assert.equal(messages.at(-1).type, 'done', name);
      assert.equal(messages.find((message) => message.type === 'text')?.content, text, name);
    } finally {
      f.cleanup();
    }
  }
});

test('empty ACP output persists a failed response and its explanation through both route strategies', async () => {
  const { MessageStore } = await import('../../dist/domains/cats/services/stores/ports/MessageStore.js');
  const { routeSerial } = await import('../../dist/domains/cats/services/agents/routing/route-serial.js');
  const { routeParallel } = await import('../../dist/domains/cats/services/agents/routing/route-parallel.js');
  for (const route of [routeSerial, routeParallel]) {
    const f = fixture();
    try {
      const { deps } = routingJourneyDeps(undefined, undefined, f.service);
      deps.services = { kimi: f.service };
      deps.messageStore = new MessageStore();
      let responseId;
      const persistenceContext = { failed: false, errors: [] };
      await Array.fromAsync(
        route(deps, ['kimi'], 'hello', 'user1', 'thread1', {
          persistenceContext,
          onLifecycleInvocationStarted: async (input) => {
            const response = await appendTestLifecycleResponseSource(deps.messageStore, {
              invocationId: input.invocationId,
              catId: input.catId,
              threadId: input.threadId,
              userId: input.userId,
              timestamp: input.startedAt,
            });
            responseId = response.id;
            return { responseMessageId: response.id, priorFrontierMessageId: null };
          },
        }),
      );
      assert.deepEqual(persistenceContext.errors, []);
      const persisted = await deps.messageStore.getById(responseId);
      assert.equal(persisted.lifecycle.status, 'failed');
      assert.match(persisted.content, /未返回.*回复.*工具调用/);
      assert.match(persisted.content, /未提供.*原因/);
      assert.equal(persisted.from.catId, 'kimi');
    } finally {
      f.cleanup();
    }
  }
});

// The ACP bridge hides provider failures, but the CLI's own turn ledger keeps
// the cause. Only records appended after this prompt's boundary may explain it.
test('a Kimi quota failure after zero output carries the real cause', async () => {
  const ledger = await kimiLedger({ sessionId: 'resumed' });
  const f = fixture({ kimi: ledger.spawnContext, onEnd: () => ledger.append([turnEnded({ error: QUOTA_ERROR })]) });
  try {
    const messages = await Array.fromAsync(f.service.invoke('hello', { sessionId: 'resumed' }));
    const error = messages.find((message) => message.type === 'error');
    assert.equal(error?.errorCode, 'empty_response');
    assert.match(error.error, /weekly \(7-day\) usage limit/);
    assert.match(error.error, /HTTP 429/);
    assert.match(error.error, /APIProviderQuotaExhaustedError/);
    assert.doesNotMatch(error.error, /上游未提供失败原因/);
  } finally {
    f.cleanup();
    await ledger.cleanup();
  }
});

test('a Kimi turn that fails after partial output keeps the text and reports the cause', async () => {
  const ledger = await kimiLedger({ sessionId: 'resumed' });
  const f = fixture({
    kimi: ledger.spawnContext,
    events: [{ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'partial' } }],
    onEnd: () => ledger.append([turnEnded({ error: QUOTA_ERROR })]),
  });
  try {
    const messages = await Array.fromAsync(f.service.invoke('hello', { sessionId: 'resumed' }));
    assert.equal(messages.find((message) => message.type === 'text')?.content, 'partial');
    const error = messages.find((message) => message.type === 'error');
    assert.equal(error?.errorCode, 'prompt_failure');
    assert.match(error.error, /失败前已输出部分内容/);
    assert.match(error.error, /weekly \(7-day\) usage limit/);
  } finally {
    f.cleanup();
    await ledger.cleanup();
  }
});

test('a ledger failure that predates this prompt never fails the current turn', async () => {
  // A recent timestamp made the old clock-skew heuristic mis-attribute this record.
  const ledger = await kimiLedger({
    sessionId: 'resumed',
    pre: [turnEnded({ time: 1_000_050, error: QUOTA_ERROR })],
  });
  const f = fixture({
    kimi: ledger.spawnContext,
    events: [{ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'ok' } }],
  });
  try {
    const messages = await Array.fromAsync(f.service.invoke('hello', { sessionId: 'resumed' }));
    assert.equal(
      messages.some((message) => message.type === 'error'),
      false,
    );
    assert.equal(messages.find((message) => message.type === 'text')?.content, 'ok');
  } finally {
    f.cleanup();
    await ledger.cleanup();
  }
});

test('the reader uses the session workspace, not the process bootstrap cwd', async () => {
  const ledger = await kimiLedger({
    sessionId: 'resumed',
    cwd: '/tmp',
    spawnCwd: '/tmp/cat-cafe-acp-bootstrap-uid-501',
  });
  const f = fixture({ kimi: ledger.spawnContext, onEnd: () => ledger.append([turnEnded({ error: QUOTA_ERROR })]) });
  try {
    const messages = await Array.fromAsync(
      f.service.invoke('hello', { sessionId: 'resumed', workingDirectory: '/tmp' }),
    );
    const error = messages.find((message) => message.type === 'error');
    assert.equal(error?.errorCode, 'empty_response');
    assert.match(error.error, /weekly \(7-day\) usage limit/);
  } finally {
    f.cleanup();
    await ledger.cleanup();
  }
});

test('a Kimi turn without matching ledger evidence keeps the honest unknown-cause message', async () => {
  const shareDir = await mkdtemp(join(tmpdir(), 'kimi-service-missing-'));
  const f = fixture({ kimi: { cwd: '/tmp', env: { KIMI_CODE_HOME: shareDir } } });
  try {
    const messages = await Array.fromAsync(f.service.invoke('hello', { sessionId: 'resumed' }));
    const error = messages.find((message) => message.type === 'error');
    assert.equal(error?.errorCode, 'empty_response');
    assert.match(error.error, /上游未提供失败原因/);
    assert.doesNotMatch(error.error, /429/);
  } finally {
    f.cleanup();
    await rm(shareDir, { recursive: true, force: true });
  }
});

test('a child environment without KIMI_CODE_HOME never reads the host account ledger', async () => {
  const hostRoot = await mkdtemp(join(tmpdir(), 'kimi-host-account-'));
  const childHome = await mkdtemp(join(tmpdir(), 'kimi-child-home-'));
  const hostLedger = await kimiLedger({ sessionId: 'resumed', cwd: '/tmp', shareDir: hostRoot });
  await hostLedger.append([turnEnded({ error: QUOTA_ERROR })]);
  const savedHost = process.env.KIMI_CODE_HOME;
  process.env.KIMI_CODE_HOME = hostRoot;
  const f = fixture({ kimi: { cwd: '/tmp', env: { HOME: childHome } } });
  try {
    const messages = await Array.fromAsync(f.service.invoke('hello', { sessionId: 'resumed' }));
    const error = messages.find((message) => message.type === 'error');
    assert.equal(error?.errorCode, 'empty_response');
    assert.doesNotMatch(error.error, /429|APIProviderQuotaExhaustedError/);
    assert.match(error.error, /上游未提供失败原因/);
  } finally {
    f.cleanup();
    if (savedHost === undefined) delete process.env.KIMI_CODE_HOME;
    else process.env.KIMI_CODE_HOME = savedHost;
    await rm(hostRoot, { recursive: true, force: true });
    await rm(childHome, { recursive: true, force: true });
  }
});

test('a user cancel is not reclassified by a failed ledger record', async () => {
  const ledger = await kimiLedger({ sessionId: 'resumed' });
  const controller = new AbortController();
  const f = fixture({
    kimi: ledger.spawnContext,
    events: [{ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'partial' } }],
    onEnd: async () => {
      await ledger.append([turnEnded({ error: QUOTA_ERROR })]);
      controller.abort();
    },
  });
  try {
    const messages = await Array.fromAsync(
      f.service.invoke('hello', { sessionId: 'resumed', signal: controller.signal }),
    );
    assert.equal(
      messages.some((message) => message.type === 'error'),
      false,
    );
    assert.equal(messages.at(-1).type, 'done');
  } finally {
    f.cleanup();
    await ledger.cleanup();
  }
});

test('a Kimi failure on the fresh-session retry keeps its cause without the retry prefix', async () => {
  const shareDir = await mkdtemp(join(tmpdir(), 'kimi-service-retry-'));
  const resumed = await kimiLedger({ sessionId: 'resumed', cwd: '/tmp', shareDir });
  const fresh = await kimiLedger({ sessionId: 'fresh', cwd: '/tmp', shareDir });
  let freshSessionStarted = false;
  const f = fixture({
    kimi: resumed.spawnContext,
    elapsedMs: 100,
    onEnd: async (id) => {
      if (id !== 'fresh') return;
      freshSessionStarted = true;
      await fresh.append([turnEnded({ error: QUOTA_ERROR })]);
    },
  });
  try {
    const messages = await Array.fromAsync(f.service.invoke('hello', { sessionId: 'resumed' }));
    assert.deepEqual(f.prompts, ['resumed', 'fresh']);
    assert.equal(freshSessionStarted, true);
    const error = messages.find((message) => message.type === 'error');
    assert.equal(error?.errorCode, 'empty_response');
    assert.match(error.error, /weekly \(7-day\) usage limit/);
    assert.doesNotMatch(error.error, /resume_empty_retry_failed/);
  } finally {
    f.cleanup();
    await resumed.cleanup(); // removes the shared root
  }
});

test('a fast known failure on the resumed turn is surfaced without a fresh retry', async () => {
  const ledger = await kimiLedger({ sessionId: 'resumed' });
  const f = fixture({
    kimi: ledger.spawnContext,
    elapsedMs: 100,
    onEnd: (id) => (id === 'resumed' ? ledger.append([turnEnded({ error: QUOTA_ERROR })]) : undefined),
  });
  try {
    const messages = await Array.fromAsync(f.service.invoke('hello', { sessionId: 'resumed' }));
    assert.deepEqual(f.prompts, ['resumed'], 'a known terminal failure must not trigger the empty-resume replay');
    const error = messages.find((message) => message.type === 'error');
    assert.equal(error?.errorCode, 'empty_response');
    assert.match(error.error, /weekly \(7-day\) usage limit/);
    assert.doesNotMatch(error.error, /resume_empty_retry_failed/);
  } finally {
    f.cleanup();
    await ledger.cleanup();
  }
});
