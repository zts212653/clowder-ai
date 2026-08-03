import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { CodexAppServerClient } from '../dist/domains/cats/services/agents/providers/CodexAppServerClient.js';
import { runCodexAppServerWithRecovery } from '../dist/domains/cats/services/agents/providers/CodexAppServerRunner.js';
import { createDirectAgentCarrierSession } from '../dist/domains/cats/services/agents/providers/DirectAgentCarrierSession.js';

async function collect(iterable) {
  const values = [];
  for await (const value of iterable) values.push(value);
  return values;
}

async function collectFailure(iterable) {
  const values = [];
  try {
    for await (const value of iterable) values.push(value);
    return { values, error: null };
  } catch (error) {
    return { values, error };
  }
}

async function waitFor(predicate, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('condition was not met before timeout');
    await delay(1);
  }
}

class AsyncInbox {
  #values = [];
  #waiters = [];
  #closed = false;
  #error = null;

  push(value) {
    const waiter = this.#waiters.shift();
    if (waiter) waiter.resolve({ value, done: false });
    else this.#values.push(value);
  }

  fail(error) {
    this.#error = error;
    for (const waiter of this.#waiters.splice(0)) waiter.reject(error);
  }

  close() {
    this.#closed = true;
    for (const waiter of this.#waiters.splice(0)) waiter.resolve({ value: undefined, done: true });
  }

  [Symbol.asyncIterator]() {
    return {
      next: () => {
        const value = this.#values.shift();
        if (value !== undefined) return Promise.resolve({ value, done: false });
        if (this.#error) return Promise.reject(this.#error);
        if (this.#closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve, reject) => this.#waiters.push({ resolve, reject }));
      },
    };
  }
}

class ProtocolWire {
  constructor() {
    this.inbox = new AsyncInbox();
    this.writes = [];
    this.terminateCalls = 0;
    this.closeCalls = 0;
    this.experimentalApiEnabled = false;
  }

  read() {
    return this.inbox;
  }

  async write(message) {
    this.writes.push(message);
    if (message.method === 'initialize') {
      this.experimentalApiEnabled = message.params.capabilities?.experimentalApi === true;
      this.inbox.push({ id: message.id, result: {} });
    }
    if (message.method === 'thread/start') {
      this.inbox.push({ id: message.id, result: { thread: { id: 'thread-1' } } });
    }
    if (message.method === 'thread/resume') {
      this.inbox.push({ id: message.id, result: { thread: { id: message.params.threadId } } });
    }
    if (message.method === 'turn/start') {
      if (message.params.additionalContext && !this.experimentalApiEnabled) {
        this.inbox.push({
          id: message.id,
          error: {
            code: -32600,
            message: 'turn/start.additionalContext requires experimentalApi capability',
          },
        });
      } else {
        this.inbox.push({ id: message.id, result: { turn: { id: 'turn-1', status: 'inProgress' } } });
      }
    }
    if (message.method === 'turn/interrupt') this.inbox.push({ id: message.id, result: {} });
  }

  async terminate() {
    this.terminateCalls++;
    this.inbox.close();
  }

  async close() {
    this.closeCalls++;
    this.inbox.close();
  }
}

test('direct app-server carrier frames JSONL on LF only', async () => {
  const childScript = `
    const records = [
      { id: 2, result: { thread: { preview: 'before\\u2028middle\\u2029after' } } },
      { method: 'turn/completed', params: { turn: { id: 'turn-1', status: 'completed' } } },
    ];
    process.stdout.write(records.map(JSON.stringify).join('\\r\\n'));
  `;
  const session = await createDirectAgentCarrierSession({
    command: process.execPath,
    args: ['--input-type=module', '-e', childScript],
    invocationId: 'jsonl-line-separator-regression',
  });

  try {
    const records = await collect(session.read());
    assert.equal(records.length, 2);
    assert.equal(records[0].result.thread.preview, 'before\u2028middle\u2029after');
    assert.equal(records[1].method, 'turn/completed');
  } finally {
    await session.close();
  }
});

test('app-server pump failure rejects only the invocation without an unhandled rejection', async () => {
  const transportError = new Error('transport exploded');
  const wire = {
    read() {
      return {
        [Symbol.asyncIterator]() {
          return {
            async next() {
              await delay(0);
              throw transportError;
            },
          };
        },
      };
    },
    async write() {},
    async close() {
      // Reproduce the real carrier close grace during which a naked pump rejection
      // can otherwise reach Node's unhandled-rejection machinery.
      await delay(50);
    },
  };
  const client = new CodexAppServerClient({ wire });
  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);

  try {
    await assert.rejects(async () => {
      for await (const _event of client.run({ prompt: 'work', thread: { kind: 'start' } })) {
        // Drain until the transport fails.
      }
    }, /transport exploded/);
    await delay(0);
  } finally {
    process.removeListener('unhandledRejection', onUnhandled);
  }

  assert.deepEqual(unhandled, []);
});

test('active-turn cancel evicts the host after authoritative interrupted terminal', async () => {
  const wire = new ProtocolWire();
  const controller = new AbortController();
  const client = new CodexAppServerClient({ wire });
  const outputPromise = collect(
    client.run({
      prompt: 'work',
      thread: { kind: 'start' },
      signal: controller.signal,
      interruptGraceMs: 50,
    }),
  );

  await waitFor(() => wire.writes.some((message) => message.method === 'turn/start'));
  controller.abort('user_cancel');
  await waitFor(() => wire.writes.some((message) => message.method === 'turn/interrupt'));
  assert.equal(wire.terminateCalls, 0, 'cooperative interrupt must get the full grace window');
  const interrupt = wire.writes.find((message) => message.method === 'turn/interrupt');
  assert.deepEqual(interrupt.params, { threadId: 'thread-1', turnId: 'turn-1' });

  wire.inbox.push({
    method: 'turn/completed',
    params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'interrupted' } },
  });
  const output = await outputPromise;
  assert.equal(
    wire.terminateCalls,
    1,
    'an interrupted app-server host must not return to the warm pool with stale active-turn state',
  );
  assert.equal(wire.closeCalls, 0, 'interrupted cleanup must evict instead of releasing the host as warm');
  assert.equal(
    output.some((event) => event.type === 'turn.completed' && event.status === 'interrupted'),
    true,
  );
});

test('interrupt grace expiry escalates to the carrier terminate fallback', async () => {
  const wire = new ProtocolWire();
  const controller = new AbortController();
  const lifecycle = [];
  const client = new CodexAppServerClient({ wire, onLifecycle: (snapshot) => lifecycle.push(snapshot) });
  const run = collect(
    client.run({
      prompt: 'work',
      thread: { kind: 'start' },
      signal: controller.signal,
      interruptGraceMs: 10,
    }),
  );
  const rejected = assert.rejects(run, /stream ended before turn completion/);

  await waitFor(() => wire.writes.some((message) => message.method === 'turn/start'));
  controller.abort('user_cancel');
  await waitFor(() => wire.terminateCalls === 1);
  await rejected;
  assert.equal(wire.writes.filter((message) => message.method === 'turn/interrupt').length, 1);
  const stages = lifecycle.map((snapshot) => snapshot.stage);
  assert.equal(stages.includes('failed'), true, 'forced cancel without a terminal response must fail canonically');
  assert.ok(stages.indexOf('failed') < stages.indexOf('closing'), 'failed must precede cleanup');
});

test('app-server timeout remains disabled at zero and positive opt-in uses protocol interrupt', async () => {
  const manualWire = new ProtocolWire();
  const manualClient = new CodexAppServerClient({ wire: manualWire });
  const manualRun = collect(manualClient.run({ prompt: 'work', thread: { kind: 'start' }, timeoutMs: 0 }));
  await waitFor(() => manualWire.writes.some((message) => message.method === 'turn/start'));
  await delay(25);
  assert.equal(
    manualWire.writes.some((message) => message.method === 'turn/interrupt'),
    false,
  );
  manualWire.inbox.push({
    method: 'turn/completed',
    params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } },
  });
  await manualRun;
  assert.equal(manualWire.closeCalls, 1, 'healthy completed turns still release their carrier normally');
  assert.equal(manualWire.terminateCalls, 0, 'host eviction is scoped to interrupted terminals');

