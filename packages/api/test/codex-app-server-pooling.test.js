import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import {
  CodexAgentService,
  codexConfigObjectFromArgs,
} from '../dist/domains/cats/services/agents/providers/CodexAgentService.js';
import { fakeL0Compiler } from './helpers/fake-l0-compiler.js';

class AsyncInbox {
  #values = [];
  #waiters = [];
  #closed = false;

  push(value) {
    const waiter = this.#waiters.shift();
    if (waiter) waiter({ value, done: false });
    else this.#values.push(value);
  }

  close() {
    this.#closed = true;
    for (const waiter of this.#waiters.splice(0)) waiter({ value: undefined, done: true });
  }

  [Symbol.asyncIterator]() {
    return {
      next: () => {
        const value = this.#values.shift();
        if (value !== undefined) return Promise.resolve({ value, done: false });
        if (this.#closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => this.#waiters.push(resolve));
      },
    };
  }
}

class PoolWire {
  constructor(threadId, reusedSessionHost = false, turnCompletion = { status: 'completed' }, turnNotifications = []) {
    this.threadId = threadId;
    this.reusedSessionHost = reusedSessionHost;
    this.turnCompletion = turnCompletion;
    this.turnNotifications = turnNotifications;
    this.inbox = new AsyncInbox();
    this.writes = [];
    this.rememberedSessions = [];
  }

  read() {
    return this.inbox;
  }

  async write(message) {
    this.writes.push(message);
    if (message.method === 'initialize') {
      this.inbox.push({ id: message.id, result: { userAgent: 'fake-pool' } });
    } else if (message.method === 'thread/start' || message.method === 'thread/resume') {
      const threadId = message.method === 'thread/resume' ? message.params.threadId : this.threadId;
      this.inbox.push({ id: message.id, result: { thread: { id: threadId, turns: [] } } });
    } else if (message.method === 'turn/start') {
      this.inbox.push({ id: message.id, result: { turn: { id: 'turn-1', status: 'inProgress', items: [] } } });
      setImmediate(() => {
        for (const notification of this.turnNotifications) this.inbox.push(notification);
        this.inbox.push({
          method: 'turn/completed',
          params: {
            threadId: message.params.threadId,
            turn: { id: 'turn-1', ...this.turnCompletion, items: [] },
          },
        });
      });
    }
  }

  rememberSession(sessionId) {
    this.rememberedSessions.push(sessionId);
  }

  async close() {
    this.inbox.close();
  }
}

class FakeHostPool {
  constructor() {
    this.calls = [];
    this.wires = [];
    this.rejectedSessionIds = new Set();
    this.replacementSessionIds = new Set();
    this.turnCompletions = [];
    this.turnNotifications = [];
  }

  async createSession(options) {
    this.calls.push(options);
    if (options.sessionId && this.rejectedSessionIds.has(options.sessionId)) {
      throw new Error(`session ${options.sessionId} already has an active host lease`);
    }
    const reusedSessionHost = !!options.sessionId && !this.replacementSessionIds.has(options.sessionId);
    const wire = new PoolWire(
      'codex-thread-1',
      reusedSessionHost,
      this.turnCompletions.shift(),
      this.turnNotifications.shift(),
    );
    this.wires.push(wire);
    return wire;
  }

  async closeAll() {}
}

const credsDir = mkdtempSync(join(tmpdir(), 'cat-cafe-codex-pool-creds-'));
process.env.CAT_CAFE_MCP_CREDS_DIR = credsDir;

after(() => {
  delete process.env.CAT_CAFE_MCP_CREDS_DIR;
  rmSync(credsDir, { recursive: true, force: true });
});

function callbackEnv(invocationId, callbackToken) {
  return {
    CAT_CAFE_API_URL: 'http://127.0.0.1:3004',
    CAT_CAFE_INVOCATION_ID: invocationId,
    CAT_CAFE_CALLBACK_TOKEN: callbackToken,
    CAT_CAFE_USER_ID: 'user-1',
    CAT_CAFE_CAT_ID: 'codex-sol',
    CAT_CAFE_THREAD_ID: 'cafe-thread-1',
  };
}

async function drain(iterable) {
  const values = [];
  for await (const value of iterable) values.push(value);
  return values;
}

test('pooled Codex materializes ordered MCP overlays without duplicate TOML tables', () => {
  const config = codexConfigObjectFromArgs([
    '--config',
    'mcp_servers.cat-cafe.command="echo"',
    '--config',
    'mcp_servers.cat-cafe.args=["legacy-shim"]',
    '--config',
    'mcp_servers.cat-cafe.enabled=false',
    '--config',
    'mcp_servers.cat-cafe.command="node"',
    '--config',
    'mcp_servers.cat-cafe.args=["legacy.js"]',
    '--config',
    'mcp_servers.cat-cafe.enabled=true',
    '-c',
    'mcp_servers.cat-cafe.default_tools_approval_mode="approve"',
    '--config',
    'mcp_servers.cat-cafe.env.CAT_CAFE_CREDENTIAL_FILE="/tmp/session.json"',
  ]);

  assert.deepEqual(config, {
    mcp_servers: {
      'cat-cafe': {
        command: 'node',
        args: ['legacy.js'],
        enabled: true,
        default_tools_approval_mode: 'approve',
        env: { CAT_CAFE_CREDENTIAL_FILE: '/tmp/session.json' },
      },
    },
  });
});

test('pooled host lease observes the invocation abort signal', async () => {
  const pool = new FakeHostPool();
  const abortController = new AbortController();
  const service = new CodexAgentService({
    carrierMode: 'app_server',
    appServerHostPool: pool,
    cliCommand: process.execPath,
    l0CompilerFn: fakeL0Compiler,
    model: 'gpt-5.3-codex',
  });

  await drain(
    service.invoke('signal plumbing', {
      invocationId: 'invocation-signal',
      signal: abortController.signal,
    }),
  );

  assert.equal(pool.calls.length, 1);
  assert.equal(pool.calls[0].signal, abortController.signal);
});

test('CodexAgentService hides a recovered model-capacity failure from the Clowder AI message stream', async () => {
  const pool = new FakeHostPool();
  pool.turnCompletions.push(
    {
      status: 'failed',
      error: { message: 'Selected model is at capacity. Please try a different model.' },
    },
    { status: 'completed' },
  );
  const service = new CodexAgentService({
    carrierMode: 'app_server',
    appServerHostPool: pool,
    cliCommand: process.execPath,
    l0CompilerFn: fakeL0Compiler,
    model: 'gpt-5.6-sol',
  });

  const output = await drain(
    service.invoke('keep working', {
      invocationId: 'invocation-capacity-retry',
      recoveryAnchor: {
        threadId: 'cat-thread-7',
        invocationId: 'invocation-capacity-retry',
        promptMessageIds: ['message-keep-working'],
      },
    }),
  );

  assert.equal(pool.calls.length, 2);
  assert.equal(pool.calls[1].sessionId, 'codex-thread-1');
  assert.equal(
    output.some((event) => event.type === 'error'),
    false,
    'a recovered capacity terminal must not force the user to send a new message',
  );
  assert.equal(
    output.some((event) => event.metadata?.diagnostics?.appServerRecovery?.reason === 'model_capacity'),
    true,
  );
  const recoveryIndex = output.findIndex(
    (event) => event.metadata?.diagnostics?.appServerRecovery?.reason === 'model_capacity',
  );
  assert.equal(
    output.slice(0, recoveryIndex).some((event) => event.type === 'status' && event.content === 'done'),
    false,
    'the hidden failed attempt must not publish a premature terminal status',
  );
  const retryTurn = pool.wires[1].writes.find((message) => message.method === 'turn/start');
  assert.deepEqual(retryTurn.params.input, []);
  assert.equal(retryTurn.params.additionalContext?.['cat-cafe.capacity-recovery']?.kind, 'application');
});

test('CodexAgentService surfaces one checkpoint card when an in-flight tool blocks capacity recovery', async () => {
  const pool = new FakeHostPool();
  pool.turnCompletions.push({
    status: 'failed',
    error: { message: 'Selected model is at capacity. Please try a different model.' },
  });
  pool.turnNotifications.push([
    {
      method: 'turn/plan/updated',
      params: {
        threadId: 'codex-thread-1',
        turnId: 'turn-1',
        plan: [
          { step: 'Inspect pull request 42', status: 'completed' },
          { step: 'Finish exact-head review', status: 'inProgress' },
        ],
      },
    },
    {
      method: 'item/started',
      params: {
        threadId: 'codex-thread-1',
        turnId: 'turn-1',
        item: { id: 'command-1', type: 'commandExecution', command: 'pnpm test' },
      },
    },
  ]);
  const service = new CodexAgentService({
    carrierMode: 'app_server',
    appServerHostPool: pool,
    cliCommand: process.execPath,
    l0CompilerFn: fakeL0Compiler,
    model: 'gpt-5.6-sol',
  });

  const output = await drain(
    service.invoke('review pull request 42', {
      invocationId: 'invocation-capacity-blocked',
      recoveryAnchor: {
        threadId: 'cafe-thread-1',
        invocationId: 'invocation-capacity-blocked',
        promptMessageIds: ['message-42'],
      },
    }),
  );

  const cards = output
    .filter((event) => event.type === 'system_info')
    .map((event) => {
      try {
        return JSON.parse(event.content);
      } catch {
        return null;
      }
    })
    .filter((event) => event?.type === 'rich_block' && event.block?.meta?.kind === 'codex_capacity_recovery');
  const errors = output.filter((event) => event.type === 'error');

  assert.equal(cards.length, 1);
  assert.equal(cards[0].block.meta.reason, 'blocked_inflight_tool');
  assert.match(cards[0].block.fields.find((field) => field.label === '下一步').value, /exact-head review/);
  assert.equal(errors.length, 1, 'the invocation must remain a failure even though diagnostics use a rich card');
  assert.doesNotMatch(errors[0].error, /Selected model is at capacity/);
  assert.match(errors[0].error, /没有猜测或切换任务/);
  assert.equal(errors[0].metadata.upstreamError.kind, 'capacity');
});

function managedCredentialPath(threadStart) {
  const servers = threadStart.params.config?.mcp_servers ?? {};
  return Object.values(servers)
    .map((server) => server?.env?.CAT_CAFE_CREDENTIAL_FILE)
    .find((value) => typeof value === 'string');
}

test('pooled Codex carries MCP config per session and refreshes an isolated credential file', async () => {
  const pool = new FakeHostPool();
  const archived = [];
  const service = new CodexAgentService({
    carrierMode: 'app_server',
    appServerHostPool: pool,
    cliCommand: process.execPath,
    l0CompilerFn: fakeL0Compiler,
    model: 'gpt-5.3-codex',
    rawArchive: { append: async (_invocationId, payload) => archived.push(payload) },
  });

  await drain(
    service.invoke('first turn', {
      invocationId: 'invocation-1',
      callbackEnv: callbackEnv('invocation-1', 'callback-token-1'),
      auditContext: {
        invocationId: 'invocation-1',
        threadId: 'cafe-thread-1',
        userId: 'user-1',
        catId: 'codex-sol',
      },
    }),
  );

  assert.equal(pool.calls.length, 1, 'the app-server carrier must acquire the injected warm pool');
  const firstWire = pool.wires[0];
  const firstStart = firstWire.writes.find((message) => message.method === 'thread/start');
  const credentialPath = managedCredentialPath(firstStart);
  assert.ok(credentialPath, 'managed MCP config must receive a session credential path');
  assert.deepEqual(firstWire.rememberedSessions, ['codex-thread-1']);
  assert.equal(JSON.parse(readFileSync(credentialPath, 'utf8')).invocationId, 'invocation-1');

  const firstLaunch = JSON.stringify(pool.calls[0]);
  assert.doesNotMatch(firstLaunch, /callback-token-1/);
  assert.doesNotMatch(firstLaunch, /mcp_servers\.cat-cafe/);
  assert.doesNotMatch(JSON.stringify(firstStart), /callback-token-1|CAT_CAFE_CALLBACK_TOKEN/);
  assert.equal(
    archived.some((payload) => JSON.stringify(payload).includes('callback-token-1')),
    false,
    'raw archive must not contain callback secrets moved into the credential file',
  );

  pool.rejectedSessionIds.add('codex-thread-1');
  await drain(
    service.invoke('overlapping resume', {
      invocationId: 'invocation-overlap',
      sessionId: 'codex-thread-1',
      callbackEnv: callbackEnv('invocation-overlap', 'callback-token-overlap'),
    }),
  );
  assert.equal(
    JSON.parse(readFileSync(credentialPath, 'utf8')).invocationId,
    'invocation-1',
    'a rejected concurrent lease must not rotate credentials under the active invocation',
  );
  pool.rejectedSessionIds.clear();
  const callsBeforeSuccessfulResume = pool.calls.length;

  await drain(
    service.invoke('resume turn', {
      invocationId: 'invocation-2',
      sessionId: 'codex-thread-1',
      callbackEnv: callbackEnv('invocation-2', 'callback-token-2'),
    }),
  );

  assert.equal(pool.calls.length, callsBeforeSuccessfulResume + 1);
  assert.equal(pool.calls.at(-1).sessionId, 'codex-thread-1');
  const resume = pool.wires.at(-1).writes.find((message) => message.method === 'thread/resume');
  assert.equal(managedCredentialPath(resume), credentialPath, 'resume must refresh the bound file, not rotate it');
  assert.equal(JSON.parse(readFileSync(credentialPath, 'utf8')).invocationId, 'invocation-2');
  assert.doesNotMatch(JSON.stringify(resume), /callback-token-2|CAT_CAFE_CALLBACK_TOKEN/);
});

test('replacement host rotates credentials while leaving the superseded host file unchanged', async () => {
  const pool = new FakeHostPool();
  const service = new CodexAgentService({
    carrierMode: 'app_server',
    appServerHostPool: pool,
    cliCommand: process.execPath,
    l0CompilerFn: fakeL0Compiler,
    model: 'gpt-5.3-codex',
  });

  await drain(
    service.invoke('seed turn', {
      invocationId: 'replacement-seed',
      callbackEnv: callbackEnv('replacement-seed', 'seed-token'),
    }),
  );
  const seedStart = pool.wires[0].writes.find((message) => message.method === 'thread/start');
  const oldPath = managedCredentialPath(seedStart);
  assert.ok(oldPath);
  assert.equal(JSON.parse(readFileSync(oldPath, 'utf8')).invocationId, 'replacement-seed');

  pool.replacementSessionIds.add('codex-thread-1');
  await drain(
    service.invoke('replacement turn', {
      invocationId: 'replacement-next',
      sessionId: 'codex-thread-1',
      callbackEnv: callbackEnv('replacement-next', 'replacement-token'),
    }),
  );

  const replacementResume = pool.wires.at(-1).writes.find((message) => message.method === 'thread/resume');
  const replacementPath = managedCredentialPath(replacementResume);
  assert.ok(replacementPath);
  assert.notEqual(replacementPath, oldPath, 'a different host must not receive the superseded host credential path');
  assert.equal(JSON.parse(readFileSync(oldPath, 'utf8')).invocationId, 'replacement-seed');
  assert.equal(JSON.parse(readFileSync(replacementPath, 'utf8')).invocationId, 'replacement-next');
});
