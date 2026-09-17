import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import { CodexAgentService } from '../dist/domains/cats/services/agents/providers/CodexAgentService.js';
import { runCodexAppServerWithRecovery } from '../dist/domains/cats/services/agents/providers/CodexAppServerRunner.js';
import { classifyCliError } from '../dist/utils/cli-diagnostics.js';
import { fakeL0Compiler } from './helpers/fake-l0-compiler.js';

const CAPACITY = 'Selected model is at capacity. Please try a different model.';
const COMPACT_CAPACITY = `Error running remote compact task: ${CAPACITY}`;
const anchor = { threadId: 'cafe-thread', invocationId: 'inv-compact', promptMessageIds: ['message-work'] };

function notification(method, params) {
  return { method, params: { threadId: 'native-thread', turnId: 'turn-1', ...params } };
}

function progress({ inFlight = false, plan = false } = {}) {
  return [
    notification('item/completed', {
      item: {
        id: 'progress',
        type: 'agentMessage',
        text: 'I am checking the failed gate, then finishing the same PR.',
      },
    }),
    ...(plan
      ? [notification('turn/plan/updated', { plan: [{ step: 'Finish the same PR', status: 'inProgress' }] })]
      : []),
    ...[1, 2, 3].flatMap((id) => {
      const item = { id: `command-${id}`, type: 'commandExecution', command: 'read existing gate output' };
      return [
        notification('item/started', { item }),
        ...(inFlight && id === 3 ? [] : [notification('item/completed', { item: { ...item, status: 'completed' } })]),
      ];
    }),
    notification('item/started', { item: { id: 'compact-1', type: 'contextCompaction' } }),
  ];
}

class CapacityWire {
  inbox = new Readable({ objectMode: true, read() {} });
  writes = [];

  constructor(events, terminal = { status: 'completed' }) {
    this.events = events;
    this.terminal = terminal;
  }

  read() {
    return this.inbox;
  }

  async write(message) {
    this.writes.push(message);
    if (message.method === 'initialize') this.inbox.push({ id: message.id, result: {} });
    if (message.method === 'thread/resume' && this.resumeRejection) {
      if (this.resumeRejection === 'carrier') this.inbox.destroy(new Error('Max payload size exceeded'));
      else
        this.inbox.push({
          id: message.id,
          error: { code: -32600, message: 'no rollout found for thread id native-thread' },
        });
      return;
    }
    if (message.method === 'thread/start' || message.method === 'thread/resume') {
      this.inbox.push({
        id: message.id,
        result: { thread: { id: this.resumedThreadId ?? 'native-thread', turns: [] } },
      });
    }
    if (message.method === 'turn/start') {
      this.inbox.push({ id: message.id, result: { turn: { id: 'turn-1', status: 'inProgress' } } });
      setImmediate(() => {
        for (const event of this.events) this.inbox.push(event);
        if (this.terminal) {
          this.inbox.push(notification('turn/completed', { turn: { id: 'turn-1', ...this.terminal } }));
        } else this.inbox.push(null);
      });
    }
  }

  async close() {
    this.inbox.push(null);
  }
}

function capacityWire(message = COMPACT_CAPACITY, options = {}) {
  const error = { message, codexErrorInfo: 'serverOverloaded' };
  return new CapacityWire([...progress(options), notification('error', { error, willRetry: false })], {
    status: 'failed',
    error,
  });
}

function successWire() {
  return new CapacityWire([
    notification('item/completed', {
      item: { id: 'answer', type: 'agentMessage', text: 'The interrupted work is done.' },
    }),
  ]);
}