  const timeoutWire = new ProtocolWire();
  const timeoutClient = new CodexAppServerClient({ wire: timeoutWire });
  const timeoutRun = collect(
    timeoutClient.run({
      prompt: 'work',
      thread: { kind: 'start' },
      timeoutMs: 10,
      interruptGraceMs: 50,
    }),
  );
  await waitFor(() => timeoutWire.writes.some((message) => message.method === 'turn/interrupt'));
  timeoutWire.inbox.push({
    method: 'turn/completed',
    params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'interrupted' } },
  });
  await timeoutRun;
  assert.equal(timeoutWire.terminateCalls, 1, 'timeout-interrupted hosts must also be evicted from the warm pool');
});

test('authoritative terminal result survives a cleanup failure', async () => {
  const wire = new ProtocolWire();
  wire.close = async () => {
    throw new Error('cleanup exploded');
  };
  const lifecycle = [];
  const client = new CodexAppServerClient({ wire, onLifecycle: (snapshot) => lifecycle.push(snapshot) });
  const run = collect(client.run({ prompt: 'work', thread: { kind: 'start' } }));
  await waitFor(() => wire.writes.some((message) => message.method === 'turn/start'));
  wire.inbox.push({
    method: 'turn/completed',
    params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } },
  });
  const output = await run;
  assert.equal(
    output.some((event) => event.type === 'turn.completed'),
    true,
  );
  const stages = lifecycle.map((snapshot) => snapshot.stage);
  assert.ok(stages.indexOf('completed') < stages.indexOf('closing'));
  assert.ok(stages.indexOf('closing') < stages.indexOf('closed'));
  assert.equal(lifecycle.at(-1).cleanupError, 'cleanup exploded');
});

