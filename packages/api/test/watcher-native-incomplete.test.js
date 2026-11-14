import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { watcherSessionChainKey } from '../dist/domains/cats/services/session/session-scope.js';
import { createWatcherRequestBoundary } from '../dist/domains/concierge/watcher/watcher-request-boundary.js';
import { estimateTokens } from '../dist/utils/token-counter.js';
import { nativeWatcherAvailable, watcherNativeFixture } from './helpers/watcher-native-fixture.js';
import { watcherWorld } from './helpers/watcher-world.js';

function terminal(reply, reason, type = 'response.incomplete') {
  const id = 'controlled-terminal';
  const response = {
    id,
    status: type === 'response.incomplete' ? 'incomplete' : 'failed',
    output: [],
    incomplete_details: { reason },
    error: { message: reason, code: reason },
    usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12, input_tokens_details: { cached_tokens: 3 } },
  };
  reply.hijack();
  reply.raw.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const event of [
    { type: 'response.created', response: { id, status: 'in_progress', output: [] } },
    { type, response },
  ])
    reply.raw.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  reply.raw.end();
}

function observedEvents(f) {
  const events = [];
  const append = f.owners.transcript.appendDurableEvent.bind(f.owners.transcript);
  f.owners.transcript.appendDurableEvent = async (...args) => {
    await append(...args);
    events.push(args[1]);
  };
  return events;
}

