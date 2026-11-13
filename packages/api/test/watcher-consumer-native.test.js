import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { test } from 'node:test';
import { parseWatcherSessionState } from '@cat-cafe/shared';
import { estimateTokens } from '../dist/utils/token-counter.js';
import { nativeWatcherAvailable, watcherNativeFixture } from './helpers/watcher-native-fixture.js';
import { watcherWorld } from './helpers/watcher-world.js';

test(
  'every real continuation budgets escaped calls, reasoning and final output at its provider request boundary',
  { timeout: 40000, skip: !nativeWatcherAvailable },
  async () => {
    const w = await watcherWorld();
    const f = await watcherNativeFixture(w);
    try {
      const [source] = await w.work('RAW_INCREMENT_6');
      f.state.tools = 6;
      f.state.argumentPadding = '"\\\n'.repeat(70);
      f.state.reasoningPadding = 'bounded reasoning '.repeat(30);
      const session = await f.run(source, AbortSignal.timeout(30000));
      assert.equal(session.watcherState.afterSequence, source.settledSequence);
      assert.equal(f.requests.length, 7);
      for (const request of f.requests) {
        assert.ok(
          Number.isSafeInteger(request.body.max_output_tokens),
          'each actual continuation needs an output/reasoning limit',
        );
        assert.ok(estimateTokens(request.wire) + request.body.max_output_tokens <= 30000);
      }
    } finally {
      await f.close();
    }
  },
);

test(
  'a failed checkpoint recovers the exact auth and six-call allowance instead of opening a fresh budget',
  { timeout: 40000, skip: !nativeWatcherAvailable },
  async () => {
    const w = await watcherWorld();
    const f = await watcherNativeFixture(w);
    try {
      const [source] = await w.work('RAW_INCREMENT_11');
      f.state.tools = 6;
      f.state.invalidCheckpoint = true;
      await assert.rejects(f.run(source, AbortSignal.timeout(20000)), /window_or_notes_invalid/);
      // Resolve through the canonical purpose key, whose encoding is not a test-owned convention.
      const { watcherSessionChainKey } = await import('../dist/domains/cats/services/session/session-scope.js');
      const failed = await w.sessions.getByChainKey(watcherSessionChainKey('watcher-owner', 'codex', w.thread.id));
      const authId = failed.watcherState.attempt.invocationId;
      const originalAuth = await w.registry.peekRecord(authId);
      assert.equal((await w.registry.verify(authId, originalAuth.callbackToken)).ok, true);
      assert.equal(await w.registry.watcherToolCallCount(authId), 6);
      f.state.invalidCheckpoint = false;
      f.state.tools = 1; // One bounded denial, then the model supplies its final checkpoint.
      const recovered = await f.run(source, AbortSignal.timeout(20000));
      assert.equal(recovered.cliSessionId, failed.cliSessionId);
      assert.equal(recovered.watcherState.afterSequence, source.settledSequence);
      assert.equal(await w.registry.watcherToolCallCount(authId), 6);
      assert.equal(f.enqueues.length, 6);
      const attempts = await w.executions.listByParent(`watcher-source:codex:${source.invocationId}`);
      assert.equal(attempts.length, 1);
      assert.equal(attempts[0].invocationId, authId);
      assert.equal(Object.keys(attempts[0].watcherModelAttempts).length, f.requests.length);
    } finally {
      await f.close();
    }
  },
);

