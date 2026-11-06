import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay, setImmediate } from 'node:timers/promises';
import vm from 'node:vm';
import { parseWatcherSessionState } from '@cat-cafe/shared';
import ts from 'typescript';
import { InvocationQueue } from '../dist/domains/cats/services/agents/invocation/InvocationQueue.js';
import { watcherSessionChainKey } from '../dist/domains/cats/services/session/session-scope.js';
import { MemoryConciergeConfigStore } from '../dist/domains/concierge/ConciergeConfigStore.js';
import { WatcherSupervisor } from '../dist/domains/concierge/watcher/WatcherSupervisor.js';
import { watcherInvocationAuthority } from '../dist/domains/concierge/watcher/watcher-authority.js';
import { saveWatcherState } from '../dist/domains/concierge/watcher/watcher-checkpoint.js';
import { applyDirectWatcherControl } from '../dist/domains/concierge/watcher/watcher-controls.js';
import { watcherRoutes } from '../dist/routes/watcher.js';
import {
  readCliProcessOwnerRecords,
  readUnixProcessSnapshot,
  sameUnixProcess,
} from '../dist/utils/cli-process-ownership.js';
import { nativeWatcherAvailable, watcherNativeFixture } from './helpers/watcher-native-fixture.js';
import { watcherWorld } from './helpers/watcher-world.js';

async function until(check) {
  const deadline = Date.now() + 15000;
  while (!(await check())) {
    assert.ok(Date.now() < deadline, 'native observation timed out');
    await delay(10);
  }
}
async function admission(context) {
  const text = await readFile(new URL('../src/index.ts', import.meta.url), 'utf8');
  const source = ts.createSourceFile('index.ts', text, ts.ScriptTarget.Latest, true);
  let callback;
  const walk = (node) => {
    if (ts.isNewExpression(node) && node.expression.getText(source) === 'InvocationQueue')
      callback = node.arguments[1].properties
        .find((p) => p.name?.getText(source) === 'onAdmitted')
        .initializer.getText(source);
    ts.forEachChild(node, walk);
  };
  walk(source);
  assert.ok(callback);
  return vm.runInNewContext(
    ts.transpileModule(`const handler=${callback};handler;`, {
      compilerOptions: { target: ts.ScriptTarget.ES2022 },
    }).outputText,
    context,
  );
}

test(
  'a real CLI completes a watcher turn using the owned HTTPS provider identity and saves its checkpoint',
  { timeout: 30000, skip: !nativeWatcherAvailable },
  async () => {
    const w = await watcherWorld();
    // Local API-key Responses fixture, with the same provider ID selected by the OAuth launch test.
    const f = await watcherNativeFixture(w, { providerId: 'openai_https' });
    try {
      const [source] = await w.work('RAW_INCREMENT_33');
      const session = await f.run(source, AbortSignal.timeout(20000));
      assert.equal(session.watcherState.notes, 'saved-note-33');
      assert.equal(session.watcherState.afterSequence, source.settledSequence);
      assert.equal(f.requests.length, 1);
      assert.equal(f.state.nativeLaunchPids.length, 1);
      const [wake] = await w.executions.listByParent(`watcher-source:codex:${source.invocationId}`);
      assert.equal(wake.status, 'succeeded');
      assert.equal(Object.keys(wake.watcherModelAttempts).length, 1);
    } finally {
      await f.close();
    }
  },
);