async function runWires(wires, overrides = {}) {
  const output = [];
  let calls = 0;
  let error;
  try {
    for await (const event of runCodexAppServerWithRecovery({
      sessionFactory: async () => {
        const wire = wires[calls++];
        assert.ok(wire, 'must not exceed the supplied recovery budget');
        return wire;
      },
      sessionOptions: { command: 'codex', args: ['app-server'], invocationId: anchor.invocationId },
      runInput: {
        prompt: { kind: 'frozen', prompt: 'Finish this PR' },
        thread: { kind: 'resume', threadId: 'native-thread' },
      },
      recoveryAnchor: anchor,
      modelCapacityRetryDelaysMs: [0],
      ...overrides,
    })) {
      output.push(event);
      overrides.onEvent?.(event);
    }
  } catch (failure) {
    error = failure;
  }
  return { output, error, calls };
}

test('organic remote-compaction capacity failure resumes completed work without a plan or a leaked error', async () => {
  // e3ede9b6: completed commentary + three terminal tools + unfinished contextCompaction,
  // then error(willRetry=false) and turn/completed(failed, serverOverloaded).
  const first = capacityWire();
  const second = successWire();
  const { output, error, calls } = await runWires([first, second]);
  assert.equal(error, undefined);
  assert.equal(calls, 2);
  assert.equal(output.filter((event) => event.type === 'app_server.recovery').length, 1);
  assert.equal(
    output.some((event) => event.type === 'error' || event.type === 'turn.failed'),
    false,
  );
  const resumed = second.writes.find((message) => message.method === 'turn/start').params;
  assert.deepEqual(resumed.input, [], 'never persist or replay the original user prompt');
  assert.match(resumed.additionalContext['cat-cafe.capacity-recovery'].value, /interrupted turn/);
  assert.match(resumed.additionalContext['cat-cafe.capacity-recovery'].value, /Verify current state/);
  assert.equal(
    second.writes.some((message) => message.method === 'thread/start'),
    false,
  );
  assert.equal(second.writes.find((message) => message.method === 'thread/resume').params.threadId, 'native-thread');
});

test('the early capacity error notification stays private when the existing planned recovery succeeds', async () => {
  const { output, error } = await runWires([capacityWire(CAPACITY, { plan: true }), successWire()]);
  assert.equal(error, undefined);
  assert.equal(
    output.some((event) => event.type === 'error' || event.type === 'turn.failed'),
    false,
  );
});

test('upstream recovers its own capacity notification without starting another turn or leaking the notice', async () => {
  const wire = new CapacityWire([notification('error', { error: { message: COMPACT_CAPACITY }, willRetry: true })]);
  const { output, error, calls } = await runWires([wire]);
  assert.equal(error, undefined);
  assert.equal(calls, 1);
  assert.equal(
    output.some((event) => event.type === 'error'),
    false,
  );
});

test('a capacity notification without an authoritative terminal cannot authorize replay', async () => {
  const wire = new CapacityWire(
    [notification('error', { error: { message: COMPACT_CAPACITY }, willRetry: false })],
    null,
  );
  const { error, calls } = await runWires([wire]);
  assert.match(error.message, /stream ended before turn completion/);
  assert.equal(calls, 1);
});

test('completed progress never overrides an in-flight tool', async () => {
  const { output, error, calls } = await runWires([capacityWire(COMPACT_CAPACITY, { inFlight: true })]);
  assert.ok(error);
  assert.equal(calls, 1);
  assert.equal(output.find((event) => event.type === 'app_server.recovery_blocked')?.reason, 'blocked_inflight_tool');
});

test('a remote-compaction error still requires exact task coordinates', async () => {
  const { output, error, calls } = await runWires([capacityWire()], { recoveryAnchor: undefined });
  assert.ok(error);
  assert.equal(calls, 1);
  assert.equal(output.find((event) => event.type === 'app_server.recovery_blocked')?.reason, 'checkpoint_incomplete');
});

test('the tool ledger includes native collaboration calls alongside completed commands', async () => {
  for (const completed of [false, true]) {
    const first = capacityWire();
    const item = { id: 'collaboration-1', type: 'collabAgentToolCall', tool: 'spawnAgent' };
    first.events.splice(first.events.length - 1, 0, notification('item/started', { item }));
    if (completed) first.events.splice(first.events.length - 1, 0, notification('item/completed', { item }));
    const { output, error, calls } = await runWires([first, successWire()]);
    assert.equal(calls, completed ? 2 : 1, 'an unfinished native collaboration call must prevent replay');
    if (completed) assert.equal(error, undefined);
    else {
      assert.ok(error);
      assert.equal(
        output.find((event) => event.type === 'app_server.recovery_blocked')?.reason,
        'blocked_inflight_tool',
      );
    }
  }
});

