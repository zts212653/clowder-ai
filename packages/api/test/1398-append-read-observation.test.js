import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isLifecycleStoredMessageMetadata as valid } from '../../shared/dist/types/message-lifecycle.js';
import { advanceLifecycleInputDispatchMetadata as advance } from '../dist/domains/cats/services/stores/ports/MessageStore.js';

const patch = {
  orderKey: '1:input',
  targetId: 'opus',
  statusMessageId: 'response-1',
  phase: 'dispatched',
  dispatchedAt: 10,
};
const admitted = () => advance(undefined, { ...patch, inputRead: { status: 'pending' } }).lifecycle;
test('absent optional delivery time stays absent through replay and settlement', () => {
  const { dispatchedAt, ...withoutTime } = patch;
  const initial = advance(undefined, withoutTime).lifecycle;
  const settled = advance(initial, { ...withoutTime, phase: 'settled' }).lifecycle;
  assert.equal(Object.hasOwn(settled.dispatchRefs[0], 'dispatchedAt'), false);
  assert.equal(advance(initial, withoutTime).kind, 'replayed');
});
test('optional read feedback persists without changing delivery identity or phase', () => {
  const initial = admitted();
  assert.deepEqual(initial.dispatchRefs[0].inputRead, { status: 'pending' });
  const confirmed = advance(initial, { ...patch, inputRead: { status: 'read', at: 12 } });
  assert.equal(confirmed.kind, 'applied');
  assert.equal(confirmed.lifecycle.dispatchRefs[0].phase, 'dispatched');
  const settled = advance(confirmed.lifecycle, { ...patch, phase: 'settled' });
  assert.deepEqual(settled.lifecycle.dispatchRefs[0].inputRead, { status: 'read', at: 12 });
  assert.equal(
    advance(settled.lifecycle, { ...patch, phase: 'settled', inputRead: { status: 'pending' } }).kind,
    'replayed',
  );
  assert.equal(valid(settled.lifecycle), true);
});
test('late proof updates only the original exact target, including after terminal settlement', () => {
  const sibling = advance(admitted(), { ...patch, targetId: 'kimi', statusMessageId: 'response-2' }).lifecycle;
  const done = advance(sibling, { ...patch, phase: 'settled' }).lifecycle;
  assert.equal(
    advance(done, {
      ...patch,
      phase: 'settled',
      statusMessageId: 'other-response',
      inputRead: { status: 'read', at: 12 },
    }).kind,
    'conflict',
  );
  const read = advance(done, { ...patch, phase: 'settled', inputRead: { status: 'read', at: 12 } }).lifecycle;
  assert.equal(read.dispatchRefs[0].phase, 'settled');
  assert.deepEqual(read.dispatchRefs[0].inputRead, { status: 'read', at: 12 });
  assert.equal(read.dispatchRefs[1].inputRead, undefined);
});
test('read evidence is validated, monotonic and cannot precede admission', () => {
  const initial = admitted();
  assert.equal(advance(initial, { ...patch, inputRead: { status: 'read', at: 9 } }).kind, 'conflict');
  assert.equal(
    valid({ ...initial, dispatchRefs: [{ ...initial.dispatchRefs[0], inputRead: { status: 'read', at: -1 } }] }),
    false,
  );
  assert.equal(
    valid({ ...initial, dispatchRefs: [{ ...initial.dispatchRefs[0], inputRead: { status: 'invented' } }] }),
    false,
  );
});
