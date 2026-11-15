import assert from 'node:assert/strict';
import { test } from 'node:test';
import { watcherSessionChainKey } from '../dist/domains/cats/services/session/session-scope.js';
import { InMemoryTurnExecutionStore } from '../dist/domains/cats/services/stores/memory/InMemoryTurnExecutionStore.js';
import { SessionChainStore } from '../dist/domains/cats/services/stores/ports/SessionChainStore.js';
import {
  commitWatcherCheckpoint,
  recoverWatcherAttempt,
  saveWatcherState,
} from '../dist/domains/concierge/watcher/watcher-checkpoint.js';
import { finalizeWatcherWake } from '../dist/domains/concierge/watcher/watcher-finalization.js';
import { watcherRawWindow } from '../dist/domains/concierge/watcher/watcher-prompt.js';
import { publicationFixture } from './helpers/watcher-publication.js';

for (const outcome of ['checkpoint', 'skip']) {
  test(`a late-published lifecycle original cannot re-enter after ${outcome}, and intervening originals are preserved`, async () => {
    const f = await publicationFixture();
    const sessions = new SessionChainStore();
    const session = sessions.create({
      userId: 'owner',
      threadId: 'line',
      catId: 'codex',
      sessionPurpose: 'watcher',
      chainKey: watcherSessionChainKey('owner', 'codex', 'line'),
      cliSessionId: 'native',
    });
    const executions = new InMemoryTurnExecutionStore();
    for (const [invocationId, executionKind] of [
      ['source', 'ordinary'],
      ['wake', 'watcher'],
    ]) {
      executions.createRunning({
        invocationId,
        parentInvocationId: invocationId,
        userId: 'owner',
        threadId: 'line',
        catId: 'codex',
        executionKind,
        outputFence: 'open',
        startedAt: 100,
        causal: { watcherSourceInvocationId: 'source' },
      });
    }
    executions.transitionTerminal('source', { status: 'succeeded', endedAt: 300 });
    const settled = executions.markResponseSettled('source', {
      kind: 'message',
      messageId: f.early.id,
      settledAt: 300,
    });
    let state = await saveWatcherState(
      sessions,
      session.id,
      { revision: 0, afterSequence: 0, notes: '' },
      {
        consumedThrough: f.baseline.id,
        messageOffset: 0,
        wakeInvocationId: 'wake',
      },
    );
    const events = [],
      delivered = [];
    const owners = {
      sessions,
      executions,
      registry: { peekRecord: async () => null },
      transcript: { appendDurableEvent: async (_ref, event) => events.push(event) },
    };
    let current, pruned;
    const client = {
      async request(method) {
        if (method === 'thread/revert') {
          pruned = true;
          return {};
        }
        assert.equal(method, 'thread/read');
        return {
          thread: {
            id: 'native',
            turns: pruned
              ? []
              : [
                  {
                    id: 'turn',
                    status: outcome === 'skip' ? 'interrupted' : 'completed',
                    items:
                      outcome === 'skip'
                        ? []
                        : [
                            {
                              type: 'agentMessage',
                              phase: 'final',
                              text: JSON.stringify({
                                v: 1,
                                notes: '',
                                consumedThrough: `${current.frontier}:${current.offset}`,
                                outcome: 'quiet',
                              }),
                            },
                          ],
                  },
                ],
          },
        };
      },
    };
    let quoted = '';
    for (let count = 0; count < 30; count++) {
      current = {
        ...(await watcherRawWindow(f.messages, 'owner', 'line', state, f.early.id, 300, 625)),
        tokenBudget: 625,
      };
      if (count === 0) {
        assert.deepEqual(
          current.messageIds,
          [...f.between.map((m) => m.id), f.early.id],
          'publication order retains the unread intervening messages',
        );
        assert.equal(current.resumeCursor, undefined, 'a newly published reply is not an older visible backfill');
      }
      delivered.push(...current.messageIds);
      const match = current.body.match(
        new RegExp(`<original messageId="${f.early.id}"[^>]*>\\n([\\s\\S]*?)\\n</original>`),
      );
      if (match) {
        assert.equal(/[\uD800-\uDBFF]$/u.test(match[1]), false);
        quoted += match[1];
      }
      const { body: _body, ...persistedWindow } = current;
      state = await saveWatcherState(sessions, session.id, state, {
        attempt: {
          invocationId: 'wake',
          sourceInvocationId: 'source',
          sourceSequence: settled.record.settledSequence,
          startedAt: 100,
          nativeTurnId: 'turn',
          phase: 'running',
          failure: outcome === 'skip' ? 'watcher_context_recovery_deadline_exceeded' : undefined,
          window: persistedWindow,
        },
      });
      pruned = false;
      state =
        outcome === 'skip'
          ? await recoverWatcherAttempt(owners, session, state, client)
          : await commitWatcherCheckpoint(owners, session, state, client, { reportedAt: 300 });
      if (state.attempt?.phase === 'finalize_pending') {
        state = await finalizeWatcherWake(owners, session, state);
        break;
      }
      assert.ok(count < 29, 'partial windows must converge');
    }
    assert.equal(state.consumedThrough, f.early.id);
    assert.equal(state.messageOffset, 0);
    assert.equal(state.attempt, undefined);
    assert.equal(state.rawWindowTokens, undefined);
    for (const message of f.between) assert.equal(delivered.filter((id) => id === message.id).length, 1);
    if (outcome === 'checkpoint') assert.equal(quoted, f.body, 'partial UTF-16 originals are consumed exactly once');
    else assert.ok(events.some((e) => e.type === 'watcher_window_skipped' && e.messageIds.includes(f.early.id)));
    const next = await f.messages.append(f.input('NEW_SOURCE', 400));
    const window = await watcherRawWindow(f.messages, 'owner', 'line', state, next.id, 400);
    assert.deepEqual(window.messageIds, [next.id], 'the next source must not repeat checkpointed or audited originals');
  });
}

