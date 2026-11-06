import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseWatcherSessionState } from '@cat-cafe/shared';
import { InvocationRegistry } from '../dist/domains/cats/services/agents/invocation/InvocationRegistry.js';
import { watcherSessionChainKey } from '../dist/domains/cats/services/session/session-scope.js';
import { InMemoryTurnExecutionStore } from '../dist/domains/cats/services/stores/memory/InMemoryTurnExecutionStore.js';
import { SessionChainStore } from '../dist/domains/cats/services/stores/ports/SessionChainStore.js';
import {
  commitWatcherCheckpoint,
  finishWatcherPrune,
  recoverWatcherAttempt,
} from '../dist/domains/concierge/watcher/watcher-checkpoint.js';

function fixture() {
  const sessions = new SessionChainStore();
  const session = sessions.create({
    userId: 'owner',
    catId: 'codex',
    threadId: 'line',
    sessionPurpose: 'watcher',
    chainKey: watcherSessionChainKey('owner', 'codex', 'line'),
    cliSessionId: 'native-same',
  });
  const executions = new InMemoryTurnExecutionStore();
  executions.createRunning({
    invocationId: 'watch-1',
    parentInvocationId: 'parent-1',
    userId: 'owner',
    catId: 'codex',
    threadId: 'line',
    executionKind: 'watcher',
    outputFence: 'open',
    startedAt: 100,
  });
  const attempt = {
    invocationId: 'watch-1',
    sourceInvocationId: 'work-1',
    sourceSequence: 10,
    nativeTurnId: 'turn-1',
    startedAt: 100,
    phase: 'running',
    window: { frontier: 'message-1', offset: 0, messageIds: ['message-1'] },
  };
  sessions.compareAndSetWatcherState(session.id, 0, { revision: 1, afterSequence: 5, notes: 'prior-note', attempt });
  const checkpoint = { v: 1, notes: 'saved-after-six-tools', consumedThrough: 'message-1:0', outcome: 'remembered' };
  const calls = [];
  let pruned = false;
  const client = {
    async request(method) {
      calls.push(method);
      if (method === 'thread/revert') {
        pruned = true;
        return {};
      }
      return {
        thread: {
          id: 'native-same',
          turns: pruned
            ? []
            : [
                {
                  id: 'turn-1',
                  status: 'completed',
                  items: [{ type: 'agentMessage', phase: 'final', text: JSON.stringify(checkpoint) }],
                },
              ],
        },
      };
    },
  };
  const owners = {
    sessions,
    executions,
    transcript: {
      async appendDurableEvent() {
        calls.push('transcript-durable');
      },
    },
  };
  return {
    session,
    owners,
    client,
    checkpoint,
    calls,
    state: () => parseWatcherSessionState(sessions.get(session.id).watcherState),
  };
}

test('six admitted tool calls still leave an independent durable checkpoint and a resumed native thread', async () => {
  const f = fixture();
  const registry = new InvocationRegistry();
  const auth = await registry.create('owner', 'codex', 'line', undefined, undefined, {
    mode: 'watcher',
    maxToolCalls: 6,
    allowedToolNames: ['cat_cafe_get_message'],
    allowedCallbackRoutes: [],
  });
  const calls = await Promise.all(
    Array.from({ length: 7 }, (_, index) =>
      registry.consumeWatcherToolCall(auth.invocationId, `tool-${index}`, 'cat_cafe_watcher_nudge'),
    ),
  );
  assert.equal(calls.filter((result) => result === 'accepted').length, 6);
  assert.equal(calls[6], 'exhausted');
  await commitWatcherCheckpoint(f.owners, f.session, f.state(), f.client, { reportedAt: 1000, prefixTokens: 12000 });
  assert.equal(f.state().notes, 'saved-after-six-tools');
  assert.equal(f.state().afterSequence, 10);
  assert.equal(f.state().attempt.phase, 'finalize_pending', 'the caller must still settle the execution and auth');
  assert.ok(f.calls.indexOf('transcript-durable') < f.calls.indexOf('thread/revert'));
});

test('checkpoint persistence failure advances neither the increment cursor nor native history', async () => {
  const f = fixture();
  f.owners.sessions.compareAndSetWatcherState = () => {
    throw new Error('disk unavailable');
  };
  await assert.rejects(
    commitWatcherCheckpoint(f.owners, f.session, f.state(), f.client, { reportedAt: 1000, prefixTokens: 12000 }),
    /disk unavailable/,
  );
  assert.equal(f.state().afterSequence, 5);
  assert.equal(f.state().notes, 'prior-note');
  assert.equal(f.calls.includes('thread/revert'), false);
});

