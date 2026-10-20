import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { createCatId } from '@cat-cafe/shared';
import { ClaudeSdkAgentService } from '../src/domains/cats/services/agents/providers/ClaudeSdkAgentService.js';
import type { AgentClientActiveRunDispatcher, AgentServiceOptions } from '../src/domains/cats/services/types.js';

const task = { task_id: 'child', task_type: 'local_agent', description: 'research' };
const watcher = { task_id: 'watcher', task_type: 'local_bash', description: 'watch', ambient: true };
const snapshot = (...tasks: (typeof task & { ambient?: boolean })[]) => ({
  type: 'system',
  subtype: 'background_tasks_changed',
  tasks,
});
const result = (uuid?: string) => ({
  type: 'result',
  subtype: 'success',
  session_id: 'session',
  queued_turn_count: 0,
  ...(uuid ? { user_message_uuids: [uuid] } : { origin: { kind: 'task-notification' } }),
});
const report = { type: 'system', subtype: 'task_notification', task_id: task.task_id, status: 'completed' };
const idle = { type: 'system', subtype: 'session_state_changed', state: 'idle' };
const summary = {
  type: 'assistant',
  message: { content: [{ type: 'text', text: 'parent collected the report' }] },
};

interface ScriptContext {
  first: SDKUserMessage;
  input: AsyncIterator<SDKUserMessage>;
  signal: AbortSignal;
  closed(): number;
}

function fixture(
  script: (context: ScriptContext) => AsyncGenerator<unknown>,
  interrupt: () => Promise<void> = async () => {},
) {
  let closes = 0;
  const service = new ClaudeSdkAgentService({
    catId: createCatId('opus'),
    model: 'claude-opus-4-6',
    mcpServerPath: '',
    l0CompilerFn: async () => 'identity',
    rawArchive: { append: async () => {} },
    queryFn: ({ prompt, options }) => ({
      close() {
        closes++;
      },
      interrupt,
      async *[Symbol.asyncIterator]() {
        const input = prompt[Symbol.asyncIterator]();
        const first = (await input.next()).value as SDKUserMessage;
        yield { type: 'system', subtype: 'init', session_id: 'session' };
        yield { ...idle, state: 'running' };
        assert.ok(options.abortController);
        yield* script({ first, input, signal: options.abortController.signal, closed: () => closes });
        yield idle;
      },
    }),
  });
  return { service, closed: () => closes };
}

async function collect(service: ClaudeSdkAgentService, options?: AgentServiceOptions) {
  const events = [];
  for await (const event of service.invoke('research', { workingDirectory: '/tmp', ...options })) events.push(event);
  return events;
}

for (const levelFirst of [true, false]) {
  test(`background report reaches the parent before closing (level first: ${levelFirst})`, async () => {
    let reachedReport = false;
    const { service, closed } = fixture(async function* ({ first, closed }) {
      yield snapshot(task);
      yield result(first.uuid);
      assert.equal(closed(), 0, 'the primary reply must not close a running child');
      reachedReport = true;
      // Native level/edge ordering is unspecified. Neither is the parent turn's result.
      yield levelFirst ? snapshot() : report;
      yield levelFirst ? report : snapshot();
      yield summary;
      yield result();
    });
    const events = await collect(service);
    assert.equal(reachedReport, true, 'the SDK must keep consuming after the primary result');
    assert.ok(events.some((event) => event.type === 'text' && event.content === 'parent collected the report'));
    assert.equal(
      events.some((event) => event.type === 'error'),
      false,
    );
    assert.equal(closed(), 1);
  });
}

test('native idle closes despite missed task bookends and ambient watchers', async () => {
  let reachedFinalResult = false;
  const { service, closed } = fixture(async function* ({ first }) {
    yield snapshot(task, { ...task, task_id: 'second' });
    yield result(first.uuid);
    // No stop edge for the first child: the level snapshot is authoritative.
    yield snapshot({ ...task, task_id: 'second' }, watcher);
    yield result();
    yield snapshot(watcher);
    yield summary;
    reachedFinalResult = true;
    yield result();
    yield idle;
    assert.fail('an ambient watcher must not keep the query open');
  });
  const events = await collect(service);
  assert.equal(reachedFinalResult, true);
  assert.equal(
    events.some((event) => event.type === 'error'),
    false,
  );
  assert.equal(closed(), 1);
});