test('early generator return releases the carrier before cleanup lifecycle can be abandoned', async () => {
  const wire = new ProtocolWire();
  const client = new CodexAppServerClient({ wire });
  const iterator = client.run({ prompt: 'work', thread: { kind: 'start' } });

  try {
    while (!wire.writes.some((message) => message.method === 'turn/start')) {
      const result = await iterator.next();
      assert.equal(result.done, false);
    }

    const returned = await iterator.return();
    assert.equal(returned.done, false, 'closing lifecycle remains observable to a draining consumer');
    assert.equal(wire.closeCalls, 1, 'critical carrier cleanup must precede the first yield in finally');
  } finally {
    await iterator.return();
  }
});

test('post-accept stream end transitions through failed before cleanup', async () => {
  const wire = new ProtocolWire();
  const lifecycle = [];
  const client = new CodexAppServerClient({ wire, onLifecycle: (snapshot) => lifecycle.push(snapshot) });
  const run = collect(client.run({ prompt: 'work', thread: { kind: 'start' } }));

  await waitFor(() => wire.writes.some((message) => message.method === 'turn/start'));
  wire.inbox.close();
  await assert.rejects(run, /stream ended before turn completion/);

  const stages = lifecycle.map((snapshot) => snapshot.stage);
  assert.ok(stages.indexOf('turn_accepted') >= 0);
  assert.ok(stages.indexOf('failed') > stages.indexOf('turn_accepted'));
  assert.ok(stages.indexOf('closing') > stages.indexOf('failed'));
  assert.match(lifecycle.find((snapshot) => snapshot.stage === 'failed').failureReason, /stream ended/);
});

test('pre-turn transport failure retries once without changing a requested thread identity', async () => {
  const first = new ProtocolWire();
  first.read = () => ({
    [Symbol.asyncIterator]() {
      return { next: async () => Promise.reject(new Error('startup transport failed')) };
    },
  });
  const second = new ProtocolWire();
  const wires = [first, second];
  let factoryCalls = 0;
  const run = collect(
    runCodexAppServerWithRecovery({
      sessionFactory: async () => wires[factoryCalls++],
      sessionOptions: { command: 'codex', args: ['app-server', '--stdio'], invocationId: 'inv-retry' },
      runInput: { prompt: 'continue', thread: { kind: 'resume', threadId: 'thread-existing' } },
      retryBudget: 1,
    }),
  );
  await waitFor(() => second.writes.some((message) => message.method === 'turn/start'));
  second.inbox.push({
    method: 'turn/completed',
    params: { threadId: 'thread-existing', turn: { id: 'turn-1', status: 'completed' } },
  });
  const output = await run;
  assert.equal(factoryCalls, 2);
  assert.equal(second.writes.find((message) => message.method === 'thread/resume').params.threadId, 'thread-existing');
  assert.equal(output.filter((event) => event.type === 'app_server.recovery').length, 1);
});

