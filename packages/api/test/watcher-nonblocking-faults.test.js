import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { MemoryConciergeConfigStore } from '../dist/domains/concierge/ConciergeConfigStore.js';
import { WatcherSupervisor } from '../dist/domains/concierge/watcher/WatcherSupervisor.js';
import {
  readCliProcessOwnerRecords,
  readUnixProcessSnapshot,
  sameUnixProcess,
} from '../dist/utils/cli-process-ownership.js';
import { nativeWatcherAvailable, watcherNativeFixture } from './helpers/watcher-native-fixture.js';
import { watcherWorld } from './helpers/watcher-world.js';

const { recoverWatcherAttempt } = await import(
  process.env.F335_WATCHER_RECOVERY_RED_MODULE ?? '../dist/domains/concierge/watcher/watcher-checkpoint.js'
);

async function nextWork(w, text) {
  let timeout;
  try {
    const records = await Promise.race([
      w.work(text),
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error('main work waited for watcher')), 5000);
      }),
    ]);
    assert.equal(records.filter((record) => record.executionKind === 'ordinary').length, 1);
    const record = records.find((record) => record.executionKind === 'ordinary');
    assert.equal(
      record.status,
      'succeeded',
      JSON.stringify({
        reason: record.terminalReason,
        response:
          record.responseSettlement?.kind === 'message'
            ? (await w.messages.getById(record.responseSettlement.messageId))?.content
            : record.responseSettlement,
      }),
    );
    const reply = await w.messages.getById(record.responseSettlement.messageId);
    assert.equal(reply.content, text);
  } finally {
    clearTimeout(timeout);
  }
}

test(
  'a real observer source read failure cannot intercept the ordinary reply commit or its next invocation',
  { timeout: 20_000 },
  async () => {
    const w = await watcherWorld();
    const config = new MemoryConciergeConfigStore();
    await config.updateWatcherConfig('watcher-owner', 0, { scope: 'all', memberCatId: 'codex' });
    let sawFailure;
    const failed = new Promise((resolve) => {
      sawFailure = resolve;
    });
    const messages = new Proxy(w.messages, {
      get(target, property) {
        if (property === 'getById')
          return async () => {
            throw new Error('injected source read failure');
          };
        const value = Reflect.get(target, property);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const supervisor = new WatcherSupervisor({
      ...w,
      messages,
      configs: config,
      userId: 'watcher-owner',
      labels: { list: async () => [] },
      service: () => ({ boundedWatcherSessionCapability: () => ({ supported: true }) }),
      capability: () => ({ supported: true }),
      report(error) {
        sawFailure(error);
      },
    });
    await supervisor.start();
    try {
      await nextWork(w, 'Committed before read failure.');
      await supervisor.poll();
      assert.match(String(await failed), /source read failure/);
      await nextWork(w, 'The next invocation commits after the failure.');
    } finally {
      await supervisor.stop();
    }
  },
);

for (const fault of ['model hang', 'SIGKILL']) {
  test(
    `actual native watcher ${fault}: ordinary work commits and its next invocation proceeds`,
    { timeout: 60_000, skip: nativeWatcherAvailable ? false : 'Local Codex CLI not installed' },
    async () => {
      const w = await watcherWorld();
      const f = await watcherNativeFixture(w);
      const abort = new AbortController();
      let entered;
      const waiting = new Promise((resolve) => {
        entered = resolve;
      });
      f.state.mode = 'hang';
      f.state.entered = entered;
      const [source] = await w.work('RAW_INCREMENT_1');
      const running = f.run(source, abort.signal).then(
        () => ({ completed: true }),
        (error) => ({ error }),
      );
      try {
        await Promise.race([
          waiting,
          running.then((result) => {
            throw result.error ?? new Error('Watcher finished before reaching the model fixture');
          }),
        ]);
        await nextWork(w, `Commit while watcher has ${fault}.`);
        if (fault === 'model hang') {
          const session = (await w.sessions.getChain('codex', w.thread.id, 'watcher-owner')).find(
            (row) => row.sessionPurpose === 'watcher',
          );
          assert.ok(session?.watcherState.attempt?.nativeTurnId);
          const methods = [];
          const client = {
            request(method, args) {
              methods.push(method);
              return f.state.nativeClient.request(method, args);
            },
          };
          await assert.rejects(recoverWatcherAttempt(f.owners, session, session.watcherState, client), (error) => {
            assert.equal(
              methods.includes('thread/revert'),
              false,
              `actual native recovery methods=${methods.join(',')}`,
            );
            assert.match(String(error), /watcher_native_still_active/);
            return true;
          });
          assert.equal(methods.includes('thread/revert'), false, 'the actual active native turn must never be pruned');
          assert.equal(
            (await w.sessions.get(session.id)).watcherState.afterSequence,
            session.watcherState.afterSequence,
          );
        }
        if (fault === 'SIGKILL') {
          const record = readCliProcessOwnerRecords(join(f.root, 'data')).records.find(
            (record) => record.manifest.supervisor.pid === f.state.nativeSupervisorPid,
          );
          assert.ok(record?.manifest.root, 'the exact owned native fixture must be identified before killing it');
          const snapshot = await readUnixProcessSnapshot();
          assert.equal(sameUnixProcess(record.manifest.root, snapshot.get(record.manifest.root.pid)), true);
          process.kill(record.manifest.root.pid, 'SIGKILL');
        } else abort.abort(new Error('fixture hang deadline'));
        await nextWork(w, `The next turn commits after ${fault}.`);
        const ended = await running;
        assert.ok(ended.error, 'the native fault must actually be observed');
        f.releaseResponses();
        if (fault === 'SIGKILL') {
          f.state.mode = 'normal';
          f.state.entered = undefined;
          await f.run(source, AbortSignal.timeout(20_000)); // reconcile the exact interrupted native turn
          const resumed = await f.run(source, AbortSignal.timeout(20_000));
          assert.equal(resumed.watcherState.notes, 'saved-note-1');
        }
      } finally {
        abort.abort();
        f.releaseResponses();
        await running;
        await f.close();
      }
    },
  );
}