test(
  'persistent budget pressure stays below 30k and records a skipped original instead of replaying it forever',
  { timeout: 40000, skip: !nativeWatcherAvailable },
  async () => {
    const w = await watcherWorld();
    const f = await watcherNativeFixture(w);
    try {
      const [source] = await w.work('RAW_INCREMENT_13 ' + 'current original '.repeat(300));
      f.state.tools = 6;
      f.state.argumentPadding = '"\\\n'.repeat(180);
      f.state.reasoningPadding = 'long reasoning with concrete facts '.repeat(260);
      const events = [];
      const append = f.owners.transcript.appendDurableEvent.bind(f.owners.transcript);
      f.owners.transcript.appendDurableEvent = async (session, event, id) => {
        await append(session, event, id);
        events.push(event);
      };
      await f.run(source, AbortSignal.timeout(30000));
      assert.ok(f.requests.length > 1 && f.requests.length <= 25);
      for (const request of f.requests)
        assert.ok(estimateTokens(request.wire) + request.body.max_output_tokens <= 30000);
      const { watcherSessionChainKey } = await import('../dist/domains/cats/services/session/session-scope.js');
      const session = await w.sessions.getByChainKey(watcherSessionChainKey('watcher-owner', 'codex', w.thread.id));
      assert.equal(session.watcherState.afterSequence, source.settledSequence);
      assert.equal(session.watcherState.attempt, undefined);
      const skipped = events.find((e) => e.type === 'watcher_window_skipped');
      assert.ok(skipped, 'the skipped input is explicit, not falsely acknowledged as read');
      assert.ok(skipped.messageIds.includes(source.responseSettlement.messageId));
      const [wake] = await w.executions.listByParent(`watcher-source:codex:${source.invocationId}`);
      assert.equal(wake.status, 'failed');
      assert.equal(wake.terminalReason, 'watcher_context_budget_skipped');
      assert.equal(session.watcherState.rawWindowTokens, undefined);
      f.state.tools = 0;
      f.state.argumentPadding = '';
      f.state.reasoningPadding = '';
      const [nextSource] = await w.work('RAW_INCREMENT_14 ' + '無關新回話。'.repeat(40));
      const { watcherWindow } = await import('../dist/domains/concierge/watcher/context/watcher-window.js');
      const nextWindow = await watcherWindow(w.messages, nextSource, session.watcherState, '', []);
      assert.equal(nextWindow.tokenBudget, 2500);
      assert.equal(nextWindow.complete, true);
      const nextSession = await f.run(nextSource, AbortSignal.timeout(10000));
      assert.equal(nextSession.watcherState.afterSequence, nextSource.settledSequence);
    } finally {
      await f.close();
    }
  },
);

