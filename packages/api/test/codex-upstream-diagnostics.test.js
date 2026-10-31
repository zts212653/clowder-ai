import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CodexAgentService } from '../dist/domains/cats/services/agents/providers/CodexAgentService.js';
import { RedisMessageStore } from '../dist/domains/cats/services/stores/redis/RedisMessageStore.js';
import { buildCliDiagnostics, classifyCliError } from '../dist/utils/cli-diagnostics.js';
import { fakeL0Compiler } from './helpers/fake-l0-compiler.js';

// Error-only witnesses from archive 5f771d02... (2026-10-11), never session bodies.
const HIGH_DEMAND = 'We’re currently experiencing high demand, which may cause temporary errors.';
const REQUEST_ID = '7ab62694-a1b3-4ef6-977e-7edb76b44640';
const PROCESSING_ERROR = `stream disconnected before completion: An error occurred while processing your request. You can retry your request, or contact us through our help center at help.openai.com if the error persists. Please include the request ID ${REQUEST_ID} in your message.`;
const BARE_STREAM_ERROR = 'stream disconnected before completion';
const ref = { command: 'codex app-server', exitCode: null, signal: null };

class Inbox {
  values = [];
  waiters = [];
  push(value) {
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value, done: false });
    else this.values.push(value);
  }
  close() {
    for (const waiter of this.waiters.splice(0)) waiter({ done: true });
  }
  [Symbol.asyncIterator]() {
    return {
      next: () =>
        this.values.length
          ? Promise.resolve({ value: this.values.shift(), done: false })
          : new Promise((resolve) => this.waiters.push(resolve)),
    };
  }
}

class ErrorWire {
  inbox = new Inbox();
  constructor(sequence, finalMessage, finalStatus = 'failed') {
    Object.assign(this, { sequence, finalMessage, finalStatus });
  }
  read() {
    return this.inbox;
  }
  async write(message) {
    let result = {};
    if (message.method === 'configRequirements/read') result = { requirements: null };
    if (message.method === 'config/read') result = { config: { model_provider: 'openai' } };
    if (message.method === 'account/read') result = { account: { type: 'chatgpt' } };
    if (message.method === 'thread/start') result = { thread: { id: 'root-thread', turns: [] } };
    if (message.method === 'turn/start') result = { turn: { id: 'root-turn', status: 'inProgress' } };
    this.inbox.push({ id: message.id, result });
    if (message.method === 'turn/start')
      setImmediate(() => {
        for (const event of this.sequence) this.inbox.push(event);
        this.inbox.push({
          method: 'turn/completed',
          params: {
            threadId: 'root-thread',
            turn: {
              id: 'root-turn',
              status: this.finalStatus,
              error: { message: this.finalMessage, additionalDetails: null, codexErrorInfo: 'other' },
            },
          },
        });
      });
  }
  rememberSession() {}
  async close() {
    this.inbox.close();
  }
}

function retry(details, attempt = 1, threadId = 'root-thread', turnId = 'root-turn') {
  return {
    method: 'error',
    params: {
      threadId,
      turnId,
      willRetry: true,
      error: {
        message: `Reconnecting... ${attempt}/5`,
        additionalDetails: details,
        codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: null } },
      },
    },
  };
}
const recoveredTool = {
  method: 'item/completed',
  params: {
    threadId: 'root-thread',
    turnId: 'root-turn',
    item: {
      id: 'successful-tool',
      type: 'mcpToolCall',
      server: 'fixture',
      tool: 'read',
      status: 'completed',
      result: { content: [] },
    },
  },
};

async function invoke(sequence, terminal = BARE_STREAM_ERROR, finalStatus = 'failed') {
  const service = new CodexAgentService({
    carrierMode: 'app_server',
    cliCommand: process.execPath,
    l0CompilerFn: fakeL0Compiler,
    rawArchive: { append: async () => {} },
    model: 'gpt-6.1-sol',
  });
  const messages = [];
  for await (const message of service.invoke('fixture', {
    invocationId: 'inv-upstream-diagnostics',
    callbackEnv: { CODEX_SQLITE_HOME: `${process.env.HOME}/.codex` },
    agentCarrierSessionFactory: async () => new ErrorWire(sequence, terminal, finalStatus),
  }))
    messages.push(message);
  return messages;
}
function diagnostic(messages) {
  const errors = messages.filter((message) => message.type === 'error');
  assert.equal(errors.length, 1);
  assert.match(errors[0].error, /stream disconnected|ETIMEDOUT|unclassified protocol failure/, errors[0].error);
  return errors[0].metadata.cliDiagnostics;
}

test('classifies witnessed high demand and upstream processing errors independently of the stream wrapper', () => {
  assert.equal(classifyCliError(HIGH_DEMAND), 'server_overloaded');
  assert.equal(classifyCliError(PROCESSING_ERROR), 'upstream_service_error');
  for (const text of ['getaddrinfo ENOTFOUND api.openai.com', 'connect ECONNREFUSED', 'connect ETIMEDOUT']) {
    assert.equal(classifyCliError(`${BARE_STREAM_ERROR}: ${text}`), 'network_error');
  }
  const bare = buildCliDiagnostics({ rawText: BARE_STREAM_ERROR, debugRef: ref });
  assert.equal(bare.reasonCode, 'stream_disconnected');
  assert.match(bare.publicHint, /原因.*未|无法.*确定/);
  assert.doesNotMatch(bare.publicHint, /检查.*VPN|检查.*代理/);
});

