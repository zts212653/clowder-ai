import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  AgentKeySidecarRenewalLoop,
  reconcileSidecarsIndependently,
} from '../src/domains/cats/services/agents/agent-key/AgentKeySidecarRenewalLoop.js';

describe('AgentKeySidecarRenewalLoop', () => {
  it('coalesces overlapping renewal ticks into one reconciliation', async () => {
    let release!: () => void;
    let calls = 0;
    const blocker = new Promise<void>((resolve) => {
      release = resolve;
    });
    const loop = new AgentKeySidecarRenewalLoop({
      reconcile: async () => {
        calls += 1;
        await blocker;
      },
      onError: () => assert.fail('unexpected renewal failure'),
    });

    const first = loop.runOnce();
    const second = loop.runOnce();
    await Promise.resolve();
    assert.equal(calls, 1);
    release();
    await Promise.all([first, second]);
    assert.equal(calls, 1);
  });

  it('reports a failed tick and remains able to renew later', async () => {
    const errors: unknown[] = [];
    let calls = 0;
    const loop = new AgentKeySidecarRenewalLoop({
      reconcile: async () => {
        calls += 1;
        if (calls === 1) throw new Error('redis unavailable');
      },
      onError: (error) => errors.push(error),
    });

    await loop.runOnce();
    await loop.runOnce();

    assert.equal(calls, 2);
    assert.equal(errors.length, 1);
    assert.match(String(errors[0]), /redis unavailable/);
  });

  it('waits for an in-flight reconciliation during shutdown', async () => {
    let release!: () => void;
    const blocker = new Promise<void>((resolve) => {
      release = resolve;
    });
    const loop = new AgentKeySidecarRenewalLoop({
      reconcile: async () => blocker,
      onError: () => assert.fail('unexpected renewal failure'),
    });

    void loop.runOnce();
    let stopped = false;
    const stop = loop.stop().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    assert.equal(stopped, false);
    release();
    await stop;
    assert.equal(stopped, true);
  });

  it('attempts gpt-pro renewal even when Antigravity renewal fails', async () => {
    const attempted: string[] = [];

    await assert.rejects(
      reconcileSidecarsIndependently([
        {
          name: 'antigravity',
          reconcile: async () => {
            attempted.push('antigravity');
            throw new Error('antigravity sidecar unavailable');
          },
        },
        {
          name: 'gpt-pro',
          reconcile: async () => {
            attempted.push('gpt-pro');
          },
        },
      ]),
      /antigravity/,
    );

    assert.deepEqual(attempted, ['antigravity', 'gpt-pro']);
  });
});
