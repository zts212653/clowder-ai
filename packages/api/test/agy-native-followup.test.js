import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { AgyNativeAgentService } from '../dist/domains/cats/services/agents/providers/agy-native/AgyNativeAgentService.js';
import { appendRecoveryFixture } from './helpers/append-recovery-fixture.js';

const model = 'gemini-3.8-flash-high';
const session = 'followup-session';
const input = (index, state = 'DONE') => ({
  event: 'step_update',
  step_update: { conversation_id: session, step_index: index, step_type: 'user_input', state },
});
const answer = (index, text, tokens) => ({
  event: 'step_update',
  step_update: {
    conversation_id: session,
    step_index: index,
    step_type: 'agent_response',
    state: 'DONE',
    text_delta: text,
    usage: {
      input_tokens: tokens,
      output_tokens: 2,
      thinking_tokens: 0,
      cache_read_tokens: 0,
      total_tokens: tokens + 2,
    },
  },
});
const result = (text, turn = 1, status = 'SUCCESS') => ({
  event: 'result',
  result: {
    conversation_id: session,
    response: text,
    status,
    num_turns: turn,
    usage: { input_tokens: turn * 100, output_tokens: turn * 2, total_tokens: turn * 102 },
    ...(status === 'ERROR' ? { error: 'second turn failed' } : {}),
  },
});