test('model-capacity failure retries the accepted turn on the same thread without leaking the failed attempt', async () => {
  const first = new ProtocolWire();
  const second = new ProtocolWire();
  const wires = [first, second];
  let factoryCalls = 0;
  const run = collect(
    runCodexAppServerWithRecovery({
      sessionFactory: async () => wires[factoryCalls++],
      sessionOptions: { command: 'codex', args: ['app-server', '--stdio'], invocationId: 'inv-capacity-retry' },
      runInput: { prompt: 'do safe work', thread: { kind: 'start' } },
      recoveryAnchor: {
        threadId: 'cat-thread-7',
        invocationId: 'inv-capacity-retry',
        promptMessageIds: ['message-safe-work'],
      },
      retryBudget: 1,
      modelCapacityRetryDelaysMs: [0],
    }),
  );

  await waitFor(() => first.writes.some((message) => message.method === 'turn/start'));
  first.inbox.push({
    method: 'item/started',
    params: { threadId: 'thread-1', turnId: 'turn-1', item: { id: 'user-1', type: 'userMessage' } },
  });
  first.inbox.push({
    method: 'item/completed',
    params: { threadId: 'thread-1', turnId: 'turn-1', item: { id: 'user-1', type: 'userMessage' } },
  });
  first.inbox.push({
    method: 'turn/completed',
    params: {
      threadId: 'thread-1',
      turn: {
        id: 'turn-1',
        status: 'failed',
        error: { message: 'Selected model is at capacity. Please try a different model.' },
      },
    },
  });

  await waitFor(() => second.writes.some((message) => message.method === 'turn/start'));
  second.inbox.push({
    method: 'turn/completed',
    params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } },
  });

  const output = await run;
  const recovery = output.find((event) => event.type === 'app_server.recovery');
  assert.equal(factoryCalls, 2);
  assert.equal(recovery.reason, 'model_capacity');
  assert.equal(recovery.delayMs, 0);
  assert.equal(second.writes.find((message) => message.method === 'thread/resume').params.threadId, 'thread-1');
  const retryTurn = second.writes.find((message) => message.method === 'turn/start');
  assert.deepEqual(
    first.writes.find((message) => message.method === 'initialize').params.capabilities,
    {},
    'ordinary turns must not opt into experimental app-server APIs',
  );
  assert.deepEqual(
    second.writes.find((message) => message.method === 'initialize').params.capabilities,
    { experimentalApi: true },
    'recovery turns must declare the capability required by additionalContext',
  );
  assert.deepEqual(retryTurn.params.input, [], 'capacity recovery must not append a persisted user message');
  const recoveryContext = retryTurn.params.additionalContext?.['cat-cafe.capacity-recovery'];
  assert.equal(recoveryContext?.kind, 'application');
  assert.ok(recoveryContext.value.length <= 200, 'internal recovery context must stay tightly bounded');
  assert.match(recoveryContext.value, /interrupted turn/i);
  assert.match(recoveryContext.value, /verify current state/i);
  assert.doesNotMatch(recoveryContext.value, /inv-capacity-retry|message-safe-work|cat-thread-7/);
  assert.doesNotMatch(recoveryContext.value, /latest recorded plan|observed tool ledger/i);
  assert.equal(
    output.some((event) => event.type === 'turn.failed'),
    false,
    'a recovered provider failure must not become a user-visible Clowder AI error',
  );
});

test('model-capacity failure without exact Clowder AI task coordinates blocks instead of guessing', async () => {
  const wire = new ProtocolWire();
  const run = collectFailure(
    runCodexAppServerWithRecovery({
      sessionFactory: async () => wire,
      sessionOptions: { command: 'codex', args: ['app-server', '--stdio'], invocationId: 'inv-missing-anchor' },
      runInput: { prompt: 'ambiguous internal work', thread: { kind: 'start' } },
      modelCapacityRetryDelaysMs: [0],
    }),
  );

  await waitFor(() => wire.writes.some((message) => message.method === 'turn/start'));
  wire.inbox.push({
    method: 'turn/completed',
    params: {
      threadId: 'thread-1',
      turn: {
        id: 'turn-1',
        status: 'failed',
        error: { message: 'Selected model is at capacity. Please try a different model.' },
      },
    },
  });

  const { values, error } = await run;
  assert.match(error.message, /Selected model is at capacity/);
  assert.equal(wire.writes.filter((message) => message.method === 'turn/start').length, 1);
  assert.equal(values.find((event) => event.type === 'app_server.recovery_blocked')?.reason, 'checkpoint_incomplete');
});