for (const control of ['conversation', 'settings']) {
  test(
    `actual ${control} stop ends a hung native CLI and repeated polls do not launch another`,
    { timeout: 40000, skip: !nativeWatcherAvailable },
    async () => {
      const previousOwner = process.env.DEFAULT_OWNER_USER_ID;
      process.env.DEFAULT_OWNER_USER_ID = 'watcher-owner';
      const w = await watcherWorld(),
        configs = new MemoryConciergeConfigStore();
      await configs.updateWatcherConfig('watcher-owner', 0, { scope: 'all', memberCatId: 'codex' });
      let supervisor;
      const f = await watcherNativeFixture(w, {
        configure: async ({ app }) => {
          app.addHook('onRequest', async (request) => {
            request.sessionUserId = request.headers['x-fixture-session'];
          });
          await app.register(watcherRoutes, {
            configStore: configs,
            threadStore: w.threads,
            turnExecutionStore: w.executions,
            labelStore: { list: async () => [] },
            capability: () => ({ supported: true }),
            rolloutEnabled: true,
            runtimeReady: () => true,
            controlChanged: (threadId) => supervisor.controlChanged(threadId),
          });
        },
      });
      supervisor = new WatcherSupervisor({
        ...f.owners,
        configs,
        userId: 'watcher-owner',
        labels: { list: async () => [] },
        service: () => f.service,
        capability: () => ({ supported: true }),
        report() {},
      });
      f.state.mode = 'hang';
      try {
        await supervisor.start();
        const [source] = await w.work('RAW_INCREMENT_34');
        await supervisor.poll();
        await until(() => f.requests.length === 1);
        const session = await w.sessions.getByChainKey(watcherSessionChainKey(source.userId, 'codex', source.threadId));
        const id = session.watcherState.attempt.invocationId;
        const root = readCliProcessOwnerRecords(join(f.root, 'data')).records.find(
          (record) => record.manifest.supervisor.pid === f.state.nativeSupervisorPid,
        )?.manifest.root;
        assert.ok(root);
        if (control === 'settings') {
          const result = await f.app.inject({
            method: 'PUT',
            url: '/api/watcher/config',
            headers: { host: 'localhost', origin: 'http://localhost:3171', 'x-fixture-session': 'watcher-owner' },
            payload: { expectedRevision: 1, enabled: false },
          });
          assert.equal(result.statusCode, 200, result.body);
        } else {
          const queue = new InvocationQueue(undefined, {
            onAdmitted: await admission({
              applyDirectWatcherControl,
              threadStore: w.threads,
              watcherSupervisor: supervisor,
              conciergeConfigStoreShared: configs,
              watcherReceipts: { async control() {} },
              queueProcessor: { registerCallerDispatchInitialTargets() {}, async requestDrain() {} },
              app: { log: { warn() {}, error() {} } },
            }),
          });
          const input = {
            userId: source.userId,
            threadId: source.threadId,
            from: { kind: 'user', userId: source.userId },
            content: '这条别守望了',
            timestamp: Date.now(),
            mentions: [],
            deliveryStatus: 'queued',
          };
          const result = await queue.send(w.messages, input, {
            ...input,
            sourceId: 'native-stop-message',
            kind: 'conversation_input',
            ownerAuthProvenance: 'strict',
            targetCats: ['codex'],
            intent: 'execute',
          });
          assert.equal(result.outcome, 'enqueued');
          await until(async () => (await w.threads.get(source.threadId)).watcher?.enabled === false);
        }
        await until(async () => (await w.executions.get(id)).status !== 'running');
        assert.equal(sameUnixProcess(root, (await readUnixProcessSnapshot()).get(root.pid)), false);
        for (let i = 0; i < 6; i++) {
          await supervisor.poll();
          for (let j = 0; j < 20; j++) await setImmediate();
        }
        assert.equal(f.state.nativeLaunchPids.length, 1);
        assert.equal(f.requests.length, 1);
        assert.ok((await w.executions.get(id)).providerTeardownAt);
      } finally {
        await supervisor.stop();
        f.releaseResponses();
        await f.close();
        if (previousOwner === undefined) delete process.env.DEFAULT_OWNER_USER_ID;
        else process.env.DEFAULT_OWNER_USER_ID = previousOwner;
      }
    },
  );
}

test(
  'actual CLI resume failures obey the durable backoff and launch cap across supervisor restart',
  { timeout: 40000, skip: !nativeWatcherAvailable },
  async () => {
    const w = await watcherWorld(),
      f = await watcherNativeFixture(w);
    const [source] = await w.work('RAW_INCREMENT_35');
    const session = await w.sessions.getOrCreateActive({
      userId: source.userId,
      threadId: source.threadId,
      catId: 'codex',
      sessionPurpose: 'watcher',
      chainKey: watcherSessionChainKey(source.userId, 'codex', source.threadId),
    });
    const run = { session, state: parseWatcherSessionState(undefined), prefixTokens: 0, committed: false };
    const { auth } = await watcherInvocationAuthority(f.owners, run, source, []);
    await w.sessions.bindCliSessionIdIfUnbound(session.id, 'missing-native-fixture');
    await saveWatcherState(w.sessions, session.id, run.state, {
      activationCut: '0:0',
      wakeInvocationId: auth.invocationId,
      attempt: {
        invocationId: auth.invocationId,
        sourceInvocationId: source.invocationId,
        sourceSequence: source.settledSequence,
        startedAt: Date.now(),
        phase: 'failed',
      },
    });
    const configs = new MemoryConciergeConfigStore();
    await configs.updateWatcherConfig(source.userId, 0, { scope: 'all', memberCatId: 'codex' });
    let now = Date.now();
    const errors = [];
    const options = {
      ...f.owners,
      now: () => now,
      configs,
      userId: source.userId,
      labels: { list: async () => [] },
      service: () => f.service,
      capability: () => ({ supported: true }),
      report: (err) => errors.push(err),
    };
    let supervisor = new WatcherSupervisor(options);
    try {
      await supervisor.start();
      await until(() => errors.length === 1);
      for (let i = 0; i < 5; i++) await supervisor.poll();
      assert.equal(f.state.nativeLaunchPids.length, 1);
      now += 5001;
      await supervisor.poll();
      await until(() => errors.length === 2);
      now += 20001;
      await supervisor.poll();
      await until(() => errors.length === 3);
      await supervisor.stop();
      supervisor = new WatcherSupervisor(options);
      now += 120000;
      await supervisor.start();
      for (let i = 0; i < 5; i++) await supervisor.poll();
      assert.equal(f.state.nativeLaunchPids.length, 3);
      assert.equal(f.requests.length, 0);
      assert.equal((await w.executions.get(auth.invocationId)).status, 'running', 'no fabricated native stop proof');
    } finally {
      await supervisor.stop();
      await f.close();
    }
  },
);
