import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import { ThreadStore } from '../dist/domains/cats/services/stores/ports/ThreadStore.js';
import { MemoryConciergeConfigStore } from '../dist/domains/concierge/ConciergeConfigStore.js';
import { ConciergeThreadService } from '../dist/domains/concierge/ConciergeThreadService.js';
import { conciergeRoutes } from '../dist/routes/concierge.js';

test('application assist is independently off in the original owner settings', async () => {
  const store = new MemoryConciergeConfigStore();
  const saved = await store.getSaved('fixture-owner');
  assert.equal(saved.behaviorEnabled, true);
  assert.equal(saved.appAssistEnabled, false);
});

test('the production settings route saves and reads the independent opt-in without changing media identity', async (t) => {
  const store = new MemoryConciergeConfigStore();
  const app = Fastify();
  t.after(() => app.close());
  const threadService = new ConciergeThreadService({ threadStore: new ThreadStore(), conciergeConfigStore: store });
  await app.register(conciergeRoutes, { conciergeConfigStore: store, conciergeThreadService: threadService });
  const original = await store.getSaved('fixture-owner');
  for (const enabled of [true, false]) {
    const response = await app.inject({
      method: 'PUT',
      url: '/api/concierge/config',
      headers: { 'x-cat-cafe-user': 'fixture-owner' },
      payload: { appAssistEnabled: enabled },
    });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json().config.appAssistEnabled, enabled);
    assert.equal(response.json().callStatus, 'unchanged');
    const saved = await store.getSaved('fixture-owner');
    assert.equal(saved.appAssistEnabled, enabled);
    assert.equal(saved.dutyCatProfileId, original.dutyCatProfileId);
    assert.equal(saved.householdReadsAllowed, original.householdReadsAllowed);
  }
  assert.equal((await store.getSaved('fixture-other-owner')).appAssistEnabled, false);
  const invalid = await app.inject({
    method: 'PUT',
    url: '/api/concierge/config',
    headers: { 'x-cat-cafe-user': 'fixture-owner' },
    payload: { appAssistEnabled: 'true' },
  });
  assert.equal(invalid.statusCode, 400);
});
