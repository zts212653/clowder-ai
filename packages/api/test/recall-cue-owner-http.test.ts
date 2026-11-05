import assert from 'node:assert/strict';
import { test } from 'node:test';
import cookie from '@fastify/cookie';
import Fastify from 'fastify';
import { MessageStore } from '../src/domains/cats/services/stores/ports/MessageStore.js';
import { ThreadStore } from '../src/domains/cats/services/stores/ports/ThreadStore.js';
import { eventMemoryRevision, type StoredEventMemoryLifecycle } from '../src/domains/memory/EventMemoryStore.js';
import { sessionAuthPlugin, sessionRoute } from '../src/infrastructure/session-auth.js';
import { memoryPageReadRoutes } from '../src/routes/memory-page-read.js';
import { recallMetricsRoutes } from '../src/routes/recall-metrics.js';
import { recallFixture } from './memory-recall-fixture.js';

test('both actual recall HTTP readers carry owner source links behind the existing signed browser session', async () => {
  const fixture = await recallFixture();
  const app = Fastify();
  try {
    const threads = new ThreadStore();
    const thread = { ...threads.create('owner', '原始对话'), id: 'own' };
    const threadStore = { get: async (id: string) => (id === 'own' ? thread : null), list: async () => [thread] };
    const messages = new MessageStore();
    const original = messages.append({
      from: { kind: 'user', userId: 'owner' },
      userId: 'owner',
      threadId: 'own',
      content: 'PRIVATE raw source body',
      timestamp: fixture.now - 2000,
    });
    messages.append({
      from: { kind: 'agent', catId: 'sonnet' },
      userId: 'owner',
      threadId: 'own',
      content: 'A bounded response',
      timestamp: fixture.now - 100,
      extra: { stream: { turnInvocationId: 'parent' } },
    });
    let event: StoredEventMemoryLifecycle | null = {
      eventId: 'evt_owner_http',
      ownerUserId: 'owner',
      threadId: 'own',
      messageId: original.id,
      type: 'scope_correction',
      trigger: 'human_brake',
      cat: 'sonnet',
      timestamp: 1,
      summary: '历史事件',
      cognitiveTransition: 'scope_correction',
      relatedHarness: ['F321'],
      confidence: 'high',
      status: 'active',
      updatedAt: 1,
    };
    const revision = eventMemoryRevision(event);
    fixture.invocation('parent');
    fixture.episodes.append({
      eventId: 'event-http',
      idempotencyKey: 'present-http',
      cueId: 'cue-http',
      opportunityId: 'original-opportunity-not-renewed',
      scope: { ownerUserId: 'owner', threadId: 'own', invocationId: 'parent' },
      consumerCatId: 'sonnet',
      resolverFamily: 'event',
      sourceAnchor: `event-memory:${event.eventId}`,
      sourceRevision: revision,
      axis: 'consumption',
      consumptionOutcome: 'presented',
      catalogVersion: 1,
      resolverVersion: 1,
      occurredAt: fixture.now - 1000,
    });
    const readers = {
      ...fixture.readers,
      threadStore,
      messageStore: messages,
      eventSources: { store: { getEvent: () => event }, sourceReaders: { threadStore, messageStore: messages } },
    };
    await app.register(cookie);
    await app.register(sessionAuthPlugin);
    await app.register(sessionRoute, { ownerUserId: 'owner' });
    await app.register(memoryPageReadRoutes, {
      ownerUserId: 'owner',
      catalog: { list: () => [] },
      stores: new Map(),
      evidenceDb: fixture.db,
      markerQueue: { list: async () => [] },
      recallSources: readers,
    });
    await app.register(recallMetricsRoutes, { evidenceDb: fixture.db, ...readers });
    await app.ready();
    const session = await app.inject({ url: '/api/session' });
    assert.equal(session.statusCode, 200);
    const rawCookie = session.headers['set-cookie'];
    assert.equal(typeof rawCookie, 'string');
    assert.ok(typeof rawCookie === 'string');
    const headers = { cookie: rawCookie.split(';', 1)[0] };
    const paths = ['/api/recall/events?threadId=own', '/api/memory/recall?source=push'];
    const expectedHref = `/thread/own?message=${encodeURIComponent(original.id)}`;
    for (const url of paths) {
      assert.equal((await app.inject({ url })).statusCode, 401);
      const response = await app.inject({ url, headers });
      assert.equal(response.statusCode, 200, response.body);
      const body = response.json();
      if (url.startsWith('/api/recall/events')) {
        assert.ok(body.sourceViews.some((view: { href: string }) => view.href === expectedHref));
      } else {
        assert.equal(body.records[0].event.results[0].href, expectedHref);
        assert.equal(body.records[0].event.cueStatus, 'presented_unreported');
      }
      assert.ok(!response.body.includes('PRIVATE'));
    }
    event = null;
    for (const url of paths) {
      const response = await app.inject({ url, headers });
      assert.equal(response.statusCode, 200);
      assert.ok(!response.body.includes(expectedHref), 'forgotten source cannot retain its request-local cached link');
    }
  } finally {
    await app.close();
    await fixture.close();
  }
});