test('actual sequence: high demand → successful tool → processing retries → null details terminal', async () => {
  const sequence = [
    retry(HIGH_DEMAND, 2),
    retry(HIGH_DEMAND, 3),
    retry(HIGH_DEMAND, 4),
    retry(HIGH_DEMAND, 5),
    recoveredTool,
    ...[1, 2, 3, 4, 5].map((n) => retry(PROCESSING_ERROR, n)),
    {
      method: 'error',
      params: {
        threadId: 'root-thread',
        turnId: 'root-turn',
        willRetry: false,
        error: { message: PROCESSING_ERROR, additionalDetails: null, codexErrorInfo: 'other' },
      },
    },
  ];
  const messages = await invoke(sequence, PROCESSING_ERROR);
  const diag = diagnostic(messages);
  assert.equal(diag.reasonCode, 'upstream_service_error');
  assert.match(diag.publicSummary, /上游/);
  assert.doesNotMatch(diag.publicHint, /VPN|代理/);
  assert.equal(diag.debugRef.upstreamRequestId, REQUEST_ID);
  assert.doesNotMatch(diag.safeExcerpt, /high demand/);

  // Exercise the real durable hash encoder and decoder, with an isolated Redis double.
  let fields;
  const redis = {
    options: {},
    eval: async (...args) => {
      if (args.length === 6) return 0;
      const start = 2 + Number(args[1]);
      const countIndex = start + 9 + Number(args[start + 8]);
      const pairs = args.slice(countIndex + 1, countIndex + 1 + Number(args[countIndex]) * 2);
      fields = Object.fromEntries(Array.from({ length: pairs.length / 2 }, (_, i) => [pairs[i * 2], pairs[i * 2 + 1]]));
      return 1;
    },
    hgetall: async () => fields,
  };
  const store = new RedisMessageStore(redis);
  const stored = await store.append({
    userId: 'fixture-user',
    threadId: 'fixture-thread',
    from: { kind: 'agent', catId: 'codex' },
    content: 'Error: upstream',
    timestamp: Date.now(),
    mentions: [],
    type: 'system',
    variant: 'error',
    metadata: messages.find((message) => message.type === 'error').metadata,
  });
  assert.deepEqual((await store.getById(stored.id)).metadata.cliDiagnostics, diag);
});

test('retains the strong cause when the same retry episode ends with only a bare disconnection', async () => {
  const diag = diagnostic(await invoke([retry(HIGH_DEMAND), retry(null, 5)]));
  assert.equal(diag.reasonCode, 'server_overloaded');
  assert.match(diag.safeExcerpt, /high demand/);
});

test('recovery clears old causes and each invocation starts fresh', async () => {
  const diag = diagnostic(await invoke([retry(HIGH_DEMAND), recoveredTool]));
  assert.equal(diag.reasonCode, 'stream_disconnected');
  assert.doesNotMatch(diag.safeExcerpt, /high demand/);
  assert.equal(diagnostic(await invoke([])).reasonCode, 'stream_disconnected');
  assert.equal(
    (await invoke([retry(HIGH_DEMAND), recoveredTool], '', 'completed')).some((m) => m.type === 'error'),
    false,
  );
});

test('later explicit connection failures override old upstream evidence', async () => {
  assert.equal(diagnostic(await invoke([retry(HIGH_DEMAND)], 'connect ETIMEDOUT')).reasonCode, 'network_error');
});

test('foreign thread/turn evidence cannot contaminate the root failure', async () => {
  const diag = diagnostic(
    await invoke([
      retry(HIGH_DEMAND, 1, 'other-thread', 'other-turn'),
      retry(HIGH_DEMAND, 2, 'root-thread', 'other-turn'),
    ]),
  );
  assert.equal(diag.reasonCode, 'stream_disconnected');
});

test('bounded diagnostic evidence is sanitized before truncation', async () => {
  const diag = diagnostic(await invoke([retry(`${HIGH_DEMAND} token=${'s'.repeat(2500)}\n${'x'.repeat(5000)}`)]));
  assert.equal(diag.reasonCode, 'server_overloaded');
  assert.ok(diag.safeExcerpt.length <= 1500);
  assert.doesNotMatch(diag.safeExcerpt, /s{20}/);
});

test('null-details terminal keeps the latest request ID from its own retry episode', async () => {
  const diag = diagnostic(await invoke([retry(PROCESSING_ERROR), retry(null, 5)]));
  assert.equal(diag.reasonCode, 'upstream_service_error');
  assert.equal(diag.debugRef.upstreamRequestId, REQUEST_ID);
});

test('request ID extraction rejects unbounded or malformed values', () => {
  const diag = buildCliDiagnostics({
    rawText: 'An error occurred while processing your request. request ID token-sensitive-value',
    debugRef: ref,
  });
  assert.equal(diag.debugRef.upstreamRequestId, undefined);
});

test('an unrelated unknown terminal does not inherit a prior upstream diagnosis', async () => {
  const diag = diagnostic(await invoke([retry(HIGH_DEMAND)], 'unclassified protocol failure'));
  assert.equal(diag.reasonCode, undefined);
  assert.doesNotMatch(diag.safeExcerpt, /high demand/);
});

test('request correlation cannot bypass a caller-restricted public excerpt source', () => {
  const diag = buildCliDiagnostics({ rawText: PROCESSING_ERROR, safeExcerptRawText: '', debugRef: ref });
  assert.equal(diag.debugRef.upstreamRequestId, undefined);
});