test('a crash after native prune retains ownership of the wake until execution and auth settlement', async () => {
  const f = fixture();
  const state = f.state();
  await f.owners.sessions.compareAndSetWatcherState(f.session.id, state.revision, {
    ...state,
    revision: state.revision + 1,
    wakeInvocationId: state.attempt.invocationId,
  });
  await commitWatcherCheckpoint(f.owners, f.session, f.state(), f.client, { reportedAt: 1000 });
  assert.equal(f.owners.executions.get('watch-1').status, 'running', 'the caller finally has not run');
  assert.equal(f.state().afterSequence, 10, 'the source cursor already advanced');
  assert.ok(f.calls.includes('thread/revert'), 'the native history is already pruned');
  assert.equal(f.state().attempt?.invocationId, 'watch-1', 'the unfinalized wake must remain recoverable');
  assert.equal(f.state().attempt.phase, 'finalize_pending');
  assert.equal(f.state().wakeInvocationId, 'watch-1');
  const nativeCalls = f.calls.length;
  const recovered = await recoverWatcherAttempt(f.owners, f.session, f.state(), f.client);
  assert.equal(recovered.attempt.phase, 'finalize_pending');
  assert.equal(f.calls.length, nativeCalls, 'finalization never retries or re-reads the native turn');
});

test('recovery after checkpoint-before-prune and prune-before-ack never repeats a nudge or loses the notes', async () => {
  const f = fixture();
  const realRequest = f.client.request.bind(f.client);
  let crashed = true;
  f.client.request = async (method, args) => {
    if (method === 'thread/revert' && crashed) {
      crashed = false;
      await realRequest(method, args);
      throw new Error('worker killed after native prune');
    }
    return realRequest(method, args);
  };
  await assert.rejects(
    commitWatcherCheckpoint(f.owners, f.session, f.state(), f.client, { reportedAt: 1000, prefixTokens: 12000 }),
    /worker killed/,
  );
  assert.equal(f.state().attempt.phase, 'prune_pending');
  assert.equal(f.state().afterSequence, 10);
  await finishWatcherPrune(f.owners, f.session, f.state(), f.client);
  assert.equal(f.state().notes, 'saved-after-six-tools');
  assert.equal(f.state().attempt.phase, 'finalize_pending', 'recovering a prune still owes final settlement');
  assert.equal(f.calls.filter((method) => method === 'thread/revert').length, 1);
});

test('a model cannot acknowledge raw text outside its delivered window', async () => {
  const f = fixture();
  f.checkpoint.consumedThrough = 'unseen-message:0';
  await assert.rejects(
    commitWatcherCheckpoint(f.owners, f.session, f.state(), f.client, { reportedAt: 1000, prefixTokens: 12000 }),
    /window_or_notes_invalid/,
  );
  assert.equal(f.state().afterSequence, 5);
  assert.equal(f.calls.includes('thread/revert'), false);
});

test('a bounded partial raw window keeps the source event pending until its remaining original text is read', async () => {
  const f = fixture();
  const state = f.state();
  state.attempt.window.complete = false;
  state.attempt.window.offset = 100;
  f.checkpoint.consumedThrough = 'message-1:100';
  await f.owners.sessions.compareAndSetWatcherState(f.session.id, state.revision, {
    ...state,
    revision: state.revision + 1,
  });
  await commitWatcherCheckpoint(f.owners, f.session, f.state(), f.client, { reportedAt: 1000 });
  assert.equal(f.state().afterSequence, 5, 'the remaining raw delta must not be acknowledged away');
  assert.equal(f.state().messageOffset, 100);
  assert.equal(f.state().attempt, undefined);
});

test('an interrupted native turn is durably accounted for, pruned, and retried without acknowledging unread input', async () => {
  const f = fixture();
  const original = f.client.request;
  f.client.request = async (method, args) => {
    const result = await original(method, args);
    if (method === 'thread/read')
      result.thread.turns.forEach((turn) => {
        turn.status = 'interrupted';
        turn.items = [];
      });
    return result;
  };
  await recoverWatcherAttempt(f.owners, f.session, f.state(), f.client);
  assert.equal(f.state().afterSequence, 5);
  assert.equal(f.state().notes, 'prior-note');
  assert.equal(f.state().attempt.invocationId, 'watch-1', 'retry retains the exact auth and its cumulative budget');
  assert.equal(f.state().attempt.nativeTurnId, undefined);
  assert.ok(f.calls.indexOf('transcript-durable') < f.calls.indexOf('thread/revert'));
});

test('recovery never reverts a native turn which is still running', async () => {
  const f = fixture();
  const request = f.client.request;
  f.client.request = async (method, args) => {
    const result = await request(method, args);
    if (method === 'thread/read')
      result.thread.turns.forEach((turn) => {
        turn.status = 'running';
        turn.items = [];
      });
    return result;
  };
  await assert.rejects(recoverWatcherAttempt(f.owners, f.session, f.state(), f.client), /native_still_active/);
  assert.equal(f.calls.includes('thread/revert'), false);
  assert.equal(f.state().afterSequence, 5);
  assert.equal(f.state().attempt.invocationId, 'watch-1');
});

test('a late parallel reply restores the existing timeline cursor after the exact updated reply has been consumed', async () => {
  const f = fixture();
  const state = f.state();
  state.attempt.window.resumeCursor = { messageId: 'already-read-later-row', offset: 0 };
  await f.owners.sessions.compareAndSetWatcherState(f.session.id, state.revision, {
    ...state,
    revision: state.revision + 1,
  });
  await commitWatcherCheckpoint(f.owners, f.session, f.state(), f.client, { reportedAt: 1000 });
  assert.equal(f.state().consumedThrough, 'already-read-later-row');
  assert.equal(f.state().afterSequence, 10);
});