test('capacity retry exhaustion preserves one honest blocked terminal', async () => {
  const { output, error, calls } = await runWires([capacityWire(), capacityWire()]);
  assert.ok(error);
  assert.equal(calls, 2);
  assert.equal(output.filter((event) => event.type === 'app_server.recovery_blocked').length, 1);
  assert.equal(output.find((event) => event.type === 'app_server.recovery_blocked').reason, 'budget_exhausted');
});

test('cancelling during capacity backoff prevents another carrier from being acquired', async () => {
  const controller = new AbortController();
  const { error, calls } = await runWires([capacityWire()], {
    runInput: {
      prompt: { kind: 'frozen', prompt: 'Finish this PR' },
      thread: { kind: 'resume', threadId: 'native-thread' },
      signal: controller.signal,
    },
    onEvent: (event) => {
      if (event.type === 'app_server.recovery') controller.abort(new Error('owner cancelled'));
    },
  });
  assert.match(error.message, /owner cancelled/);
  assert.equal(calls, 1);
});

test('unrelated remote-compaction failures do not enter model-capacity recovery', async () => {
  for (const message of [
    'Error running remote compact task: 401 Unauthorized',
    `${COMPACT_CAPACITY} unexpected suffix`,
  ]) {
    const { error, calls, output } = await runWires([capacityWire(message)]);
    assert.equal(error.message, message);
    assert.equal(calls, 1);
    assert.equal(
      output.some((event) => event.type === 'app_server.recovery'),
      false,
    );
  }
});

test('both observed capacity wordings classify as temporary provider overload', () => {
  assert.equal(classifyCliError(CAPACITY), 'server_overloaded');
  assert.equal(classifyCliError(COMPACT_CAPACITY), 'server_overloaded');
});

test('capacity continuation cannot replace a missing native thread or accept a different one', async () => {
  for (const mode of ['rpc', 'carrier', 'mismatch']) {
    const rejected = successWire();
    if (mode === 'mismatch') rejected.resumedThreadId = 'different-native-thread';
    else rejected.resumeRejection = mode;
    const wires = [capacityWire(CAPACITY, { plan: true }), rejected, successWire()];
    const { error } = await runWires(wires);
    assert.ok(error, `${mode}: lost native history cannot count as recovered`);
    assert.equal(
      wires
        .slice(1)
        .flatMap((wire) => wire.writes)
        .some((message) => message.method === 'thread/start' || message.method === 'turn/start'),
      false,
      `${mode}: recovery must stop before generating against a replacement or mismatched context`,
    );
  }
});

test('CodexAgentService delivers recovered work without a CLI error or a breakpoint card', async () => {
  const wires = [capacityWire(), successWire()];
  const service = new CodexAgentService({
    carrierMode: 'app_server',
    cliCommand: process.execPath,
    l0CompilerFn: fakeL0Compiler,
    model: 'gpt-test',
  });
  const output = [];
  for await (const event of service.invoke('Finish this PR', {
    invocationId: anchor.invocationId,
    sessionId: 'native-thread',
    recoveryAnchor: anchor,
    agentCarrierSessionFactory: async () => {
      assert.ok(wires.length, 'must not start an unrelated third attempt');
      return wires.shift();
    },
  }))
    output.push(event);
  assert.equal(
    output.some((event) => event.type === 'error'),
    false,
  );
  assert.equal(
    output.some((event) => event.type === 'system_info' && event.content.includes('codex_capacity_recovery')),
    false,
  );
  assert.ok(output.some((event) => event.type === 'text' && event.content.includes('interrupted work is done')));
  assert.ok(output.some((event) => event.type === 'done'));
});
