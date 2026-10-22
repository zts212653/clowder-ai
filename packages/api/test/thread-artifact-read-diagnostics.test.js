import assert from 'node:assert/strict';
import { test } from 'node:test';

const { observeThreadArtifactRead } = await import(
  '../dist/domains/cats/services/agents/routing/thread-artifact-read-diagnostics.js'
);

test('slow artifact diagnostics attribute actual stages without payloads and preserve failures', async (t) => {
  let clock = 0;
  t.mock.method(performance, 'now', () => clock);
  const entries = [];
  const logger = { info: (entry, message) => entries.push({ entry, message }) };
  const canary = { content: 'private-payload-canary', sourceMessageId: 'private-coordinate-canary' };
  assert.equal(
    await observeThreadArtifactRead(logger, async (measure) => {
      return measure('messages', () => {
        clock += 10;
        return canary;
      });
    }),
    canary,
  );
  assert.deepEqual(entries, [], 'fast reads emit no diagnostic');
  const result = await observeThreadArtifactRead(logger, async (measure) => {
    await measure('messages', async () => {
      clock += 20;
    });
    return measure('liveFiles', async () => {
      clock += 1200;
      return canary;
    });
  });
  assert.equal(result, canary);
  assert.deepEqual(entries[0].entry, {
    handlerElapsedMs: 1220,
    stages: { messages: 20, liveFiles: 1200 },
    status: 'success',
  });
  const failure = new Error('private-failure-canary');
  await assert.rejects(
    observeThreadArtifactRead(logger, async (measure) => {
      return measure('lineage', () => {
        clock += 2000;
        throw failure;
      });
    }),
    (error) => error === failure,
  );
  assert.deepEqual(entries[1].entry, { handlerElapsedMs: 2000, stages: { lineage: 2000 }, status: 'failed' });
  assert.ok(!JSON.stringify(entries).includes('canary'));
  assert.equal(
    await observeThreadArtifactRead(
      {
        info() {
          throw failure;
        },
      },
      async (measure) => {
        return measure('tasks', () => {
          clock += 1500;
          return canary;
        });
      },
    ),
    canary,
    'logging failure does not change an otherwise successful read',
  );
});
