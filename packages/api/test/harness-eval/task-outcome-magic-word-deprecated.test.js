import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import Fastify from 'fastify';

import { TaskOutcomeEpisodeStore } from '../../dist/infrastructure/harness-eval/task-outcome/task-outcome-store.js';
import { taskOutcomeRoutes } from '../../dist/routes/task-outcome.js';

/**
 * F227 归一 — POST /api/task-outcome/magic-word deprecation.
 *
 * Magic words are now the single-source-of-truth of Event Memory
 * (onMagicWordDetected → Event store). The old manual route must NOT be a second
 * truth-write path. This proves the route is deprecated (410) and produces NO
 * inline magic_word signal (砚砚 PR-1 acceptance #7).
 */
describe('POST /api/task-outcome/magic-word — F227 归一 deprecation', () => {
  let app;
  let store;

  beforeEach(async () => {
    store = new TaskOutcomeEpisodeStore(':memory:');
    app = Fastify();
    await app.register(taskOutcomeRoutes, { store });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it('returns 410 deprecated and writes NO inline magic_word signal', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/task-outcome/magic-word',
      payload: { word: '脚手架', catId: 'opus', threadId: 'thread_dep' },
    });
    assert.equal(res.statusCode, 410);
    assert.equal(res.json().error, 'deprecated');

    // Proof of "no inline truth": no episode was created, no signal written.
    assert.equal(store.getActiveEpisode('thread_dep'), null);
  });

  it('does not write a signal even when an active episode already exists', async () => {
    const ep = store.createEpisode({ trigger: 'cat_initiated', threadId: 'thread_dep2', participants: ['opus'] });
    const res = await app.inject({
      method: 'POST',
      url: '/api/task-outcome/magic-word',
      payload: { word: '绕路了', catId: 'opus', threadId: 'thread_dep2' },
    });
    assert.equal(res.statusCode, 410);
    // The pre-existing episode must remain signal-free (route wrote nothing).
    assert.equal(store.getSignals(ep.episodeId).length, 0);
  });
});