async function runNative(script, { signal, registered = true, invocationId = 'inv', onMessage } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'native-followup-'));
  const workspace = join(root, 'workspace');
  mkdirSync(workspace);
  const service = new AgyNativeAgentService({
    catId: 'gemini38',
    command: '/usr/bin/true',
    l0CompilerFn: async () => '# Fixture identity',
    rawArchive: { append: async () => {} },
    profile: {
      enabled: true,
      profileId: 'gemini38',
      model,
      homeRoot: join(root, 'profiles'),
      trustedWorkspaces: [workspace],
    },
  });
  const state = { writes: [], messages: [], releases: 0 };
  try {
    for await (const message of service.invoke('A', {
      invocationId,
      workingDirectory: workspace,
      ...(signal ? { signal } : {}),
      ...(registered
        ? {
            activeRunDispatch: {
              invocationId,
              register: (dispatcher) => {
                state.dispatcher = dispatcher;
                return () => {
                  state.releases++;
                };
              },
            },
          }
        : {}),
      spawnCliOverride: async function* (launch) {
        state.closed = () => launch.stdinCloseSignal.aborted;
        if (launch.stdinInput) state.writes.push(launch.stdinInput);
        launch.onStdinReady?.((body) => {
          assert.equal(state.closed(), false);
          state.writes.push(body);
        });
        yield {
          event: 'init',
          conversation_id: session,
          init: {
            agent: launch.args[launch.args.indexOf('--agent') + 1],
            cwd: launch.cwd,
            model,
            permission_mode: 'request-review',
            tools: [],
          },
        };
        yield* script(state);
      },
    })) {
      await onMessage?.(message);
      state.messages.push(message);
    }
    return state;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

for (const mode of ['exit-before-B', 'cancel-after-read', 'error-B', 'success-B']) {
  test(
    `public Native terminal follows Queue cleanup without waiting for an optional read (${mode})`,
    { timeout: 5000 },
    async () => {
      const abort = new AbortController();
      let live;
      let releaseRead;
      let readStarted;
      let lateRead;
      let terminalSeen = false;
      const gate = new Promise((resolve) => {
        releaseRead = resolve;
      });
      const started = new Promise((resolve) => {
        readStarted = resolve;
      });
      const f = await appendRecoveryFixture((value, control) => live.dispatcher.dispatch(value, control), {
        inputCompletionReceipt: true,
      });
      const advance = f.messageStore.advanceLifecycleInputDispatch.bind(f.messageStore);
      f.messageStore.advanceLifecycleInputDispatch = (id, patch) => {
        if (patch.inputRead?.status !== 'read') return advance(id, patch);
        lateRead = gate.then(() => advance(id, patch));
        readStarted();
        return lateRead;
      };
      const completed = f.messageStore.commitLifecycleAppendRecovery.bind(f.messageStore);
      f.messageStore.commitLifecycleAppendRecovery = async (...args) => {
        assert.equal(terminalSeen, false, 'route consumers must not see done before incomplete inputs are detached');
        await Promise.resolve();
        return completed(...args);
      };
      try {
        const output = await runNative(
          async function* (s) {
            live = s;
            yield input(0);
            assert.equal((await f.append()).outcome, 'appended');
            yield result('A done.');
            if (mode === 'exit-before-B') return;
            yield input(2);
            await started;
            if (mode === 'cancel-after-read') {
              abort.abort();
              assert.equal(s.closed(), true, 'Stop closes stdin without waiting for the read observer');
              return;
            }
            yield result('B done.', 2, mode === 'error-B' ? 'ERROR' : 'SUCCESS');
          },
          {
            signal: abort.signal,
            invocationId: 'turn',
            onMessage: async (message) => {
              if (message.type !== 'done') return;
              terminalSeen = true;
              const source = await f.messageStore.getById(f.admission.message.id);
              const response = await f.messageStore.getById(f.response.id);
              if (mode === 'success-B') assert.equal(f.queue.list('thread', 'owner').length, 0);
              else {
                assert.equal(source.lifecycle.dispatchRefs.length, 0);
                assert.equal(response.lifecycle.inputMessageIds.length, 0);
                assert.equal(f.invocationTracker.getActiveSlots('thread')[0].activeRun.inputMessageIds.length, 0);
              }
            },
          },
        );
        assert.equal(terminalSeen, true);
        assert.equal(output.messages.filter((message) => message.type === 'done').length, 1);
        releaseRead();
        await lateRead;
        if (mode !== 'success-B')
          assert.equal(
            (await f.messageStore.getById(f.admission.message.id)).lifecycle.dispatchRefs.length,
            0,
            'a late read must not recreate a compensated binding',
          );
      } finally {
        releaseRead();
      }
    },
  );
}

async function append(state, text = 'B', patch = {}, control = {}) {
  assert.ok(state.dispatcher, 'Native must register its live input dispatcher');
  return state.dispatcher.dispatch(
    { text, messageIds: ['source-B'], deliveryId: 'delivery-B', ...patch },
    { expectedInvocationId: 'inv', force: false, ...control },
  );
}

test('Native reads B only in its next internal turn and completes B only on its own SUCCESS result', async () => {
  let reads = 0;
  const completed = [];
  const state = await runNative(async function* (s) {
    assert.deepEqual(s.dispatcher?.capabilities, {
      append: true,
      steer: false,
      inputReadReceipt: true,
      inputCompletionReceipt: true,
    });
    yield input(0);
    assert.equal(typeof (await s.dispatcher.initialInputRead), 'number');
    assert.equal(
      (
        await append(s, 'B', {
          onInputRead: async () => {
            reads++;
          },
          onInputCompleted: async (ok) => completed.push(ok),
        })
      ).accepted,
      true,
    );
    assert.equal(reads, 0);
    yield answer(1, 'A done.', 10);
    yield result('A done.');
    assert.equal(s.closed(), false);
    assert.deepEqual(completed, []);
    yield input(2, 'ACTIVE');
    assert.equal(reads, 0);
    yield input(2);
    assert.equal(reads, 1);
    yield answer(3, 'B done.', 20);
    yield result('B done.', 2);
    assert.deepEqual(completed, [true]);
    assert.equal(s.closed(), true);
  });
  assert.equal(state.messages.at(-1).errorCode, undefined, JSON.stringify(state.messages));
  assert.equal(state.messages.filter((m) => m.type === 'done').length, 1);
  assert.equal(state.messages.filter((m) => m.type === 'session_init').length, 1);
  assert.equal(
    state.messages
      .filter((m) => m.type === 'text')
      .map((m) => m.content)
      .join(''),
    'A done.B done.',
  );
  assert.equal(
    state.messages.at(-1).metadata.usage.inputTokens,
    30,
    'sum per-turn model usage, not cumulative result usage',
  );
  assert.deepEqual(
    state.writes.map((line) => JSON.parse(line).message.content[0].text),
    ['A', 'B'],
  );
  assert.equal(state.releases, 1);
});

for (const mode of ['cancel-A', 'cancel-after-A', 'error-B', 'exit-before-B']) {
  test(`Native preserves unfinished B when ${mode}`, async () => {
    const abort = new AbortController();
    const completed = [];
    const state = await runNative(
      async function* (s) {
        yield input(0);
        assert.equal((await append(s, 'B', { onInputCompleted: async (ok) => completed.push(ok) })).accepted, true);
        if (mode === 'cancel-A') {
          abort.abort();
          return;
        }
        yield answer(1, 'A done.', 10);
        yield result('A done.');
        if (mode === 'cancel-after-A') {
          abort.abort();
          return;
        }
        if (mode === 'exit-before-B') return;
        yield input(2);
        yield result('B failed.', 2, 'ERROR');
      },
      { signal: abort.signal },
    );
    assert.deepEqual(completed, [false]);
    assert.ok(state.messages.at(-1).errorCode, 'a completed A must not hide unfinished B');
    if (mode.startsWith('cancel')) assert.equal(state.messages.at(-1).errorCode, 'AGY_CANCELLED');
    assert.equal(state.closed(), true);
    assert.equal(state.releases, 1);
  });
}

test('Native refuses force, stale invocations and arrivals after final result without writing them', async () => {
  const state = await runNative(async function* (s) {
    yield input(0);
    assert.equal((await append(s, 'B', {}, { force: true })).reason, 'provider_rejected');
    assert.equal((await append(s, 'B', {}, { expectedInvocationId: 'old' })).reason, 'active_run_mismatch');
    yield answer(1, 'A done.', 10);
    yield result('A done.');
    const late = await append(s);
    assert.deepEqual(late, { accepted: false, reason: 'active_run_closed', acceptance: 'not_accepted' });
  });
  assert.equal(state.writes.length, 1);
  assert.equal(state.messages.at(-1).errorCode, undefined);
});

test('Native deduplicates deliveryId within this live process', async () => {
  const completed = [];
  const state = await runNative(async function* (s) {
    yield input(0);
    const body = { onInputCompleted: async (ok) => completed.push(ok) };
    assert.equal((await append(s, 'B', body)).accepted, true);
    assert.equal((await append(s, 'B', body)).accepted, true);
    yield answer(1, 'A done.', 10);
    yield result('A done.');
    yield input(2);
    yield answer(3, 'B done.', 20);
    yield result('B done.', 2);
  });
  assert.equal(state.writes.length, 2);
  assert.deepEqual(completed, [true]);
});

test('Native completes a recovered turn and the next appended turn without replaying text', async () => {
  const recovered = readFileSync(
    new URL('./fixtures/agy-stream-json/recovered-retry-turn.ndjson', import.meta.url),
    'utf8',
  )
    .trim()
    .split('\n')
    .map(JSON.parse);
  const completed = [];
  const state = await runNative(async function* (s) {
    for (const event of recovered) {
      if (event.event === 'init') continue;
      if (event.event === 'step_update') event.step_update.conversation_id = session;
      if (event.event === 'result') {
        event.result.conversation_id = session;
        assert.equal((await append(s, 'B', { onInputCompleted: async (ok) => completed.push(ok) })).accepted, true);
      }
      yield event;
    }
    yield input(94);
    yield answer(95, 'B done.', 20);
    yield result('B done.', 2);
  });
  assert.deepEqual(completed, [true]);
  assert.equal(state.messages.at(-1).errorCode, undefined, JSON.stringify(state.messages));
  assert.equal(state.messages.filter((m) => m.type === 'error').length, 0);
  assert.equal(state.messages.filter((m) => m.type === 'done').length, 1);
  assert.equal(
    state.messages
      .filter((m) => m.type === 'text')
      .map((m) => m.content)
      .join(''),
    'Recovered review\nB done.',
  );
});
