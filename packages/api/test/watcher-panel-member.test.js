import assert from 'node:assert/strict';
import { test } from 'node:test';
import { watcherPanelSessionChainKey } from '../dist/domains/cats/services/session/session-scope.js';
import { runWatcherPanelMember } from '../dist/domains/concierge/watcher/panel/watcher-panel-member.js';
import { watcherWorld } from './helpers/watcher-world.js';

const OWNER = 'watcher-owner';
const MEMBER = 'gpt52';

async function memberWorld(stream = () => []) {
  const w = await watcherWorld();
  const [source] = await w.work('把 A 改成了 B');
  const cutoff = await w.messages.getById(source.responseSettlement.messageId);
  const invocations = [];
  const service = {
    async *invoke(prompt, options) {
      invocations.push({ prompt, options });
      yield { type: 'session_init', catId: MEMBER, sessionId: 'native-1', timestamp: Date.now() };
      for await (const event of stream(cutoff)) yield { catId: MEMBER, timestamp: Date.now(), ...event };
      yield { type: 'text', catId: MEMBER, content: '看完了。', timestamp: Date.now() };
      yield { type: 'done', catId: MEMBER, timestamp: Date.now() };
    },
  };
  const owners = {
    ...w,
    transcript: { appendDurableEvent: async () => {} },
    apiUrl: 'http://127.0.0.1:3102',
    service: (catId) => (catId === MEMBER ? service : undefined),
  };
  const run = (extra = {}) =>
    runWatcherPanelMember(owners, {
      round: {
        roundId: `wpr:${source.invocationId}`,
        userId: OWNER,
        threadId: w.thread.id,
        workerCatId: 'codex',
        cutoffAt: source.responseSettlement.settledAt,
      },
      source,
      cutoff,
      threadTitle: '测试线程',
      catId: MEMBER,
      guidance: { text: '只在有把握时说。', digest: 'sha256:test' },
      signal: new AbortController().signal,
      ...extra,
    });
  return { ...w, source, cutoff, invocations, run };
}

test('a member runs as an ordinary read-only Codex turn behind the panel fence', async () => {
  const f = await memberWorld();
  const admitted = [];
  const result = await f.run({ onAdmitted: (invocationId) => admitted.push(invocationId) });
  assert.equal(result.status, 'quiet');
  assert.deepEqual(admitted, [result.invocationId]);
  assert.equal(result.context.mode, 'cold');
  assert.ok(result.context.messageCount >= 1);

  const [{ prompt, options }] = f.invocations;
  assert.match(prompt, /<守望猫说明>\n只在有把握时说。\n<\/守望猫说明>/);
  assert.match(prompt, new RegExp(f.cutoff.id));
  assert.match(prompt, /把 A 改成了 B/);
  assert.equal(options.sessionId, undefined, 'a fresh member starts cold');
  assert.equal(options.codexLaunchPolicy.sandboxMode, 'read-only');
  assert.equal(options.codexLaunchPolicy.approvalPolicy, 'never');
  assert.ok(options.frozenL0Input, 'ordinary L0, frozen like any member turn');
  assert.equal(options.toolExecutionPolicy, undefined, 'ordinary MCP; the fence lives on the callback auth');

  const auth = await f.registry.peekRecord(result.invocationId);
  assert.equal(auth.toolExecutionPolicy.mode, 'watcher_panel');
  assert.equal(auth.parentInvocationId, `watcher-panel:wpr:${f.source.invocationId}:${MEMBER}`);
  assert.equal(options.callbackEnv.CAT_CAFE_INVOCATION_ID, result.invocationId);

  const execution = await f.executions.get(result.invocationId);
  assert.equal(execution.executionKind, 'watcher');
  assert.equal(execution.status, 'succeeded');
  assert.equal(execution.parentInvocationId, auth.parentInvocationId, 'observer reads are recognised');
  assert.equal(execution.causal.watcherPanelRoundId, `wpr:${f.source.invocationId}`);
  assert.ok(execution.responseSettlement);

  const session = await f.sessions.get(result.sessionId);
  assert.equal(session.sessionPurpose, 'watcher');
  assert.equal(session.chainKey, watcherPanelSessionChainKey(OWNER, MEMBER, f.thread.id));
  assert.equal(session.cliSessionId, 'native-1');
});