test(
  'the complete watcher consumer uses actual native tools, saves notes after six calls, and resumes a bounded thread for fifty working endings',
  { timeout: 240_000, skip: nativeWatcherAvailable ? false : 'Local Codex CLI not installed' },
  async () => {
    const w = await watcherWorld();
    const f = await watcherNativeFixture(w);
    const sessions = new Set();
    const prefixTokens = [];
    try {
      for (let round = 1; round <= 50; round++) {
        const firstRequest = f.requests.length;
        const [source] = await w.work(`RAW_INCREMENT_${round}`);
        f.state.tools = round === 1 ? 6 : 0;
        const session = await f.run(source, AbortSignal.timeout(20_000));
        sessions.add(session.cliSessionId);
        const checkpoint = parseWatcherSessionState(session.watcherState);
        assert.equal(checkpoint.notes, `saved-note-${round}`);
        assert.equal(checkpoint.afterSequence, source.settledSequence);
        assert.equal(checkpoint.attempt, undefined);
        const last = f.requests.at(-1);
        prefixTokens.push(estimateTokens(last.wire));
        assert.ok(prefixTokens.at(-1) <= 30_000);
        for (const request of f.requests.slice(firstRequest))
          assert.ok(
            estimateTokens(request.wire) + request.body.max_output_tokens <= 30_000,
            'every actual continuation includes a reasoning/final-output limit',
          );
        if (round > 1) assert.equal(last.wire.includes('RAW_INCREMENT_1\\n'), false);
      }
      assert.equal(sessions.size, 1);
      assert.equal(f.enqueues.length, 6, 'idempotent retries return the same queued message');
      assert.equal(new Set(f.enqueues.map((item) => item.id)).size, 1);
      const watcher = (
        await w.executions.listSettled({ userId: 'watcher-owner', threadId: w.thread.id, limit: 200 })
      ).records.filter((item) => item.executionKind === 'watcher');
      assert.equal(watcher.length, 50);
      assert.equal(
        watcher[0].watcherUsage.inputTokens,
        70,
        'usage is the real native protocol aggregation of fixture requests',
      );
      await writeFile(
        '/tmp/f335-watcher-consumer-evidence.json',
        JSON.stringify(
          {
            fixture: true,
            rounds: 50,
            nativeSessionCount: sessions.size,
            prefixTokens,
            maximumWireTokens: Math.max(...prefixTokens),
            toolCalls: 6,
            usageIsFixture: true,
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

test(
  'a half-million-token older thread and a large current reply still leave room for maximum own notes in the real native request',
  { timeout: 60_000, skip: nativeWatcherAvailable ? false : 'Local Codex CLI not installed' },
  async () => {
    const w = await watcherWorld();
    for (let i = 0; i < 16; i++)
      await w.messages.append({
        userId: 'watcher-owner',
        threadId: w.thread.id,
        from: { kind: 'agent', catId: 'codex' },
        content: 'OLDER_RAW_MUST_NOT_BE_REPLAYED ' + 'old context '.repeat(16000),
        timestamp: Date.now() - 100000 + i,
        mentions: [],
      });
    for (let i = 0; i < 7; i++)
      await w.messages.append({
        userId: 'watcher-owner',
        threadId: w.thread.id,
        from: { kind: 'agent', catId: 'codex' },
        content: 'recent original',
        timestamp: Date.now() - 1000 + i,
        mentions: [],
      });
    const f = await watcherNativeFixture(w);
    f.state.notePadding = ' useful concrete note.'.repeat(350);
    try {
      for (let round = 1; round <= 2; round++) {
        const [source] = await w.work(`RAW_INCREMENT_${round} ` + 'current original '.repeat(400));
        assert.equal(source.status, 'succeeded');
        let session;
        for (let window = 0; window < 16; window++) {
          session = await f.run(source, AbortSignal.timeout(20_000));
          assert.ok(estimateTokens(f.requests.at(-1).wire) <= 30000);
          assert.equal(f.requests.at(-1).wire.includes('OLDER_RAW_MUST_NOT_BE_REPLAYED'), false);
          if (session.watcherState.afterSequence === source.settledSequence) break;
          assert.ok(
            session.watcherState.messageOffset > 0,
            'an unacknowledged source must retain its exact continuation',
          );
        }
        assert.equal(session.watcherState.afterSequence, source.settledSequence);
        assert.ok(estimateTokens(f.requests.at(-1).wire) <= 30000);
        assert.equal(f.requests.at(-1).wire.includes('OLDER_RAW_MUST_NOT_BE_REPLAYED'), false);
      }
    } finally {
      await f.close();
    }
  },
);

test(
  'a seventh tool request is rejected while the model can still save its final notes',
  { timeout: 30_000, skip: nativeWatcherAvailable ? false : 'Local Codex CLI not installed' },
  async () => {
    const w = await watcherWorld();
    const f = await watcherNativeFixture(w);
    try {
      const [source] = await w.work('RAW_INCREMENT_7');
      f.state.tools = 7;
      const session = await f.run(source, AbortSignal.timeout(20_000));
      assert.equal(session.watcherState.notes, 'saved-note-7');
      assert.equal(session.watcherState.afterSequence, source.settledSequence);
      assert.equal(f.enqueues.length, 6);
      assert.match(f.requests.at(-1).wire, /watcher_tool_budget_exhausted/u);
    } finally {
      await f.close();
    }
  },
);

test(
  'a no-response source remains pending across actual native windows until all original pages are consumed',
  { timeout: 30_000, skip: nativeWatcherAvailable ? false : 'Local Codex CLI not installed' },
  async () => {
    const w = await watcherWorld();
    const f = await watcherNativeFixture(w);
    try {
      const [baseline] = await w.work('RAW_INCREMENT_1');
      const firstSession = await f.run(baseline, AbortSignal.timeout(20_000));
      for (let i = 0; i < 45; i++)
        await w.messages.append({
          userId: 'watcher-owner',
          threadId: w.thread.id,
          from: { kind: 'user', userId: 'watcher-owner' },
          content: `RAW_INCREMENT_2 ORIGINAL_${i}`,
          timestamp: Date.now(),
          mentions: [],
        });
      const [source] = await w.work('');
      assert.equal(source.responseSettlement.kind, 'no_response');
      const partial = await f.run(source, AbortSignal.timeout(20_000));
      assert.ok(partial.watcherState.afterSequence < source.settledSequence);
      assert.equal(partial.cliSessionId, firstSession.cliSessionId);
      const complete = await f.run(source, AbortSignal.timeout(20_000));
      assert.equal(complete.cliSessionId, firstSession.cliSessionId);
      assert.equal(complete.watcherState.afterSequence, source.settledSequence);
      assert.ok(f.requests.at(-1).wire.includes('ORIGINAL_44'));
    } finally {
      await f.close();
    }
  },
);

test(
  'a pause admitted while the model is thinking blocks its attempted nudge and still saves notes',
  { timeout: 30_000, skip: nativeWatcherAvailable ? false : 'Local Codex CLI not installed' },
  async () => {
    const w = await watcherWorld();
    const f = await watcherNativeFixture(w);
    try {
      const [source] = await w.work('RAW_INCREMENT_8');
      f.state.tools = 1;
      f.state.entered = () => {
        f.state.quiet = true;
      };
      const session = await f.run(source, AbortSignal.timeout(20_000));
      assert.equal(session.watcherState.notes, 'saved-note-8');
      assert.equal(f.enqueues.length, 0);
      assert.match(f.requests.at(-1).wire, /Watcher is quiet/u);
    } finally {
      await f.close();
    }
  },
);