test('all child reports drain before native idle even after task membership reaches zero', async () => {
  const { service } = fixture(async function* ({ first }) {
    yield snapshot(task, { ...task, task_id: 'second' });
    yield result(first.uuid);
    yield snapshot();
    yield report;
    yield { ...report, task_id: 'second' };
    yield result(); // zero-turn or partial notification result, not session idle
    yield { ...summary, message: { content: [{ type: 'text', text: 'both reports collected' }] } };
    yield result();
  });
  const events = await collect(service);
  assert.ok(events.some((event) => event.type === 'text' && event.content === 'both reports collected'));
  assert.equal(
    events.some((event) => event.type === 'error'),
    false,
  );
});

test('a connection failure after a result but before native idle cannot masquerade as completion', async () => {
  const { service } = fixture(async function* ({ first }) {
    yield result(first.uuid);
    throw new Error('connection closed before idle');
  });
  const events = await collect(service);
  assert.ok(events.some((event) => event.type === 'error' && event.error === 'connection closed before idle'));
});

for (const force of [false, true]) {
  test(`${force ? 'Steer' : 'Append'} accepted while waiting for a child still receives its own result`, async () => {
    let dispatcher: AgentClientActiveRunDispatcher | undefined;
    let appended = false;
    let interrupts = 0;
    const { service, closed } = fixture(
      async function* ({ first, input }) {
        yield snapshot(task);
        yield result(first.uuid);
        assert.ok(dispatcher);
        const receipt = await dispatcher.dispatch(
          { text: 'include this correction' },
          { expectedInvocationId: 'i', force },
        );
        assert.equal(receipt.accepted, true);
        const append = (await input.next()).value as SDKUserMessage;
        appended = true;
        yield snapshot();
        yield report;
        yield result();
        yield summary;
        yield result(append.uuid);
      },
      async () => {
        interrupts++;
      },
    );
    const events = await collect(service, {
      invocationId: 'i',
      activeRunDispatch: {
        invocationId: 'i',
        register(value) {
          dispatcher = value;
          return () => {};
        },
      },
    });
    assert.equal(appended, true);
    assert.equal(
      events.some((event) => event.type === 'error'),
      false,
    );
    assert.equal(closed(), 1);
    assert.equal(interrupts, force ? 1 : 0);
  });
}

test('a failed Steer between child completion and its parent report cannot close the query', async () => {
  let dispatcher: AgentClientActiveRunDispatcher | undefined;
  let reachedReport = false;
  const { service } = fixture(
    async function* ({ first, input }) {
      yield snapshot(task);
      yield result(first.uuid);
      yield snapshot();
      assert.ok(dispatcher);
      const rejected = await dispatcher.dispatch({ text: 'steer' }, { expectedInvocationId: 'i', force: true });
      assert.equal(rejected.accepted, false);
      const retry = await dispatcher.dispatch({ text: 'append instead' }, { expectedInvocationId: 'i', force: false });
      assert.equal(retry.accepted, true, 'the last reply cannot close input while its child report is pending');
      const append = (await input.next()).value as SDKUserMessage;
      yield report;
      yield summary;
      reachedReport = true;
      yield result(append.uuid);
    },
    async () => {
      throw new Error('interrupt rejected');
    },
  );
  const events = await collect(service, {
    invocationId: 'i',
    activeRunDispatch: {
      invocationId: 'i',
      register(value) {
        dispatcher = value;
        return () => {};
      },
    },
  });
  assert.equal(reachedReport, true);
  assert.ok(events.some((event) => event.type === 'text' && event.content === 'parent collected the report'));
  assert.equal(
    events.some((event) => event.type === 'error'),
    false,
  );
});

test('Stop cancels a query waiting for background work without waiting for a completion result', async () => {
  const controller = new AbortController();
  let waiting!: () => void;
  const atWait = new Promise<void>((resolve) => {
    waiting = resolve;
  });
  const { service, closed } = fixture(async function* ({ first, signal }) {
    yield snapshot(task);
    yield result(first.uuid);
    waiting();
    await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
  });
  const running = collect(service, { signal: controller.signal });
  await Promise.race([atWait, running.then(() => assert.fail('query ended before Stop'))]);
  assert.equal(closed(), 0);
  controller.abort('user_stop');
  const events = await running;
  assert.equal(events.at(-1)?.type, 'done');
  assert.equal(
    events.some((event) => event.type === 'error'),
    false,
  );
  assert.equal(closed(), 1);
});