test('model-capacity recovery after completed tools resumes the exact invocation checkpoint', async () => {
  const first = new ProtocolWire();
  const second = new ProtocolWire();
  const wires = [first, second];
  let factoryCalls = 0;
  const run = collect(
    runCodexAppServerWithRecovery({
      sessionFactory: async () => wires[factoryCalls++],
      sessionOptions: { command: 'codex', args: ['app-server', '--stdio'], invocationId: 'inv-checkpoint' },
      runInput: { prompt: 'review pull request 42', thread: { kind: 'start' } },
      recoveryAnchor: {
        threadId: 'cat-thread-7',
        invocationId: 'inv-checkpoint',
        promptMessageIds: ['message-42'],
      },
      modelCapacityRetryDelaysMs: [0],
    }),
  );

  await waitFor(() => first.writes.some((message) => message.method === 'turn/start'));
  first.inbox.push({
    method: 'turn/plan/updated',
    params: {
      threadId: 'thread-1',
      turnId: 'turn-1',
      explanation: 'The exact-head review is in progress.',
      plan: [
        { step: 'Lock pull request 42 exact HEAD', status: 'completed' },
        { step: 'Finish review of pull request 42', status: 'inProgress' },
        { step: 'Publish the exact-HEAD verdict', status: 'pending' },
      ],
    },
  });
  first.inbox.push({
    method: 'item/started',
    params: {
      threadId: 'thread-1',
      turnId: 'turn-1',
      item: { id: 'command-1', type: 'commandExecution', command: 'gh pr view 42' },
    },
  });
  first.inbox.push({
    method: 'item/completed',
    params: {
      threadId: 'thread-1',
      turnId: 'turn-1',
      item: {
        id: 'command-1',
        type: 'commandExecution',
        command: 'gh pr view 42',
        status: 'completed',
        exitCode: 0,
      },
    },
  });
  first.inbox.push({
    method: 'turn/completed',
    params: {
      threadId: 'thread-1',
      turn: {
        id: 'turn-1',
        status: 'failed',
        error: { message: 'Selected model is at capacity. Please try a different model.' },
      },
    },
  });

  await waitFor(() => second.writes.some((message) => message.method === 'turn/start'));
  second.inbox.push({
    method: 'turn/completed',
    params: { threadId: 'thread-1', turn: { id: 'turn-2', status: 'completed' } },
  });

  await run;
  const retryTurn = second.writes.find((message) => message.method === 'turn/start');
  assert.deepEqual(retryTurn.params.input, [], 'checkpoint details must not become a visible user message');
  const recoveryContext = retryTurn.params.additionalContext?.['cat-cafe.capacity-recovery'];
  assert.equal(recoveryContext?.kind, 'application');
  assert.ok(recoveryContext.value.length <= 360, 'post-tool recovery context must stay tightly bounded');
  assert.match(recoveryContext.value, /interrupted turn/i);
  assert.match(recoveryContext.value, /verify current state/i);
  assert.match(recoveryContext.value, /Finish review of pull request 42/);
  assert.doesNotMatch(recoveryContext.value, /inv-checkpoint|cat-thread-7|message-42/);
  assert.doesNotMatch(recoveryContext.value, /Lock pull request 42|Publish the exact-HEAD verdict|gh pr view 42/);
  assert.doesNotMatch(recoveryContext.value, /latest recorded plan|observed tool ledger/i);
});

