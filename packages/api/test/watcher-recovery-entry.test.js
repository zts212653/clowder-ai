import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { parseWatcherSessionState } from '@cat-cafe/shared';
import { watcherSessionChainKey } from '../dist/domains/cats/services/session/session-scope.js';
import { MemoryConciergeConfigStore } from '../dist/domains/concierge/ConciergeConfigStore.js';
import { WatcherSupervisor } from '../dist/domains/concierge/watcher/WatcherSupervisor.js';
import { watcherInvocationAuthority } from '../dist/domains/concierge/watcher/watcher-authority.js';
import {
  commitWatcherCheckpoint,
  recoverWatcherAttempt,
} from '../dist/domains/concierge/watcher/watcher-checkpoint.js';
import { finalizeWatcherWake } from '../dist/domains/concierge/watcher/watcher-finalization.js';
import { watcherWorld } from './helpers/watcher-world.js';

async function admitted() {
  const w = await watcherWorld();
  const [source] = await w.work('original input');
  const session = await w.sessions.getOrCreateActive({
    userId: source.userId,
    threadId: source.threadId,
    catId: 'codex',
    sessionPurpose: 'watcher',
    chainKey: watcherSessionChainKey(source.userId, 'codex', source.threadId),
  });
  const owners = { ...w, apiUrl: 'http://127.0.0.1:3102', transcript: { appendDurableEvent: async () => {} } };
  const run = { session, state: parseWatcherSessionState(session.watcherState), committed: false, prefixTokens: 0 };
  const first = await watcherInvocationAuthority(owners, run, source, []);
  return { w, owners, run, source, session, auth: first.auth };
}
async function flush() {
  for (let i = 0; i < 30; i++) await setImmediate();
}

test('the execution created before attempt CAS remains the only principal on same-source reentry', async () => {
  const f = await admitted();
  const again = await watcherInvocationAuthority(f.owners, f.run, f.source, []);
  assert.equal(again.auth.invocationId, f.auth.invocationId, 'a missing Session pointer cannot create a second wake');
  const rows = await f.w.executions.listByParent(`watcher-source:codex:${f.source.invocationId}`);
  assert.equal(rows.length, 1);
  assert.equal((await f.w.registry.verify(f.auth.invocationId, f.auth.callbackToken)).ok, true);
});

test('startup closes a proved never-started orphan while disabled without creating a replacement execution', async () => {
  const f = await admitted();
  const configs = new MemoryConciergeConfigStore();
  await configs.updateWatcherConfig('watcher-owner', 0, { scope: 'all', enabled: false, memberCatId: 'codex' });
  let models = 0;
  const service = {
    boundedWatcherSessionCapability: () => ({ supported: true }),
    async *invoke() {
      models++;
      throw new Error('No provider was admitted before the crash');
    },
  };
  const errors = [];
  const supervisor = new WatcherSupervisor({
    ...f.owners,
    configs,
    userId: 'watcher-owner',
    labels: { list: async () => [] },
    service: () => service,
    capability: () => ({ supported: true }),
    report: (error) => errors.push(error),
  });
  await supervisor.start();
  try {
    await supervisor.poll();
    await flush();
    await supervisor.poll();
    await flush();
    assert.equal((await f.w.executions.get(f.auth.invocationId)).status, 'interrupted');
    assert.equal((await f.w.registry.verify(f.auth.invocationId, f.auth.callbackToken)).ok, false);
    assert.equal((await f.w.executions.listByParent(`watcher-source:codex:${f.source.invocationId}`)).length, 1);
    assert.equal(models, 0);
    assert.equal(errors.length, 0);
    assert.equal(parseWatcherSessionState((await f.w.sessions.get(f.session.id)).watcherState).afterSequence, 0);
  } finally {
    await supervisor.stop();
  }
});

