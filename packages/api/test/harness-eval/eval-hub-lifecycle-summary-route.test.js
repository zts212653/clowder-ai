import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import { buildCapabilityWakeupClosureImport } from '../../dist/infrastructure/harness-eval/capability-wakeup-closure-import.js';
import { evalHubRoutes } from '../../dist/routes/eval-hub.js';

const harnessFeedbackRoot = fileURLToPath(new URL('../../../../docs/harness-feedback', import.meta.url));
const historical = buildCapabilityWakeupClosureImport();

async function buildApp(lifecycleEventLog) {
  const app = Fastify({ logger: false });
  app.addHook('preHandler', async (request) => {
    request.sessionUserId = 'owner-user';
  });
  await app.register(evalHubRoutes, {
    harnessFeedbackRoot,
    ...(lifecycleEventLog ? { lifecycleEventLog } : {}),
  });
  return app;
}

async function historicalItem(app) {
  const response = await app.inject({ method: 'GET', url: '/api/eval-hub/summary' });
  assert.equal(response.statusCode, 200, response.body);
  const item = response.json().items.find((candidate) => candidate.id === historical.root.verdictId);
  assert.ok(item, 'historical capability-wakeup verdict must remain discoverable');
  return item;
}

describe('Eval Hub lifecycle summary route', () => {
  it('marks actionable lifecycle data unavailable when Redis/event reading is absent', async () => {
    const app = await buildApp();
    const item = await historicalItem(app);

    assert.equal(item.lifecycle.availability, 'unavailable');
    assert.equal(item.lifecycle.ownerResponseStatus, 'unavailable');
    await app.close();
  });

  it('enriches the same item from canonical replay at the async route boundary', async () => {
    const app = await buildApp({
      async read(verdictId) {
        return verdictId === historical.root.verdictId ? structuredClone(historical.bootstrapEvents) : [];
      },
    });
    const item = await historicalItem(app);

    assert.equal(item.lifecycle.availability, 'available');
    assert.equal(item.lifecycle.closureStatus, 'reeval_pending');
    assert.equal(item.lifecycle.actionRefs[0].value, '50ec90163');
    assert.equal(item.lifecycle.unavailableRefs.length, 2);
    await app.close();
  });
});
