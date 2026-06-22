/**
 * F233 PR4 — Probe evaluator safety.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

function makeTask(probe) {
  return {
    id: 'task-1',
    threadId: 'thread-1',
    title: 'Probe target',
    why: 'Probe should only fetch public URLs',
    kind: 'work',
    status: 'blocked',
    createdBy: 'codex',
    ownerCatId: 'codex',
    userId: 'default-user',
    createdAt: 1,
    updatedAt: 1,
    probe,
    resolveMode: 'bounces_back',
  };
}

describe('DefaultBallCustodyProbeEvaluator', () => {
  it('rejects internal HTTP probes before server-side fetch', async () => {
    const { DefaultBallCustodyProbeEvaluator } = await import(
      '../dist/domains/ball-custody/BallCustodyProbeEvaluator.js'
    );
    let fetchCalls = 0;
    const evaluator = new DefaultBallCustodyProbeEvaluator({
      async fetch() {
        fetchCalls += 1;
        return { status: 200 };
      },
    });

    await assert.rejects(
      () =>
        evaluator.evaluate({
          task: makeTask({ kind: 'http_get', url: 'http://localhost:6399/ready' }),
        }),
      /internal\/private|URL blocked/,
    );
    assert.equal(fetchCalls, 0);
  });

  it('allows public HTTP probes', async () => {
    const { DefaultBallCustodyProbeEvaluator } = await import(
      '../dist/domains/ball-custody/BallCustodyProbeEvaluator.js'
    );
    let fetchCalls = 0;
    const evaluator = new DefaultBallCustodyProbeEvaluator({
      async fetch(url) {
        fetchCalls += 1;
        assert.equal(url, 'https://example.com/health');
        return { status: 204 };
      },
    });

    const result = await evaluator.evaluate({
      task: makeTask({ kind: 'http_get', url: 'https://example.com/health', expectStatus: 204 }),
    });

    assert.deepEqual(result, { satisfied: true, reason: 'http_status_204' });
    assert.equal(fetchCalls, 1);
  });
});