test('the real request boundary does not send a continuation with only 559 output tokens left', async () => {
  let upstreamCalls = 0;
  const upstream = createServer((_request, reply) => {
    upstreamCalls++;
    reply.writeHead(200, { 'content-type': 'text/event-stream' });
    reply.end(
      'event: response.completed\ndata: {"type":"response.completed","response":{"usage":{"input_tokens":10,"output_tokens":2}}}\n\n',
    );
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const boundary = await createWatcherRequestBoundary(`http://127.0.0.1:${upstream.address().port}`, {
    signal: AbortSignal.timeout(10000),
  });
  try {
    let lo = 0,
      hi = 40000;
    const payload = (n) => ({ input: [{ role: 'user', content: 'x '.repeat(n) }], tools: [] });
    while (lo < hi) {
      const n = Math.floor((lo + hi) / 2);
      if (estimateTokens(JSON.stringify(payload(n))) + 1024 + 64 >= 29441) hi = n;
      else lo = n + 1;
    }
    const body = payload(lo);
    assert.equal(estimateTokens(JSON.stringify(body)) + 1024 + 64, 29441);
    const response = await fetch(`${boundary.baseUrl}/responses`, { method: 'POST', body: JSON.stringify(body) });
    await response.text();
    assert.equal(upstreamCalls, 0, 'reserve enough room for reasoning and the final checkpoint');
    assert.throws(() => boundary.assertHealthy(), /watcher_context_budget_exceeded/);
  } finally {
    await boundary.close();
    upstream.closeAllConnections();
    await new Promise((resolve) => upstream.close(resolve));
  }
});

test(
  'native max_output_tokens incomplete retains usage and recovers the same source with a smaller window',
  { timeout: 40000, skip: !nativeWatcherAvailable },
  async () => {
    const w = await watcherWorld();
    let attempts = 0;
    const f = await watcherNativeFixture(w, {
      model: 'gpt-6.1-sol',
      respond({ reply }) {
        if (attempts++ !== 0) return false;
        terminal(reply, 'max_output_tokens');
        return true;
      },
    });
    const events = observedEvents(f);
    try {
      const [source] = await w.work('RAW_INCREMENT_71 short ordinary reply');
      const session = await f.run(source, AbortSignal.timeout(30000));
      assert.equal(session.watcherState.afterSequence, source.settledSequence);
      assert.equal(session.watcherState.rawWindowTokens, undefined);
      const [wake] = await w.executions.listByParent(`watcher-source:codex:${source.invocationId}`);
      assert.equal(wake.status, 'succeeded');
      assert.equal(wake.terminalReason, 'watcher_checkpoint_committed');
      const modelAttempts = Object.values(wake.watcherModelAttempts);
      assert.equal(modelAttempts.length, 2);
      assert.equal(
        modelAttempts.filter((x) => x.usage?.inputTokens === 10 && x.usage.outputTokens === 2).length,
        2,
        'incomplete usage is real reported usage, not an invented empty/complete receipt',
      );
      assert.ok(
        events.some(
          (e) =>
            e.type === 'watcher_attempt_failure' &&
            e.origin === 'request_boundary' &&
            e.reason === 'watcher_context_budget_exceeded:response_max_output_tokens',
        ),
      );
      assert.equal(events.filter((e) => e.type === 'watcher_window_skipped').length, 0);
    } finally {
      await f.close();
    }
  },
);

test(
  'native interruption preserves the exact local repeated-tool-budget cause',
  { timeout: 30000, skip: !nativeWatcherAvailable },
  async () => {
    const w = await watcherWorld();
    const f = await watcherNativeFixture(w, {
      model: 'gpt-6.1-sol',
      respond({ reply, requests }) {
        if (requests.length !== 2) return false;
        terminal(reply, 'content_filter');
        return true;
      },
    });
    const events = observedEvents(f);
    try {
      const [source] = await w.work('RAW_INCREMENT_72 short ordinary reply');
      f.state.codeMode = true;
      f.state.toolPlan = [
        {
          nativeCall: {
            type: 'custom_tool_call',
            namespace: 'functions',
            name: 'exec',
            input: `const t=ALL_TOOLS.find(x=>x.name.endsWith('cat_cafe_suggestion_facts'));
          for(let i=0;i<4;i++){try{text(await tools[t.name]({kind:'controlled-facts'}));}catch(e){text(String(e));}}`,
          },
        },
      ];
      await assert.rejects(f.run(source, AbortSignal.timeout(20000)), /content_filter/);
      const first = await w.sessions.getByChainKey(watcherSessionChainKey('watcher-owner', 'codex', w.thread.id));
      assert.equal(await w.registry.watcherToolCallCount(first.watcherState.wakeInvocationId), 4);
      let failure;
      try {
        await f.run(source, AbortSignal.timeout(20000));
      } catch (error) {
        failure = error;
      }
      assert.ok(
        failure,
        JSON.stringify(f.requests.flatMap((r) => (r.body.input ?? []).filter((x) => x.type.endsWith('_output')))),
      );
      assert.match(String(failure), /watcher_repeated_tool_budget_denial/);
      const session = await w.sessions.getByChainKey(watcherSessionChainKey('watcher-owner', 'codex', w.thread.id));
      assert.equal(session.watcherState.attempt.failure, 'watcher_repeated_tool_budget_denial');
      assert.equal(await w.registry.watcherToolCallCount(session.watcherState.wakeInvocationId), 6);
      assert.equal(session.watcherState.afterSequence, 0);
      assert.equal(session.watcherState.consumedThrough, undefined);
      assert.ok(
        events.some(
          (e) =>
            e.type === 'watcher_attempt_failure' &&
            e.origin === 'local_abort' &&
            e.reason === 'watcher_repeated_tool_budget_denial',
        ),
      );
    } finally {
      await f.close();
    }
  },
);

test(
  'persistent native output exhaustion records an explicit skip, then a fresh wake uses its normal window',
  { timeout: 50000, skip: !nativeWatcherAvailable },
  async () => {
    const w = await watcherWorld();
    let exhausted = true;
    const f = await watcherNativeFixture(w, {
      model: 'gpt-6.1-sol',
      respond({ reply }) {
        if (!exhausted) return false;
        terminal(reply, 'max_output_tokens');
        return true;
      },
    });
    const events = observedEvents(f);
    try {
      const [source] = await w.work('RAW_INCREMENT_74 短原文在推理输出持续超额时仍可明确跳过。');
      const session = await f.run(source, AbortSignal.timeout(40000));
      assert.equal(session.watcherState.afterSequence, source.settledSequence);
      assert.equal(session.watcherState.rawWindowTokens, undefined);
      assert.equal(session.watcherState.consumedThrough, source.responseSettlement.messageId);
      const [wake] = await w.executions.listByParent(`watcher-source:codex:${source.invocationId}`);
      assert.equal(wake.status, 'failed');
      assert.equal(wake.terminalReason, 'watcher_context_budget_skipped');
      assert.deepEqual(events.find((e) => e.type === 'watcher_window_skipped').messageIds, [
        source.responseSettlement.messageId,
      ]);
      assert.equal(
        events.some((e) => e.type === 'watcher_checkpoint'),
        false,
      );
      assert.ok(f.requests.length <= 6);
      exhausted = false;
      const [next] = await w.work('RAW_INCREMENT_75 fresh source');
      const before = f.requests.length;
      await f.run(next, AbortSignal.timeout(10000));
      assert.equal(f.requests.length - before, 1);
      assert.equal(f.requests.at(-1).wire.includes(source.responseSettlement.messageId), false);
    } finally {
      await f.close();
    }
  },
);

test(
  'context recovery that exhausts its remaining six-call allowance leaves an audited skip, not a stuck source',
  { timeout: 30000, skip: !nativeWatcherAvailable },
  async () => {
    const w = await watcherWorld();
    const f = await watcherNativeFixture(w, {
      model: 'gpt-6.1-sol',
      respond({ reply, requests }) {
        if (requests.length !== 2) return false;
        terminal(reply, 'max_output_tokens');
        return true;
      },
    });
    const events = observedEvents(f);
    try {
      const [source] = await w.work('RAW_INCREMENT_77 short source with an exhausted recovery allowance');
      f.state.codeMode = true;
      f.state.toolPlan = [
        {
          nativeCall: {
            type: 'custom_tool_call',
            namespace: 'functions',
            name: 'exec',
            input: `const t=ALL_TOOLS.find(x=>x.name.endsWith('cat_cafe_suggestion_facts'));
          for(let i=0;i<4;i++){try{text(await tools[t.name]({kind:'controlled-facts'}));}catch(e){text(String(e));}}`,
          },
        },
      ];
      const session = await f.run(source, AbortSignal.timeout(25000));
      assert.equal(session.watcherState.afterSequence, source.settledSequence);
      assert.equal(session.watcherState.consumedThrough, source.responseSettlement.messageId);
      const [wake] = await w.executions.listByParent(`watcher-source:codex:${source.invocationId}`);
      assert.equal(wake.terminalReason, 'watcher_context_budget_skipped');
      assert.equal(wake.status, 'failed');
      assert.equal(await w.registry.watcherToolCallCount(wake.invocationId), 6);
      const skipped = events.find((e) => e.type === 'watcher_window_skipped');
      assert.equal(skipped.reason, 'watcher_context_recovery_tool_budget_exhausted');
      assert.deepEqual(skipped.messageIds, [source.responseSettlement.messageId]);
      assert.equal(
        events.some((e) => e.type === 'watcher_checkpoint'),
        false,
      );
      assert.equal(f.requests.length, 3, 'no extra model attempt can restore the consumed allowance');
      assert.equal(skipped.tokenBudget, 1250, 'the audit retains the real window, not a fictitious minimum');
      f.state.toolPlan = undefined;
      f.state.tools = 0;
      const [next] = await w.work('RAW_INCREMENT_78 unrelated fresh source');
      await f.run(next, AbortSignal.timeout(10000));
      assert.equal(f.requests.length, 4);
      assert.equal(f.requests.at(-1).wire.includes(source.responseSettlement.messageId), false);
    } finally {
      await f.close();
    }
  },
);

for (const [type, reason] of [
  ['response.incomplete', 'content_filter'],
  ['response.failed', 'controlled_upstream_failure'],
])
  test(
    `${type} ${reason} is not reclassified as a context budget failure`,
    { timeout: 30000, skip: !nativeWatcherAvailable },
    async () => {
      const w = await watcherWorld();
      const f = await watcherNativeFixture(w, {
        model: 'gpt-6.1-sol',
        respond({ reply }) {
          terminal(reply, reason, type);
          return true;
        },
      });
      try {
        const [source] = await w.work('RAW_INCREMENT_73 ordinary error control');
        await assert.rejects(
          f.run(source, AbortSignal.timeout(20000)),
          (error) => String(error).includes(reason) && !String(error).includes('watcher_context_budget_exceeded'),
        );
        assert.equal(f.requests.length, 1);
        const session = await w.sessions.getByChainKey(watcherSessionChainKey('watcher-owner', 'codex', w.thread.id));
        assert.equal(session.watcherState.rawWindowTokens, undefined);
        assert.equal(session.watcherState.consumedThrough, undefined);
      } finally {
        await f.close();
      }
    },
  );
