import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseWatcherSessionState } from '@cat-cafe/shared';
import { watcherSessionChainKey } from '../dist/domains/cats/services/session/session-scope.js';
import { watcherWindow } from '../dist/domains/concierge/watcher/context/watcher-window.js';
import { watcherInvocationAuthority } from '../dist/domains/concierge/watcher/watcher-authority.js';
import { runWatcherInvocation } from '../dist/domains/concierge/watcher/watcher-invocation.js';
import { watcherWorld } from './helpers/watcher-world.js';

const failures = [
  'watcher_context_recovery_deadline_exceeded',
  'watcher_context_recovery_tool_budget_exhausted',
  'watcher_context_budget_exceeded:31000',
];

async function seeded(failure, tokens = failure.startsWith('watcher_context_budget_exceeded') ? 128 : 1250) {
  const w = await watcherWorld();
  const [source] = await w.work('original awaiting bounded recovery');
  const session = await w.sessions.getOrCreateActive({
    userId: source.userId,
    threadId: source.threadId,
    catId: 'codex',
    sessionPurpose: 'watcher',
    chainKey: watcherSessionChainKey(source.userId, 'codex', source.threadId),
  });
  const events = [];
  const owners = {
    ...w,
    apiUrl: 'http://127.0.0.1:3102',
    maySpeak: async () => false,
    transcript: {
      appendDurableEvent: async (_session, event) => {
        events.push(event);
      },
    },
  };
  const run = { session, state: parseWatcherSessionState(session.watcherState), committed: false, prefixTokens: 0 };
  const { auth } = await watcherInvocationAuthority(owners, run, source, []);
  const bound = await w.sessions.bindCliSessionIdIfUnbound(session.id, 'native');
  await w.executions.markProviderStarted(auth.invocationId, Date.now());
  if (failure === failures[1])
    for (let i = 0; i < 6; i++)
      await w.registry.consumeWatcherToolCall(auth.invocationId, `seed-${i}`, 'cat_cafe_suggestion_facts');
  await w.sessions.compareAndSetWatcherState(bound.id, 0, {
    revision: 1,
    afterSequence: 0,
    notes: '',
    wakeInvocationId: auth.invocationId,
    rawWindowTokens: tokens,
    attempt: {
      invocationId: auth.invocationId,
      sourceInvocationId: source.invocationId,
      sourceSequence: source.settledSequence,
      startedAt: Date.now(),
      phase: 'failed',
      failure,
      retries: 1,
      nativeTurnId: 'prior-turn',
      window: {
        frontier: source.responseSettlement.messageId,
        offset: 0,
        messageIds: [source.responseSettlement.messageId],
        complete: true,
        tokenBudget: tokens,
      },
    },
  });
  return { w, source, owners, session: bound, events, auth };
}

const service = (client, before, nextFailure) => ({
  boundedWatcherSessionCapability: () => ({ supported: true }),
  async *invoke(_prompt, options) {
    before?.();
    const admitted = await options.boundedWatcher.beforeTurn({ threadId: 'native', client });
    if (admitted && nextFailure) throw nextFailure;
  },
});

for (const pending of failures)
  for (const fault of ['still-active', 'read-failed', 'disabled'])
    test(`${pending} survives an unconsumed ${fault} probe, then idle reconciliation audits the original`, async () => {
      const f = await seeded(pending);
      const abort = new AbortController();
      let idle = false;
      const calls = [];
      const client = {
        async request(method) {
          calls.push(method);
          if (fault === 'read-failed' && !idle) throw new Error('Codex app-server request failed');
          return {
            thread: {
              id: 'native',
              turns: [{ id: 'prior-turn', status: idle ? 'interrupted' : 'inProgress', items: [] }],
            },
          };
        },
      };
      await assert.rejects(
        runWatcherInvocation(f.owners, {
          session: f.session,
          source: f.source,
          quiet: true,
          signal: abort.signal,
          service: service(
            client,
            fault === 'disabled'
              ? () => {
                  abort.abort(new Error('watcher_disabled'));
                  throw new Error('aborted before native recovery');
                }
              : undefined,
          ),
        }),
      );
      let state = (await f.w.sessions.get(f.session.id)).watcherState;
      assert.equal(state.attempt.failure, pending, 'a probe cannot consume or replace a pending recovery decision');
      assert.equal(state.afterSequence, 0);
      assert.equal(state.consumedThrough, undefined);
      assert.equal(calls.includes('thread/revert'), false);
      assert.equal(
        f.events.some((e) => e.type === 'watcher_window_skipped'),
        false,
      );
      const diagnostic = f.events.find((e) => e.type === 'watcher_attempt_failure');
      assert.match(diagnostic.reason, /still_active|Codex app-server request failed|watcher_disabled/);
      idle = true;
      await runWatcherInvocation(f.owners, {
        session: f.session,
        source: f.source,
        service: service(client),
        quiet: true,
      });
      state = (await f.w.sessions.get(f.session.id)).watcherState;
      assert.equal(state.afterSequence, f.source.settledSequence);
      assert.equal(state.consumedThrough, f.source.responseSettlement.messageId);
      assert.equal(state.attempt, undefined);
      assert.equal(state.rawWindowTokens, undefined);
      assert.ok(calls.includes('thread/revert'));
      const skip = f.events.find((e) => e.type === 'watcher_window_skipped');
      assert.deepEqual(skip.messageIds, [f.source.responseSettlement.messageId]);
      assert.equal(skip.sourceInvocationId, f.source.invocationId);
      const wake = await f.w.executions.get(f.auth.invocationId);
      assert.equal(wake.status, 'failed');
      assert.equal(wake.terminalReason, 'watcher_context_budget_skipped');
      assert.equal(
        f.events.some((e) => e.type === 'watcher_checkpoint'),
        false,
      );
      const [next] = await f.w.work('unrelated fresh source after the audit');
      const raw = await watcherWindow(f.w.messages, next, state, '', []);
      assert.equal(raw.tokenBudget, 2500);
      assert.equal(raw.messageIds.includes(f.source.responseSettlement.messageId), false);
    });

test('consuming a budget classification releases it before a new independent failure', async () => {
  const f = await seeded(failures[2], 2500);
  const error = new Error('controlled independent upstream failure');
  const client = {
    async request() {
      return { thread: { id: 'native', turns: [{ id: 'prior-turn', status: 'interrupted', items: [] }] } };
    },
  };
  await assert.rejects(
    runWatcherInvocation(f.owners, {
      session: f.session,
      source: f.source,
      service: service(client, undefined, error),
      quiet: true,
    }),
    (e) => e === error,
  );
  const state = (await f.w.sessions.get(f.session.id)).watcherState;
  assert.equal(state.rawWindowTokens, 1250, 'the real recovery consumed the prior budget failure');
  assert.equal(state.attempt.failure, error.message);
  assert.equal(state.afterSequence, 0);
  assert.equal(
    f.events.some((e) => e.type === 'watcher_window_skipped'),
    false,
  );
});
