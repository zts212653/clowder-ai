import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { transitionOperationState } from '../dist/domains/plugin/operations/operation-state-machine.js';

const actions = [
  { id: 'generate', next: 'status' },
  { id: 'status', rollback: 'generate', timeout: 30 },
];

describe('plugin operation state machine', () => {
  it('retains the reset cursor and cleared targets without persisting disconnect feedback', () => {
    const transition = transitionOperationState({
      actions: [
        { id: 'start', next: 'poll' },
        { id: 'poll', next: 'disconnect' },
        { id: 'disconnect', next: 'start' },
      ],
      actionId: 'disconnect',
      targetKeys: ['token'],
      result: { render: 'status', data: { status: 'disconnected' }, label: '已断开', targetValues: { token: '' } },
      now: 42,
    });
    assert.deepEqual(transition.state, { currentAction: 'start', updatedAt: 42 });
    assert.deepEqual(transition.targetValues, { token: '' });
  });

  it('retains an established connection result and a standalone status result', () => {
    for (const definitions of [
      [
        { id: 'start', next: 'poll' },
        { id: 'poll', next: 'disconnect' },
        { id: 'disconnect', next: 'start' },
      ],
      [{ id: 'poll' }],
    ]) {
      const result = { render: 'status', data: { status: 'connected' }, label: 'Connected' };
      const transition = transitionOperationState({ actions: definitions, actionId: 'poll', result, now: 42 });
      assert.deepEqual(transition.state.lastResult, result);
    }
  });

  it('advances, filters declared target values, and stamps a fresh state', () => {
    const transition = transitionOperationState({
      actions,
      actionId: 'generate',
      targetKeys: ['BOT_TOKEN'],
      result: {
        render: 'img',
        data: { url: 'data:image/png;base64,abc' },
        targetValues: { BOT_TOKEN: 'secret', IGNORED: 'nope' },
      },
      now: 20_000,
    });

    assert.deepEqual(transition, {
      state: {
        currentAction: 'status',
        lastResult: { render: 'img', data: { url: 'data:image/png;base64,abc' } },
        updatedAt: 20_000,
      },
      decision: { kind: 'next', actionId: 'status' },
      targetValues: { BOT_TOKEN: 'secret' },
      preserveUpdatedAt: false,
    });
  });

  it('keeps the first visual result while polling and preserves the timeout origin', () => {
    const transition = transitionOperationState({
      actions,
      actionId: 'status',
      currentState: {
        currentAction: 'status',
        lastResult: { render: 'img', data: { url: 'qr', phase: 'created' }, label: 'Scan' },
        updatedAt: 10_000,
      },
      result: { render: 'polling', data: { phase: 'waiting' }, advance: false },
      now: 15_000,
      enforceTimeout: false,
    });

    assert.deepEqual(transition.state, {
      currentAction: 'status',
      lastResult: { render: 'img', data: { url: 'qr', phase: 'waiting' }, label: 'Scan' },
      updatedAt: 10_000,
    });
    assert.deepEqual(transition.decision, { kind: 'stay', actionId: 'status' });
    assert.equal(transition.preserveUpdatedAt, true);
  });

  it('rolls an expired polling action back before applying its late result', () => {
    const transition = transitionOperationState({
      actions,
      actionId: 'status',
      currentState: { currentAction: 'status', updatedAt: 10_000 },
      result: { render: 'polling', data: { phase: 'late' }, advance: false },
      now: 40_001,
    });

    assert.deepEqual(transition, {
      state: { currentAction: 'generate', updatedAt: 40_001 },
      decision: { kind: 'rollback', actionId: 'generate' },
      targetValues: {},
      preserveUpdatedAt: false,
    });
  });
});
