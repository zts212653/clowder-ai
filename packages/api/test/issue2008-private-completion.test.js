import assert from 'node:assert/strict';
import { test } from 'node:test';
import { generateScriptViaThread } from '../dist/domains/signals/services/podcast-generator.js';
import { stopFixture, waitFor } from './helpers/stop-private-fixture.js';

test('#2008 a private retirement failure completes the real podcast request', async (t) => {
  const h = await stopFixture(t, { idle: true, retryDeferral: { baseDelayMs: 20 } });
  h.processor.deps.router.resolveExplicitTargets = async () => [];
  const commit = h.ledger.commit.bind(h.ledger);
  let injected = 0;
  let retirementAttempts = 0;
  h.ledger.commit = async (...args) => {
    if (args[3] === 'withdrawn') {
      retirementAttempts += 1;
      if (injected === 0) {
        injected += 1;
        throw new Error('owned transient private retirement failure');
      }
    }
    return commit(...args);
  };
  const drain = h.processor.requestDrain.bind(h.processor);
  let drains = 0;
  let completedDrains = 0;
  h.processor.requestDrain = (...args) => {
    drains += 1;
    return drain(...args).finally(() => {
      completedDrains += 1;
    });
  };
  let outcome = { status: 'pending' };
  const generation = generateScriptViaThread(
    {
      articleId: 'fixture-article',
      articleFilePath: 'unused-fixture.md',
      articleTitle: 'Fixture article',
      articleContent: 'Fixture input',
      mode: 'essence',
      requestedBy: 'owner',
    },
    'thread',
    { invocationQueue: h.queue, queueProcessor: h.processor },
  ).then(
    () => {
      outcome = { status: 'resolved' };
    },
    (error) => {
      outcome = { status: 'rejected', message: error.message };
    },
  );
  // The old catch's actual retry must run before a pending result can fail this check.
  await waitFor(() => outcome.status !== 'pending' || completedDrains >= 2);
  const [entry] = h.queue.listPendingAcrossUsers('thread');
  t.diagnostic(
    JSON.stringify({ outcome, injected, retirementAttempts, drains, completedDrains, entryStatus: entry?.status }),
  );
  assert.equal(injected, 1, 'the fault reaches real private-input durable retirement');
  assert.equal(outcome.status, 'rejected', 'the caller must not wait on an orphaned completion hook');
  assert.equal(outcome.message, 'owned transient private retirement failure');
  await generation;
});
