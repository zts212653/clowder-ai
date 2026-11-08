import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { watcherSessionChainKey } from '../dist/domains/cats/services/session/session-scope.js';
import { nativeWatcherAvailable, watcherNativeFixture } from './helpers/watcher-native-fixture.js';
import { watcherWorld } from './helpers/watcher-world.js';

function budgetFailure(reply) {
  reply.hijack();
  reply.raw.writeHead(200, { 'content-type': 'text/event-stream' });
  const response = {
    id: 'budget-pressure',
    status: 'incomplete',
    output: [],
    incomplete_details: { reason: 'max_output_tokens' },
    usage: { input_tokens: 10, output_tokens: 2 },
  };
  for (const event of [
    { type: 'response.created', response: { ...response, status: 'in_progress' } },
    { type: 'response.incomplete', response },
  ])
    reply.raw.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  reply.raw.end();
}

for (const scenario of ['budget-deadline', 'plain-deadline', 'budget-disabled'])
  test(
    `native ${scenario} retains the owner cancellation and only proven budget recovery can skip`,
    { timeout: 40000, skip: !nativeWatcherAvailable },
    async () => {
      const w = await watcherWorld();
      const outer = new AbortController();
      const events = [];
      let expiry;
      const hasBudget = scenario.startsWith('budget-');
      const reason = scenario === 'budget-disabled' ? 'watcher_disabled' : 'watcher_deadline_exceeded';
      const f = await watcherNativeFixture(w, {
        model: 'gpt-6.1-sol',
        respond({ reply, requests, state }) {
          if (hasBudget && requests.length === 1) {
            budgetFailure(reply);
            return true;
          }
          // An owner timer fires only after a native request has entered the transport.
          // This is an external owner deadline, not an injected provider error or socket failure.
          if (!outer.signal.aborted) {
            state.mode = 'hang';
            expiry = setTimeout(() => outer.abort(new Error(reason)), 50);
          }
          return false;
        },
      });
      const append = f.owners.transcript.appendDurableEvent.bind(f.owners.transcript);
      f.owners.transcript.appendDurableEvent = async (...args) => {
        await append(...args);
        events.push(args[1]);
      };
      try {
        const captured = process.env.F335_DEADLINE_CAPTURE_FILE
          ? JSON.parse(await readFile(process.env.F335_DEADLINE_CAPTURE_FILE, 'utf8'))
          : undefined;
        const [source] = await w.work(captured?.content ?? 'RAW_INCREMENT_81 bounded original with a slow recovery');
        let failure;
        try {
          await f.run(source, outer.signal);
        } catch (error) {
          failure = error;
        }
        const expected = scenario === 'budget-deadline' ? 'watcher_context_recovery_deadline_exceeded' : reason;
        assert.equal(failure?.message, expected);
        let session = await w.sessions.getByChainKey(watcherSessionChainKey('watcher-owner', 'codex', w.thread.id));
        assert.equal(session.watcherState.attempt.failure, expected);
        assert.equal(session.watcherState.afterSequence, 0, 'a canceled live attempt has not yet been proved idle');
        assert.equal(session.watcherState.consumedThrough, undefined);
        assert.equal(events.filter((e) => e.type === 'watcher_window_skipped').length, 0);
        const audit = events.findLast((e) => e.type === 'watcher_attempt_failure');
        assert.equal(audit.abortReason, reason);
        if (scenario !== 'budget-deadline') return;
        assert.equal(session.watcherState.rawWindowTokens, 1250);
        const sent = f.requests.length;
        f.state.mode = 'normal';
        session = await f.run(source, AbortSignal.timeout(15000));
        assert.equal(f.requests.length, sent, 'idle reconciliation cannot issue another model request');
        assert.equal(session.watcherState.consumedThrough, source.responseSettlement.messageId);
        assert.equal(session.watcherState.afterSequence, source.settledSequence);
        assert.equal(session.watcherState.rawWindowTokens, undefined);
        const skipped = events.find((e) => e.type === 'watcher_window_skipped');
        assert.equal(skipped.reason, expected);
        assert.deepEqual(skipped.messageIds, [source.responseSettlement.messageId]);
        assert.equal(
          events.some((e) => e.type === 'watcher_checkpoint'),
          false,
        );
        const [wake] = await w.executions.listByParent(`watcher-source:codex:${source.invocationId}`);
        assert.equal(wake.status, 'failed');
        assert.equal(wake.terminalReason, 'watcher_context_budget_skipped');
        const [next] = await w.work('RAW_INCREMENT_82 unrelated new reply');
        await f.run(next, AbortSignal.timeout(15000));
        assert.equal(f.requests.length, sent + 1);
        assert.equal(f.requests.at(-1).wire.includes(source.responseSettlement.messageId), false);
      } finally {
        clearTimeout(expiry);
        await f.close();
      }
    },
  );