for (const mode of ['disabled', 'switched']) {
  test(`native prune before its next CAS is recovered for the original member when ${mode}`, async () => {
    const f = await admitted();
    const bound = await f.w.sessions.bindCliSessionIdIfUnbound(f.session.id, `native-${mode}`);
    await f.w.executions.markProviderStarted(f.auth.invocationId, Date.now());
    await f.w.sessions.compareAndSetWatcherState(bound.id, 0, {
      revision: 1,
      afterSequence: 0,
      notes: 'old',
      wakeInvocationId: f.auth.invocationId,
      attempt: {
        invocationId: f.auth.invocationId,
        sourceInvocationId: f.source.invocationId,
        sourceSequence: f.source.settledSequence,
        startedAt: Date.now(),
        phase: 'running',
        nativeTurnId: 'completed-turn',
        window: { frontier: 'raw', offset: 0, messageIds: ['raw'] },
      },
    });
    let pruned = false,
      reverts = 0;
    const client = {
      async request(method) {
        if (method === 'thread/revert') {
          pruned = true;
          reverts++;
          return {};
        }
        return {
          thread: {
            id: bound.cliSessionId,
            turns: pruned
              ? []
              : [
                  {
                    id: 'completed-turn',
                    status: 'completed',
                    items: [
                      {
                        type: 'agentMessage',
                        phase: 'final',
                        text: JSON.stringify({ v: 1, notes: 'saved', consumedThrough: 'raw:0', outcome: 'remembered' }),
                      },
                    ],
                  },
                ],
          },
        };
      },
    };
    const cas = f.w.sessions.compareAndSetWatcherState.bind(f.w.sessions);
    let die = true;
    f.w.sessions.compareAndSetWatcherState = (...args) => {
      if (args[2].attempt?.phase === 'finalize_pending' && die) {
        die = false;
        throw new Error('API exits after native revert before finalization CAS');
      }
      return cas(...args);
    };
    await assert.rejects(
      commitWatcherCheckpoint(
        f.owners,
        bound,
        parseWatcherSessionState((await f.w.sessions.get(bound.id)).watcherState),
        client,
        { reportedAt: Date.now() },
      ),
      /API exits/,
    );
    assert.equal((await f.w.sessions.get(bound.id)).watcherState.attempt.phase, 'prune_pending');
    const configs = new MemoryConciergeConfigStore();
    await configs.updateWatcherConfig('watcher-owner', 0, {
      scope: 'all',
      enabled: mode !== 'disabled',
      memberCatId: mode === 'switched' ? 'opus' : 'codex',
    });
    const errors = [];
    let recovered = 0;
    const supervisor = new WatcherSupervisor({
      ...f.owners,
      configs,
      userId: 'watcher-owner',
      labels: { list: async () => [] },
      service: (catId) => {
        assert.equal(catId, 'codex');
        return {};
      },
      capability: () => ({ supported: true }),
      report: (error) => errors.push(error),
      run: async (owners, input) => {
        recovered++;
        assert.equal(input.recoveryOnly, true);
        const state = await recoverWatcherAttempt(
          owners,
          bound,
          parseWatcherSessionState((await owners.sessions.get(bound.id)).watcherState),
          client,
          false,
        );
        await finalizeWatcherWake(owners, bound, state);
      },
    });
    await supervisor.start();
    try {
      if (mode === 'disabled') {
        await supervisor.poll();
        await flush();
        assert.equal(recovered, 0, 'disabled cannot launch a control-only provider either');
        assert.equal((await f.w.sessions.get(bound.id)).watcherState.attempt.phase, 'prune_pending');
        await configs.updateWatcherConfig('watcher-owner', 1, { enabled: true });
      }
      await supervisor.poll();
      await flush();
      await supervisor.poll();
      await flush();
      assert.equal((await f.w.executions.get(f.auth.invocationId)).status, 'succeeded');
      assert.equal((await f.w.registry.verify(f.auth.invocationId, f.auth.callbackToken)).ok, false);
      assert.equal((await f.w.sessions.get(bound.id)).watcherState.attempt, undefined);
      assert.equal((await f.w.sessions.get(bound.id)).watcherState.notes, 'saved');
      assert.equal(reverts, 1);
      assert.equal(recovered, 1);
      assert.equal(errors.length, 0);
    } finally {
      await supervisor.stop();
    }
  });
}

for (const lateAbort of ['watcher_supervisor_stopped', 'watcher_deadline_exceeded']) {
  test(`the complete recovery invocation cannot project teardown for an exact native turn still active after ${lateAbort}`, async () => {
    const f = await admitted();
    const bound = await f.w.sessions.bindCliSessionIdIfUnbound(f.session.id, 'active-native');
    await f.w.executions.markProviderStarted(f.auth.invocationId, Date.now());
    await f.w.sessions.compareAndSetWatcherState(bound.id, 0, {
      revision: 1,
      afterSequence: 0,
      notes: 'unchanged',
      wakeInvocationId: f.auth.invocationId,
      rawWindowTokens: 1250,
      attempt: {
        invocationId: f.auth.invocationId,
        sourceInvocationId: f.source.invocationId,
        sourceSequence: f.source.settledSequence,
        startedAt: Date.now(),
        phase: 'failed',
        nativeTurnId: 'still-active',
        window: { frontier: 'raw', offset: 0, messageIds: ['raw'] },
      },
    });
    const methods = [];
    const client = {
      async request(method) {
        methods.push(method);
        return { thread: { id: 'active-native', turns: [{ id: 'still-active', status: 'inProgress', items: [] }] } };
      },
    };
    const abort = new AbortController();
    const service = {
      boundedWatcherSessionCapability: () => ({ supported: true }),
      async *invoke(_prompt, options) {
        try {
          await options.boundedWatcher.beforeTurn({ threadId: 'active-native', client });
        } catch (error) {
          abort.abort(new Error(lateAbort));
          throw error;
        }
        throw new Error('active recovery must not admit a model request');
      },
    };
    const { runWatcherInvocation } = await import('../dist/domains/concierge/watcher/watcher-invocation.js');
    await assert.rejects(
      runWatcherInvocation(
        { ...f.owners, maySpeak: async () => false },
        {
          session: bound,
          source: f.source,
          service,
          quiet: true,
          recoveryOnly: true,
          signal: abort.signal,
        },
      ),
      /watcher_native_still_active/,
    );
    const execution = await f.w.executions.get(f.auth.invocationId);
    assert.equal(execution.status, 'running');
    assert.equal(execution.providerTeardownAt, undefined);
    assert.equal((await f.w.registry.verify(f.auth.invocationId, f.auth.callbackToken)).ok, true);
    assert.equal((await f.w.sessions.get(bound.id)).watcherState.afterSequence, 0);
    assert.equal(methods.includes('thread/revert'), false);
  });
}
