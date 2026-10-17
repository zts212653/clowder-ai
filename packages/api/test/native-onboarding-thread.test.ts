import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import Fastify from 'fastify';
import { ThreadStore } from '../src/domains/cats/services/stores/ports/ThreadStore.js';
import { threadsRoutes } from '../src/routes/threads.js';

test('a direct onboarding goal creates one ordinary conversation on repeated confirmation', async () => {
  const app = Fastify();
  const threadStore = new ThreadStore();
  await app.register(threadsRoutes, { threadStore });
  try {
    const request = {
      method: 'POST' as const,
      url: '/api/threads',
      headers: { 'x-cat-cafe-user': 'new-owner', 'x-cat-cafe-onboarding-journey': 'native-journey-1234' },
      payload: { title: '第一个小目标' },
    };
    const first = await app.inject(request);
    const retry = await app.inject(request);
    assert.equal(first.statusCode, 201, first.body);
    assert.equal(retry.json().id, first.json().id);
    assert.equal(first.json().bootcampState, undefined);
    assert.equal((await threadStore.list('new-owner')).length, 1);
  } finally {
    await app.close();
  }
});
