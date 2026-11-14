import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { test } from 'node:test';
import { watcherSessionChainKey } from '../dist/domains/cats/services/session/session-scope.js';
import { registerCallbackAuthHook } from '../dist/routes/callback-auth-prehandler.js';
import { nativeWatcherAvailable, watcherNativeFixture } from './helpers/watcher-native-fixture.js';
import { watcherWorld } from './helpers/watcher-world.js';

test(
  'native code-mode rereads one directory once, consumes every bounded source slice, then excludes it from the next wake',
  { timeout: 180000, skip: !nativeWatcherAvailable },
  async () => {
    const captured = process.env.F335_CAPTURE_FILE
      ? JSON.parse(await readFile(process.env.F335_CAPTURE_FILE, 'utf8'))
      : {
          rows: Array.from({ length: 5 }, (_, i) => ({
            id: `original-${i}`,
            content: `SOURCE_${i} ` + '具体原话与未解线索。'.repeat(i === 4 ? 700 : 30),
            timestamp: 1000 + i,
            from: { kind: 'agent', catId: 'codex' },
            catId: 'codex',
          })),
          notes: 'prior concrete notes '.repeat(150),
          directory: {
            items: [
              {
                matterId: 'original-matter',
                title: 'Existing matter',
                revision: 1,
                description: 'original contextual summary '.repeat(250),
              },
            ],
          },
        };
    const w = await watcherWorld();
    let directoryGets = 0;
    const f = await watcherNativeFixture(w, {
      model: 'gpt-6.1-sol',
      async configure({ app }) {
        await app.register(async (scope) => {
          registerCallbackAuthHook(scope, w.registry);
          scope.get('/api/callbacks/memory-matters', async () => {
            directoryGets++;
            return captured.directory;
          });
        });
      },
    });
    try {
      const anchor = w.messages.appendWithReservedId(
        {
          userId: 'watcher-owner',
          threadId: w.thread.id,
          from: { kind: 'agent', catId: 'codex' },
          content: '',
          timestamp: 1,
          mentions: [],
        },
        'prior-consumed-original',
      );
      const rows = captured.rows.map((m) =>
        w.messages.appendWithReservedId(
          {
            userId: 'watcher-owner',
            threadId: w.thread.id,
            from: { kind: 'agent', catId: m.catId ?? m.from?.catId ?? 'codex' },
            content: m.content,
            timestamp: m.timelineOrderAt ?? m.timestamp,
            mentions: [],
          },
          m.id,
        ),
      );
      w.executions.createRunning({
        invocationId: 'captured-source',
        parentInvocationId: 'ordinary-parent',
        threadId: w.thread.id,
        userId: 'watcher-owner',
        catId: 'codex',
        executionKind: 'ordinary',
        outputFence: 'open',
        startedAt: 1,
      });
      await w.executions.transitionTerminal('captured-source', {
        status: 'succeeded',
        endedAt: 5000,
        providerTeardownAt: 5000,
      });
      await w.executions.markResponseSettled('captured-source', {
        kind: 'message',
        messageId: rows.at(-1).id,
        settledAt: Math.max(...rows.map((m) => m.timelineOrderAt ?? m.timestamp)) + 1,
      });
      const source = await w.executions.get('captured-source');
      const session = await w.sessions.getOrCreateActive({
        userId: 'watcher-owner',
        catId: 'codex',
        threadId: w.thread.id,
        sessionPurpose: 'watcher',
        chainKey: watcherSessionChainKey('watcher-owner', 'codex', w.thread.id),
      });
      await w.sessions.compareAndSetWatcherState(session.id, 0, {
        revision: 1,
        afterSequence: 0,
        consumedThrough: anchor.id,
        notes: captured.notes,
        rawWindowTokens: 128, // A terminated old wake must not constrain this new source.
      });
      f.state.codeMode = true;
      f.state.quiet = true;
      f.state.toolPlan = Array.from({ length: 3 }, () => ({
        name: 'cat_cafe_list_memory_matters',
        args: async () => {
          const current = await w.sessions.get(session.id);
          if ((await w.registry.watcherToolCallCount(current.watcherState.attempt.invocationId)) >= 5) {
            f.state.toolPlan = undefined;
            f.state.tools = 0;
          }
          return {};
        },
      }));
      let current;
      for (let i = 0; i < 50; i++) {
        current = await f.run(source, AbortSignal.timeout(60000));
        assert.equal(current.watcherState.rawWindowTokens, undefined);
        if (current.watcherState.afterSequence >= source.settledSequence) break;
      }
      assert.equal(current.watcherState.afterSequence, source.settledSequence);
      assert.equal(current.watcherState.attempt, undefined);
      assert.equal(
        directoryGets,
        1,
        JSON.stringify(
          f.requests.flatMap((r) =>
            (r.body.input ?? []).filter((i) => i.type.endsWith('_output')).map((i) => String(i.output).slice(0, 1500)),
          ),
        ),
      );
      const wake = (await w.executions.listByParent('watcher-source:codex:captured-source'))[0];
      assert.equal(wake.status, 'succeeded');
      assert.equal(wake.terminalReason, 'watcher_checkpoint_committed');
      const beforeNext = f.requests.length;
      const [next] = await w.work('FRESH_NEXT_SOURCE_ONLY');
      await f.run(next, AbortSignal.timeout(60000));
      const fresh = f.requests
        .slice(beforeNext)
        .map((r) => r.wire)
        .join('\n');
      for (const row of rows) assert.equal(fresh.includes(row.id), false, 'no replay of the old original coordinates');
      if (process.env.F335_REPLAY_OUTPUT)
        await writeFile(
          process.env.F335_REPLAY_OUTPUT,
          JSON.stringify(
            {
              captured: Boolean(process.env.F335_CAPTURE_FILE),
              sourceMessageIds: rows.map((r) => r.id),
              directoryGets,
              checkpoint: current.watcherState.notes,
              status: wake.status,
              terminalReason: wake.terminalReason,
              modelRequests: beforeNext,
              modelUsageIsFixture: true,
              nextWakeRequests: f.requests.length - beforeNext,
              nextWakeReplayedOldMessages: false,
              nativeCli: true,
            },
            null,
            2,
          ),
        );
    } finally {
      await f.close();
    }
  },
);
