import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type TestContext, test } from 'node:test';
import { createCatId } from '@cat-cafe/shared';
import { recordHostRoundTerminal } from '../../../docs/research/2026-11-18-f338-haiku-sdk/study-observation.mjs';
import { createStudySdkSendGuard } from '../../../docs/research/2026-11-18-f338-haiku-sdk/study-sdk-send-guard.mjs';
import { SessionChainStore } from '../dist/domains/cats/services/stores/ports/SessionChainStore.js';
import { ClaudeSdkAgentService } from '../src/domains/cats/services/agents/providers/ClaudeSdkAgentService.js';
import { installClaudeSdkSendGuard } from '../src/domains/cats/services/agents/providers/claude-sdk-query.js';
import type { AgentClientActiveRunDispatcher, AgentMessage } from '../src/domains/cats/services/types.js';
import { claudeSdkRuntimeFixture } from './helpers/claude-sdk-runtime-fixture.js';
import { invokeKnownHostSession } from './helpers/known-host-session-fixture.js';

function fixture(t: TestContext, stage: 'source' | 'T75', fail: boolean) {
  const root = mkdtempSync(join(tmpdir(), 'f338-send-once-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const model = 'claude-opus-4-6'; // existing test registry fixture, never a real dispatch
  const window = () => ({
    stage,
    catId: 'opus',
    model,
    sessionId: 'native-parent',
    permitId: randomUUID(),
    notBeforeAt: Date.now() - 1000,
    deadlineAt: Date.now() + 60000,
  });
  const open = () => writeFileSync(join(root, 'sdk-send-window.json'), JSON.stringify(window()));
  open();
  t.after(installClaudeSdkSendGuard(createStudySdkSendGuard(root)));
  const store = new SessionChainStore();
  const threadId = randomUUID();
  const record = store.create({ cliSessionId: 'native-parent', threadId, catId: 'opus', userId: 'u1' });
  const deps = {
    registry: {
      create: () => ({ invocationId: randomUUID(), callbackToken: randomUUID() }),
      verify: async () => ({ ok: false, reason: 'unknown_invocation' }),
    },
    sessionManager: {
      get: async () => 'native-parent',
      getOrCreate: async () => ({}),
      store: async () => {},
      delete: async () => {},
      resolveWorkingDirectory: () => root,
    },
    sessionChainStore: store,
    threadStore: null,
    apiUrl: 'http://127.0.0.1:3122',
  };
  const counters = { queries: 0, thinkingSeen: false };
  const service = new ClaudeSdkAgentService({
    catId: createCatId('opus'),
    model,
    mcpServerPath: '',
    l0CompilerFn: async () => 'L0',
    runtimeResolver: claudeSdkRuntimeFixture,
    queryFn: () => {
      counters.queries++;
      return {
        close() {},
        async *[Symbol.asyncIterator]() {
          yield { type: 'system', subtype: 'init', session_id: 'native-parent' };
          if (fail && counters.queries === 1) {
            yield {
              type: 'stream_event',
              event: {
                type: 'message_start',
                message: { id: 'paid-prefix', usage: { input_tokens: 10, output_tokens: 0 } },
              },
            };
            counters.thinkingSeen = true;
            yield {
              type: 'assistant',
              message: {
                id: 'paid-prefix',
                content: [{ type: 'thinking', thinking: 'partial charged output', signature: 'opaque' }],
              },
            };
            throw new Error('CLI 异常退出 (code: 1, signal: none)');
          }
          yield { type: 'assistant', message: { id: randomUUID(), content: [{ type: 'text', text: 'OK' }] } };
          yield {
            type: 'result',
            subtype: 'success',
            session_id: 'native-parent',
            num_turns: 1,
            total_cost_usd: 0.1,
            usage: { input_tokens: 10, output_tokens: 1 },
          };
        },
      };
    },
  });
  const run = async () => {
    const output: AgentMessage[] = [];
    for await (const event of invokeKnownHostSession(deps, {
      catId: 'opus',
      userId: 'u1',
      threadId,
      prompt: 'study stage',
      service,
    }))
      output.push(event);
    return output;
  };
  return { root, open, run, counters, record };
}

for (const stage of ['source', 'T75'] as const) {
  test(`F338: ${stage} thinking then transient exit cannot trigger a second SDK query through the real Host`, async (t) => {
    const f = fixture(t, stage, true);
    const output = await f.run();
    assert.equal(f.counters.thinkingSeen, true);
    assert.equal(f.counters.queries, 1);
    assert.ok(output.some((m) => m.type === 'error'));
    const done = output.findLast((m) => m.type === 'done');
    assert.ok(done);
    assert.equal(done.metadata?.usage?.costUsd, undefined);
    const attempt: { invocationId: string; sourceSessionId: string; costState?: string } = {
      invocationId: 'admitted',
      sourceSessionId: f.record.id,
    };
    recordHostRoundTerminal(
      attempt,
      { event: done, t: Date.now(), sessionId: f.record.id, invocationId: 'admitted' },
      { before: { ...f.record, lastUsage: { costUsd: 0.2 } }, record: f.record },
    );
    assert.equal(
      attempt.costState,
      'unsettled',
      'a partial thinking stream without a native bill is not a free request',
    );
  });

  test(`F338: an unused in-window ${stage} permit admits its first real Host SDK launch`, async (t) => {
    const f = fixture(t, stage, false);
    const output = await f.run();
    assert.equal(f.counters.queries, 1);
    assert.ok(output.some((m) => m.type === 'text' && m.content === 'OK'));
  });
}

test('F338: prime receives a separate permit after the preceding source stage succeeds', async (t) => {
  const f = fixture(t, 'source', false);
  await f.run();
  f.open();
  const prime = await f.run();
  assert.equal(f.counters.queries, 2);
  assert.ok(prime.some((m) => m.type === 'text' && m.content === 'OK'));
});

test('F338: recreating the guard cannot reuse a permit already consumed by a real Host query', async (t) => {
  const f = fixture(t, 'source', false);
  await f.run();
  assert.throws(
    () => createStudySdkSendGuard(f.root)({ catId: 'opus', model: 'claude-opus-4-6', sessionId: 'native-parent' }),
    /consumed/,
  );
});

test('F338: an active T75 carrier accepts one stage input and rejects a second input with the same permit', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'f338-active-once-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const open = (stage: string) =>
    writeFileSync(
      join(root, 'sdk-send-window.json'),
      JSON.stringify({
        stage,
        catId: 'opus',
        model: 'claude-opus-4-6',
        sessionId: 'native-parent',
        permitId: randomUUID(),
        notBeforeAt: Date.now() - 1000,
        deadlineAt: Date.now() + 60000,
      }),
    );
  open('source');
  t.after(installClaudeSdkSendGuard(createStudySdkSendGuard(root)));
  let dispatch: AgentClientActiveRunDispatcher['dispatch'] | undefined;
  const accepted: boolean[] = [];
  let delivered = 0;
  const service = new ClaudeSdkAgentService({
    catId: createCatId('opus'),
    model: 'claude-opus-4-6',
    mcpServerPath: '',
    l0CompilerFn: async () => 'L0',
    runtimeResolver: claudeSdkRuntimeFixture,
    queryFn: ({ prompt }) => ({
      close() {},
      async *[Symbol.asyncIterator]() {
        const input = prompt[Symbol.asyncIterator]();
        const first = (await input.next()).value;
        yield { type: 'system', subtype: 'init', session_id: 'native-parent' };
        open('T75');
        assert.ok(dispatch);
        for (const text of ['timed return', 'Host retry']) {
          const receipt = await dispatch({ text }, { expectedInvocationId: 'active' });
          accepted.push(receipt.accepted);
          if (receipt.accepted && !(await input.next()).done) delivered++;
        }
        yield {
          type: 'result',
          subtype: 'success',
          session_id: 'native-parent',
          num_turns: 2,
          user_message_uuids: [first.uuid],
          queued_turn_count: 0,
        };
        yield { type: 'system', subtype: 'session_state_changed', state: 'idle' };
      },
    }),
  });
  for await (const _event of service.invoke('primary', {
    sessionId: 'native-parent',
    invocationId: 'active',
    activeRunDispatch: {
      invocationId: 'active',
      register: (registration) => {
        dispatch = registration.dispatch;
        return () => {};
      },
    },
  })) {
    /* drain teardown */
  }
  assert.deepEqual(accepted, [true, false]);
  assert.equal(delivered, 1);
});
