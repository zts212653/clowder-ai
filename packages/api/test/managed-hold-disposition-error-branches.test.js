/**
 * F167 PR-A — a fail-closed managed-hold disposition error says which branch it fell on.
 *
 * `managed_hold_disposition_replay_mismatch` is thrown at three places in the service, and the caller used to get
 * the same bare code from all of them:
 *   1. a terminal exists for this wake but its identity (cat, source, task, a valid disposition) does not match;
 *   2. the SAME invocation already recorded this wake with a different disposition;
 *   3. after the write, the terminal could not be read back (or read back as something else).
 * Each now carries the branch and, where one exists, the stored terminal (disposition, invocationId, at). The
 * guard is unchanged and still fails closed.
 *
 * These call the two assertion steps directly: they are pure over (event, auth, ids), and the full service
 * harness would add nothing to what they decide.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { buildHoldDispositionEvent } from '../dist/domains/ball-custody/ball-custody-events.js';
import {
  ManagedHoldDispositionError,
  ManagedHoldDispositionService,
} from '../dist/domains/ball-custody/ManagedHoldDispositionService.js';

const REPLAY_MISMATCH = 'managed_hold_disposition_replay_mismatch';
const auth = { invocationId: 'inv-1', catId: 'codex-sol', threadId: 'thread-1', userId: 'user-1' };

function terminal(overrides = {}) {
  return buildHoldDispositionEvent({
    threadId: 'thread-1',
    catId: 'codex-sol',
    invocationId: 'inv-1',
    sourceMessageId: 'wake-message',
    taskId: 'task-1',
    disposition: 'completed',
    at: 4_000,
    ...overrides,
  });
}

function service() {
  return new ManagedHoldDispositionService({});
}

function thrown(run) {
  try {
    run();
  } catch (error) {
    return error;
  }
  return assert.fail('expected the assertion to throw');
}

describe('F167 managed hold replay_mismatch names the branch and the stored terminal', () => {
  test('the same invocation recorded this wake as `completed`; asking for `handled` is refused and says so', () => {
    const error = thrown(() =>
      service().assertReplayableTerminal(terminal(), auth, 'wake-message', 'task-1', 'handled'),
    );

    assert.ok(error instanceof ManagedHoldDispositionError);
    assert.equal(error.code, REPLAY_MISMATCH);
    assert.equal(error.branch, 'existing_terminal');
    assert.deepEqual(error.existingTerminal, { disposition: 'completed', invocationId: 'inv-1', at: 4_000 });
  });

  test('a SUCCESSOR invocation is still not refused for choosing the other value (the recorded terminal stays authoritative)', () => {
    const canonical = service().assertReplayableTerminal(
      terminal({ invocationId: 'earlier-invocation' }),
      auth,
      'wake-message',
      'task-1',
      'handled',
    );
    assert.equal(canonical, 'completed');
  });

  test('a terminal for another task or cat is a different branch, and still reports what is stored', () => {
    for (const other of [{ taskId: 'task-2' }, { sourceMessageId: 'another-wake' }, { catId: 'opus' }]) {
      const error = thrown(() =>
        service().assertReplayableTerminal(terminal(other), auth, 'wake-message', 'task-1', 'completed'),
      );
      assert.equal(error.code, REPLAY_MISMATCH);
      assert.equal(error.branch, 'existing_terminal_other_identity', JSON.stringify(other));
      assert.deepEqual(error.existingTerminal, { disposition: 'completed', invocationId: 'inv-1', at: 4_000 });
    }
  });

  test('nothing readable after the write does NOT claim a terminal exists', () => {
    const error = thrown(() =>
      service().assertMatchingDispositionEvent(undefined, auth, 'wake-message', 'task-1', 'handled'),
    );
    assert.equal(error.code, REPLAY_MISMATCH);
    assert.equal(error.branch, 'read_back_missing');
    assert.equal(error.existingTerminal, undefined);
  });

  test('after the write a DIFFERENT disposition read back is the existing-terminal branch (a concurrent winner)', () => {
    const error = thrown(() =>
      service().assertMatchingDispositionEvent(
        terminal({ disposition: 'completed' }),
        auth,
        'wake-message',
        'task-1',
        'handled',
      ),
    );
    assert.equal(error.code, REPLAY_MISMATCH);
    assert.equal(error.branch, 'existing_terminal');
    assert.deepEqual(error.existingTerminal, { disposition: 'completed', invocationId: 'inv-1', at: 4_000 });
  });

  test('a matching terminal passes untouched', () => {
    service().assertMatchingDispositionEvent(
      terminal({ disposition: 'handled' }),
      auth,
      'wake-message',
      'task-1',
      'handled',
    );
  });
});