test('repeated model-capacity attempts reuse one hidden recovery context without adding user messages', async () => {
  const first = new ProtocolWire();
  const second = new ProtocolWire();
  const third = new ProtocolWire();
  const wires = [first, second, third];
  let factoryCalls = 0;
  const run = collect(
    runCodexAppServerWithRecovery({
      sessionFactory: async () => wires[factoryCalls++],
      sessionOptions: { command: 'codex', args: ['app-server', '--stdio'], invocationId: 'inv-capacity-repeat' },
      runInput: { prompt: 'do safe work', thread: { kind: 'start' } },
      recoveryAnchor: {
        threadId: 'cat-thread-repeat',
        invocationId: 'inv-capacity-repeat',
        promptMessageIds: ['message-repeat'],
      },
      modelCapacityRetryDelaysMs: [0, 0],
    }),
  );
  const failCapacity = (wire, turnId) =>
    wire.inbox.push({
      method: 'turn/completed',
      params: {
        threadId: 'thread-1',
        turn: {
          id: turnId,
          status: 'failed',
          error: { message: 'Selected model is at capacity. Please try a different model.' },
        },
      },
    });

  await waitFor(() => first.writes.some((message) => message.method === 'turn/start'));
  failCapacity(first, 'turn-1');
  await waitFor(() => second.writes.some((message) => message.method === 'turn/start'));
  failCapacity(second, 'turn-2');
  await waitFor(() => third.writes.some((message) => message.method === 'turn/start'));
  third.inbox.push({
    method: 'turn/completed',
    params: { threadId: 'thread-1', turn: { id: 'turn-3', status: 'completed' } },
  });

  await run;
  const recoveryTurns = [second, third].map((wire) => wire.writes.find((message) => message.method === 'turn/start'));
  assert.deepEqual(
    recoveryTurns.map((turn) => turn.params.input),
    [[], []],
    'no retry may append a recovery user message',
  );
  assert.deepEqual(
    recoveryTurns.map((turn) => turn.params.additionalContext?.['cat-cafe.capacity-recovery']),
    [
      recoveryTurns[0].params.additionalContext['cat-cafe.capacity-recovery'],
      recoveryTurns[0].params.additionalContext['cat-cafe.capacity-recovery'],
    ],
    'the stable application-context key lets the provider deduplicate repeated recovery attempts',
  );
});

test('model-capacity failure after a tool starts fails closed without replay', async () => {
  const first = new ProtocolWire();
  const second = new ProtocolWire();
  let factoryCalls = 0;
  const run = collectFailure(
    runCodexAppServerWithRecovery({
      sessionFactory: async () => (factoryCalls++ === 0 ? first : second),
      sessionOptions: { command: 'codex', args: ['app-server', '--stdio'], invocationId: 'inv-capacity-tool' },
      runInput: { prompt: 'do side effects', thread: { kind: 'start' } },
      retryBudget: 1,
      modelCapacityRetryDelaysMs: [0],
    }),
  );

  await waitFor(() => first.writes.some((message) => message.method === 'turn/start'));
  first.inbox.push({
    method: 'item/started',
    params: {
      threadId: 'thread-1',
      turnId: 'turn-1',
      item: { id: 'command-1', type: 'commandExecution', command: 'echo already-ran' },
    },
  });
  first.inbox.push({
    method: 'turn/completed',
    params: {
      threadId: 'thread-1',
      turn: {
        id: 'turn-1',
        status: 'failed',
        error: { message: 'Selected model is at capacity. Please try a different model.' },
      },
    },
  });

  const { values, error } = await run;
  assert.match(error.message, /Selected model is at capacity/);
  assert.equal(factoryCalls, 1);
  assert.equal(second.writes.length, 0);
  assert.equal(values.find((event) => event.type === 'app_server.recovery_blocked')?.reason, 'blocked_inflight_tool');
});

test('model-capacity failure after terminal tools without a plan blocks instead of guessing the task', async () => {
  const wire = new ProtocolWire();
  const run = collectFailure(
    runCodexAppServerWithRecovery({
      sessionFactory: async () => wire,
      sessionOptions: { command: 'codex', args: ['app-server', '--stdio'], invocationId: 'inv-no-plan' },
      runInput: { prompt: 'work on one exact task', thread: { kind: 'start' } },
      recoveryAnchor: {
        threadId: 'cat-thread-7',
        invocationId: 'inv-no-plan',
        promptMessageIds: ['message-no-plan'],
      },
      modelCapacityRetryDelaysMs: [0],
    }),
  );

  await waitFor(() => wire.writes.some((message) => message.method === 'turn/start'));
  wire.inbox.push({
    method: 'item/started',
    params: {
      threadId: 'thread-1',
      turnId: 'turn-1',
      item: { id: 'command-1', type: 'commandExecution', command: 'echo done' },
    },
  });
  wire.inbox.push({
    method: 'item/completed',
    params: {
      threadId: 'thread-1',
      turnId: 'turn-1',
      item: { id: 'command-1', type: 'commandExecution', command: 'echo done', status: 'completed' },
    },
  });
  wire.inbox.push({
    method: 'turn/completed',
    params: {
      threadId: 'thread-1',
      turn: {
        id: 'turn-1',
        status: 'failed',
        error: { message: 'Selected model is at capacity. Please try a different model.' },
      },
    },
  });

  const { values, error } = await run;
  assert.match(error.message, /Selected model is at capacity/);
  assert.equal(wire.writes.filter((message) => message.method === 'turn/start').length, 1);
  assert.equal(values.find((event) => event.type === 'app_server.recovery_blocked')?.reason, 'checkpoint_incomplete');
});