test('an exact settled reply bounds publication order even when message start times are inverted', async () => {
  const f = await publicationFixture();
  const unread = await f.messages.append(f.input('CLOCK_AHEAD_UNREAD', 1000));
  const response = await f.messages.append(f.input('EXACT_SOURCE', 230));
  const after = await f.messages.append(f.input('PUBLISHED_AFTER_SOURCE', 150));
  const window = await watcherRawWindow(
    f.messages,
    'owner',
    'line',
    { revision: 1, afterSequence: 1, notes: '', consumedThrough: f.early.id },
    response.id,
    300,
    10000,
  );
  assert.deepEqual(window.messageIds, [unread.id, response.id]);
  assert.equal(window.complete, true);
  assert.equal(window.body.includes(after.content), false);
});

test('legacy message hashes resolve publication position through the existing MessageStore owner', async () => {
  const f = await publicationFixture();
  const get = f.messages.getById.bind(f.messages);
  f.messages.getById = (id) => {
    const message = get(id);
    return message ? { ...message, visibilitySeq: undefined } : null;
  };
  const window = await watcherRawWindow(
    f.messages,
    'owner',
    'line',
    { revision: 1, afterSequence: 1, notes: '', consumedThrough: f.baseline.id },
    f.early.id,
    300,
    625,
  );
  assert.deepEqual(window.messageIds, [...f.between.map((m) => m.id), f.early.id]);
  assert.equal(window.resumeCursor, undefined);
});

test('an unresolved publication position cannot be replaced by the response start time', async () => {
  const f = await publicationFixture();
  const get = f.messages.getById.bind(f.messages);
  f.messages.getById = (id) => {
    const message = get(id);
    return message ? { ...message, visibilitySeq: undefined } : null;
  };
  f.messages.canonicalizeCursor = (id) => id;
  await assert.rejects(
    watcherRawWindow(
      f.messages,
      'owner',
      'line',
      { revision: 1, afterSequence: 1, notes: '', consumedThrough: f.baseline.id },
      f.early.id,
      300,
    ),
    /watcher_publication_order_unavailable/,
  );
});
