import assert from 'node:assert/strict';
import { test } from 'node:test';
import { answer, input, result, runNative } from './helpers/agy-followup-fixture.js';

test('missing B input DONE cannot assign C read or success to B', async () => {
  const reads = [];
  const completions = [];
  const state = await runNative(async function* (s) {
    yield input(0);
    for (const id of ['B', 'C']) {
      const dispatch = await s.dispatcher.dispatch(
        {
          text: id,
          messageIds: [id],
          deliveryId: `delivery-${id}`,
          onInputRead: async () => {
            reads.push(id);
          },
          onInputCompleted: async (ok) => {
            completions.push([id, ok]);
          },
        },
        { expectedInvocationId: 'inv' },
      );
      assert.equal(dispatch.accepted, true);
    }
    yield answer(1, 'A done.', 10);
    yield result('A done.');
    yield input(2, 'ACTIVE');
    yield answer(3, 'B response without confirmed input.', 10);
    yield result('B response without confirmed input.', 2);
    yield input(4);
    yield answer(5, 'C done.', 10);
    yield result('C done.', 3);
  });
  assert.equal(state.messages.at(-1).errorCode, 'AGY_NATIVE_FAILED');
  assert.deepEqual(reads, [], 'a missing read confirmation closes the run before C can impersonate B');
  assert.deepEqual(completions, [
    ['B', false],
    ['C', false],
  ]);
});

test('B closes at the next verified input while a later C transport failure affects only C', async () => {
  const reads = [];
  const completions = [];
  const state = await runNative(async function* (s) {
    yield input(0);
    for (const id of ['B', 'C']) {
      assert.equal(
        (
          await s.dispatcher.dispatch(
            {
              text: id,
              messageIds: [id],
              deliveryId: `delivery-${id}`,
              onInputRead: async () => {
                reads.push(id);
              },
              onInputCompleted: async (ok) => {
                completions.push([id, ok]);
              },
            },
            { expectedInvocationId: 'inv' },
          )
        ).accepted,
        true,
      );
    }
    yield result('A done.');
    yield input(2);
    yield result('B done.', 2);
    assert.deepEqual(completions, []);
    yield input(4, 'ACTIVE');
    assert.deepEqual(completions, [['B', true]]);
    yield input(4);
    yield result('C done.', 3);
    assert.deepEqual(completions, [['B', true]]);
    yield { __cliError: true, message: 'transport failed after C', exitCode: 1, signal: null };
  });
  assert.equal(state.messages.at(-1).errorCode, 'AGY_NATIVE_FAILED');
  assert.deepEqual(reads, ['B', 'C']);
  assert.deepEqual(completions, [
    ['B', true],
    ['C', false],
  ]);
});

test('a failing completion observer is signed once without contradictory disposal compensation', async () => {
  const completed = [];
  const state = await runNative(async function* (s) {
    yield input(0);
    await s.dispatcher.dispatch(
      {
        text: 'B',
        messageIds: ['B'],
        deliveryId: 'delivery-B',
        onInputCompleted: async (ok) => {
          completed.push(ok);
          throw new Error('fixture completion observer failed');
        },
      },
      { expectedInvocationId: 'inv' },
    );
    yield result('A done.');
    yield input(2);
    yield result('B done.', 2);
  });
  assert.ok(state.messages.at(-1).errorCode);
  assert.deepEqual(completed, [true]);
});
