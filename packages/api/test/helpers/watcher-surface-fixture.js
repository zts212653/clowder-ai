import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { parseWatcherSessionState } from '@cat-cafe/shared';
import { watcherSessionChainKey } from '../../dist/domains/cats/services/session/session-scope.js';
import { MemoryConciergeConfigStore } from '../../dist/domains/concierge/ConciergeConfigStore.js';
import { watcherInvocationAuthority } from '../../dist/domains/concierge/watcher/watcher-authority.js';
import { watcherWorld } from './watcher-world.js';

// Exact legacy pin from the boot84 native session_meta; no production session is modified.
export const PIN = '95682cde633aa4e41a0a49482eef962c8e56a77dca039deefbaec6918f96b35d';
export async function stuck() {
  const w = await watcherWorld();
  const [prior] = await w.work('prior partially unread material');
  const [source] = await w.work('unread original after the saved checkpoint');
  const session = await w.sessions.getOrCreateActive({
    userId: source.userId,
    threadId: source.threadId,
    catId: 'codex',
    sessionPurpose: 'watcher',
    chainKey: watcherSessionChainKey(source.userId, 'codex', source.threadId),
  });
  const events = [];
  let now = Date.now();
  const owners = {
    ...w,
    now: () => now,
    apiUrl: 'http://127.0.0.1:3102',
    maySpeak: async () => false,
    transcript: { appendDurableEvent: async (_ref, event) => events.push(event) },
  };
  const run = { session, state: parseWatcherSessionState(undefined), committed: false, prefixTokens: 0 };
  const { auth } = await watcherInvocationAuthority(owners, run, source, []);
  const bound = await w.sessions.bindCliSessionIdIfUnbound(session.id, 'old-native');
  await w.executions.recordProviderTeardown(auth.invocationId, Date.now());
  const configs = new MemoryConciergeConfigStore();
  const config = await configs.updateWatcherConfig(source.userId, 0, {
    scope: 'all',
    enabled: true,
    memberCatId: 'codex',
  });
  await configs.initializeWatcherCursor(source.userId, 0);
  await w.sessions.compareAndSetWatcherState(session.id, 0, {
    revision: 1,
    afterSequence: prior.settledSequence,
    consumedThrough: prior.responseSettlement.messageId,
    messageOffset: 5,
    rawSince: 1,
    activationCut: '0:0',
    notes: 'durable prior notes',
    toolSchemaHash: PIN,
    wakeInvocationId: auth.invocationId,
    attempt: {
      invocationId: auth.invocationId,
      sourceInvocationId: source.invocationId,
      sourceSequence: source.settledSequence,
      startedAt: Date.now(),
      phase: 'failed',
      failure: 'watcher_native_tool_surface_changed',
      recoveryAttempts: 3,
      recoveryRetryAt: 1,
      recoveryControlKey: `${config.revision}:0`,
      window: {
        frontier: source.responseSettlement.messageId,
        offset: 12,
        complete: false,
        tokenBudget: 2500,
        messageIds: [source.responseSettlement.messageId],
      },
    },
  });
  let launches = 0,
    turns = 0;
  const calls = [];
  const native = { turns: [] };
  const service = {
    boundedWatcherSessionCapability: () => ({ supported: true }),
    async *invoke(_prompt, options) {
      launches++;
      const proceed = await options.boundedWatcher.beforeTurn({
        threadId: bound.cliSessionId,
        client: {
          async request(method) {
            calls.push(method);
            if (native.error) throw native.error;
            if (method === 'thread/revert') {
              native.turns = [];
              return { thread: { id: bound.cliSessionId, turns: [] } };
            }
            assert.equal(method, 'thread/read');
            return native.response ?? { thread: { id: bound.cliSessionId, turns: native.turns } };
          },
        },
      });
      if (proceed) {
        turns++;
        assert.fail('a control-only settlement cannot launch a model turn');
      }
    },
  };
  const errors = [];
  const options = {
    ...owners,
    configs,
    userId: source.userId,
    labels: { list: async () => [] },
    service: () => service,
    capability: () => ({ supported: true }),
    report: (error) => errors.push(error),
  };
  return {
    w,
    owners,
    source,
    prior,
    native,
    advance: (ms) => {
      now += ms;
    },
    session: bound,
    auth,
    service,
    options,
    calls,
    events,
    errors,
    launches: () => launches,
    turns: () => turns,
  };
}
export async function flush() {
  for (let i = 0; i < 80; i++) await setImmediate();
}