test('the next round resumes the member and reads only what is new', async () => {
  const f = await memberWorld();
  const first = await f.run();
  assert.equal(first.status, 'quiet');
  const second = await f.run({
    previous: { cutoffAt: f.source.responseSettlement.settledAt, settledReplyIds: [], sessionId: first.sessionId },
  });
  assert.equal(second.status, 'quiet');
  assert.equal(second.sessionId, first.sessionId);
  assert.equal(f.invocations[1].options.sessionId, 'native-1');
  assert.equal(second.context.mode, 'hot');
  assert.equal(second.context.messageCount, 0);
});

test('proposals, desk deliveries and memory writes are counted only when the tool succeeded', async () => {
  const f = await memberWorld(() => [
    { type: 'tool_use', toolName: 'mcp__cat-cafe-collab__cat_cafe_offer_suggestion', toolUseId: 't1' },
    { type: 'tool_result', toolUseId: 't1', toolResultStatus: 'ok' },
    { type: 'tool_use', toolName: 'cat_cafe_remember', toolUseId: 't2' },
    { type: 'tool_result', toolUseId: 't2', toolResultStatus: 'error' },
    { type: 'tool_use', toolName: 'cat_cafe_remember', toolUseId: 't3' },
    { type: 'tool_result', toolUseId: 't3', toolResultStatus: 'ok' },
    { type: 'tool_use', toolName: 'cat_cafe_get_thread_context', toolUseId: 't4' },
    { type: 'tool_result', toolUseId: 't4', toolResultStatus: 'ok' },
  ]);
  const result = await f.run();
  assert.deepEqual(result.actions, { proposed: 1, broughtToDesk: 0, remembered: 1 });
});

test('a provider error fails the member and settles its execution', async () => {
  const f = await memberWorld(() => [{ type: 'error', error: 'boom' }]);
  const result = await f.run();
  assert.equal(result.status, 'failed');
  assert.equal(result.failure, 'boom');
  assert.equal((await f.executions.get(result.invocationId)).status, 'failed');
});

test('a user-canceled member stays interrupted when the provider stream ends normally', async () => {
  const f = await memberWorld(async function* () {
    const id = f.invocations[0].options.invocationId;
    await f.executions.transitionTerminal(id, {
      status: 'canceled',
      endedAt: Date.now(),
      terminalReason: 'user_cancel',
    });
    yield { type: 'done' };
  });
  const result = await f.run();
  assert.equal(result.status, 'interrupted');
  assert.match(result.failure, /user_cancel/);
  const execution = await f.executions.get(result.invocationId);
  assert.equal(execution.status, 'canceled');
  assert.equal(execution.terminalReason, 'user_cancel');
  assert.ok(execution.responseSettlement);
});

test('an aborted round is not quiet even when the stream drains without throwing', async () => {
  const abort = new AbortController();
  const f = await memberWorld(function* () {
    abort.abort(new DOMException('fixture stop', 'AbortError'));
    yield { type: 'done' };
  });
  const result = await f.run({ signal: abort.signal });
  assert.equal(result.status, 'interrupted');
  assert.equal((await f.executions.get(result.invocationId)).status, 'canceled');
});

test('a cancellation racing the final transition wins over the drained-stream outcome', async () => {
  const f = await memberWorld();
  const transition = f.executions.transitionTerminal.bind(f.executions);
  f.executions.transitionTerminal = async (id, terminal) => {
    if (terminal.terminalReason === 'watcher_panel_quiet')
      await transition(id, {
        status: 'canceled',
        endedAt: Date.now(),
        terminalReason: 'user_cancel',
      });
    return transition(id, terminal);
  };
  const result = await f.run();
  assert.equal(result.status, 'interrupted');
  assert.equal(result.executionStatus, 'canceled');
  assert.equal(result.failure, 'user_cancel');
});

test('a member without a local Codex session is refused before anything launches', async () => {
  const f = await memberWorld();
  const result = await runWatcherPanelMember(
    { ...f, transcript: { appendDurableEvent: async () => {} }, apiUrl: 'x', service: () => undefined },
    {
      round: { roundId: 'r', userId: OWNER, threadId: f.thread.id, workerCatId: 'codex', cutoffAt: Date.now() },
      source: f.source,
      cutoff: f.cutoff,
      catId: 'opus',
      guidance: { text: 'g', digest: 'd' },
      signal: new AbortController().signal,
    },
  );
  assert.deepEqual(result, { status: 'failed', failure: 'watcher_panel_member_unsupported' });
});