test('model-capacity retry budget is bounded and exposes only the final failure', async () => {
  const first = new ProtocolWire();
  const second = new ProtocolWire();
  const wires = [first, second];
  let factoryCalls = 0;
  const run = collectFailure(
    runCodexAppServerWithRecovery({
      sessionFactory: async () => wires[factoryCalls++],
      sessionOptions: { command: 'codex', args: ['app-server', '--stdio'], invocationId: 'inv-capacity-bounded' },
      runInput: { prompt: 'do safe work', thread: { kind: 'start' } },
      recoveryAnchor: {
        threadId: 'cat-thread-7',
        invocationId: 'inv-capacity-bounded',
        promptMessageIds: ['message-bounded'],
      },
      modelCapacityRetryDelaysMs: [0],
    }),
  );
  const failCapacity = (wire) =>
    wire.inbox.push({
      method: 'turn/completed',
      params: {
        threadId: 'thread-1',
        turn: {
          id: 'turn-1',
          status: 'failed',
          error: { message: 'Selected model is at capacity. Please try a different model.' },
        },
      },
    });

  await waitFor(() => first.writes.some((message) => message.method === 'turn/start'));
  failCapacity(first);
  await waitFor(() => second.writes.some((message) => message.method === 'turn/start'));
  failCapacity(second);

  const { values, error } = await run;
  assert.match(error.message, /Selected model is at capacity/);
  assert.equal(factoryCalls, 2);
  assert.equal(values.filter((event) => event.type === 'app_server.recovery').length, 1);
  assert.equal(values.filter((event) => event.type === 'turn.failed').length, 1);
  assert.equal(values.find((event) => event.type === 'app_server.recovery_blocked')?.reason, 'budget_exhausted');
});

test('explicit pre-turn timeout does not restart the transport', async () => {
  let factoryCalls = 0;
  const run = collect(
    runCodexAppServerWithRecovery({
      sessionFactory: async () => {
        factoryCalls++;
        const wire = new ProtocolWire();
        wire.write = async (message) => wire.writes.push(message);
        return wire;
      },
      sessionOptions: { command: 'codex', args: ['app-server', '--stdio'], invocationId: 'inv-timeout' },
      runInput: { prompt: 'work', thread: { kind: 'start' }, timeoutMs: 10 },
      retryBudget: 1,
    }),
  );

  await assert.rejects(run, /closed/);
  assert.equal(factoryCalls, 1, 'an operator-requested timeout is terminal, not a startup crash to retry');
});

test('accepted turns fail closed without transport restart or prompt replay', async () => {
  const first = new ProtocolWire();
  const second = new ProtocolWire();
  const lifecycle = [];
  let factoryCalls = 0;
  const run = collect(
    runCodexAppServerWithRecovery({
      sessionFactory: async () => (factoryCalls++ === 0 ? first : second),
      sessionOptions: { command: 'codex', args: ['app-server', '--stdio'], invocationId: 'inv-no-replay' },
      runInput: { prompt: 'do side effects', thread: { kind: 'start' } },
      clientDeps: { onLifecycle: (snapshot) => lifecycle.push(snapshot) },
      retryBudget: 1,
    }),
  );
  await waitFor(() => first.writes.some((message) => message.method === 'turn/start'));
  first.inbox.fail(new Error('transport lost after acceptance'));
  await assert.rejects(run, /transport lost after acceptance/);
  assert.equal(factoryCalls, 1);
  assert.equal(second.writes.length, 0);
  const stages = lifecycle.map((snapshot) => snapshot.stage);
  assert.ok(stages.indexOf('failed') > stages.indexOf('turn_accepted'));
  assert.ok(stages.indexOf('closing') > stages.indexOf('failed'));
  assert.equal(
    lifecycle.find((snapshot) => snapshot.stage === 'failed').failureReason,
    'transport lost after acceptance',
  );
});
