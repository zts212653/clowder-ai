import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import Fastify from 'fastify';
import {
  MeetingIntakeActionService,
  MeetingIntakeService,
  MemoryDestinationAuthority,
  MemorySourceAccessLeaseStore,
  SourceAccessLeaseService,
  SourceResolverRegistry,
} from '../../dist/domains/signal-intake/index.js';
import { registerMeetingIntakeRoutes } from '../../dist/routes/meeting-intake-routes.js';
import { admissionHarness, publishInput } from './helpers.js';

describe('F292 meeting intake recovery routes', () => {
  let app;
  let admission;
  let deliveries;

  beforeEach(async () => {
    admission = await admissionHarness();
    await admission.service.publish(admission.binding, publishInput());
    app = Fastify();
    app.addHook('onRequest', async (request) => {
      const value = request.headers['x-test-session-user'];
      if (typeof value === 'string') request.sessionUserId = value;
    });
    const destinations = new MemoryDestinationAuthority();
    destinations.put({
      handle: 'host:private-thread:thread-1',
      kind: 'private-thread',
      targetId: 'thread-1',
      ownerId: 'owner-1',
    });
    const service = new MeetingIntakeService(admission.intakes, destinations, { now: () => 12_000 });
    const resolvers = new SourceResolverRegistry();
    resolvers.register({
      adapterId: 'route-test',
      supports: () => true,
      resolve: async () => ({ contentType: 'text/plain', text: 'Transcript' }),
    });
    const sources = new SourceAccessLeaseService({
      intakes: admission.intakes,
      leases: new MemorySourceAccessLeaseStore(),
      resolvers,
      now: () => 12_000,
    });
    deliveries = [];
    registerMeetingIntakeRoutes(app, {
      store: admission.intakes,
      service,
      actions: new MeetingIntakeActionService({
        store: admission.intakes,
        meeting: service,
        sources,
        dispatcher: { deliver: async (input) => deliveries.push(input) },
        now: () => 13_000,
      }),
    });
    await app.ready();
  });

  afterEach(async () => app.close());

  it('returns only the authenticated owner projection', async () => {
    const unauthorized = await app.inject({ method: 'GET', url: '/api/meeting-intakes' });
    assert.equal(unauthorized.statusCode, 401);
    const foreign = await app.inject({
      method: 'GET',
      url: '/api/meeting-intakes?attention=true',
      headers: { 'x-test-session-user': 'other-owner' },
    });
    assert.deepEqual(foreign.json(), { intakes: [] });
    const owned = await app.inject({
      method: 'GET',
      url: '/api/meeting-intakes?attention=true',
      headers: { 'x-test-session-user': 'owner-1' },
    });
    assert.equal(owned.json().intakes[0].intakeId, 'intake-1');
  });

  it('records and clears typed repair truth with exact revision fencing', async () => {
    const degraded = await app.inject({
      method: 'POST',
      url: '/api/meeting-intakes/intake-1/repair',
      headers: { 'x-test-session-user': 'owner-1' },
      payload: { expectedRevision: 1, code: 'auth_required', safeDetail: 'login expired' },
    });
    assert.equal(degraded.statusCode, 200);
    assert.equal(degraded.json().intake.repair.action, 'regrant');
    const stale = await app.inject({
      method: 'POST',
      url: '/api/meeting-intakes/intake-1/repair/clear',
      headers: { 'x-test-session-user': 'owner-1' },
      payload: { expectedRevision: 1 },
    });
    assert.equal(stale.statusCode, 409);
    const repaired = await app.inject({
      method: 'POST',
      url: '/api/meeting-intakes/intake-1/repair/clear',
      headers: { 'x-test-session-user': 'owner-1' },
      payload: { expectedRevision: 2 },
    });
    assert.equal(repaired.statusCode, 200);
    assert.equal(repaired.json().intake.healthState, 'healthy');
  });

  it('rejects unknown repair codes without mutating intake truth', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/meeting-intakes/intake-1/repair',
      headers: { 'x-test-session-user': 'owner-1' },
      payload: { expectedRevision: 1, code: 'credential_dump' },
    });
    assert.equal(response.statusCode, 400);
    assert.equal((await admission.intakes.get('intake-1')).revision, 1);
  });

  it('confirms complete choices and dispatches the source artifact with exact revision fencing', async () => {
    const confirmed = await app.inject({
      method: 'POST',
      url: '/api/meeting-intakes/intake-1/confirm',
      headers: { 'x-test-session-user': 'owner-1' },
      payload: {
        expectedRevision: 1,
        choices: {
          speakerMap: { 1: 'You' },
          context: 'Product review',
          destinationHandle: 'host:private-thread:thread-1',
          outputs: ['minutes'],
        },
      },
    });
    assert.equal(confirmed.statusCode, 200);
    assert.equal(confirmed.json().intake.executionState, 'succeeded');
    assert.equal(deliveries.length, 1);

    const replay = await app.inject({
      method: 'POST',
      url: '/api/meeting-intakes/intake-1/confirm',
      headers: { 'x-test-session-user': 'owner-1' },
      payload: {
        expectedRevision: 1,
        choices: {
          speakerMap: { 1: 'You' },
          context: 'Product review',
          destinationHandle: 'host:private-thread:thread-1',
          outputs: ['minutes'],
        },
      },
    });
    assert.equal(replay.statusCode, 409);
    assert.equal(deliveries.length, 1);
  });
});
