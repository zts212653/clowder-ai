import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import Fastify from 'fastify';
import { F292ApprovalAdapter } from '../../dist/domains/approval-hub/adapters/F292ApprovalAdapter.js';
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
  let presentationRetries;
  let resolveArtifact;

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
    resolveArtifact = async () => ({ contentType: 'text/plain', text: 'Transcript' });
    const resolvers = new SourceResolverRegistry();
    resolvers.register({
      adapterId: 'route-test',
      supports: () => true,
      resolve: (...args) => resolveArtifact(...args),
    });
    const sources = new SourceAccessLeaseService({
      intakes: admission.intakes,
      leases: new MemorySourceAccessLeaseStore(),
      resolvers,
      now: () => 12_000,
    });
    deliveries = [];
    presentationRetries = [];
    registerMeetingIntakeRoutes(app, {
      store: admission.intakes,
      service,
      actions: new MeetingIntakeActionService({
        store: admission.intakes,
        meeting: service,
        sources,
        dispatcher: {
          deliver: async (input) => deliveries.push(input),
          retryPresentation: async (input) => {
            presentationRetries.push(input);
            return {
              sourceMessageId: 'meeting-message-1',
              triggerMessageId: 'retry-message-1',
              queueEntryId: 'retry-queue-1',
              opportunityId: `write_opp_${'a'.repeat(32)}`,
              targetCatId: 'codex-sol',
              deduped: false,
            };
          },
        },
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
    const regrant = await app.inject({
      method: 'POST',
      url: '/api/meeting-intakes/intake-1/regrant',
      headers: { 'x-test-session-user': 'owner-1' },
      payload: { expectedRevision: 2 },
    });
    assert.equal(regrant.statusCode, 200);
    assert.deepEqual(regrant.json().regrant, {
      kind: 'official_plugin_auth',
      catalogId: 'feishu-meeting-intake',
      settingsHref: '/settings?s=plugins',
      nextAction: 'retry',
    });
    assert.equal('argv' in regrant.json().regrant, false);
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

  it('dismisses a confirmed failed intake as terminal truth without delivery or repeat pending projection', async () => {
    const current = await admission.intakes.get('intake-1');
    const choices = {
      speakerMap: { 1: 'You' },
      context: 'Saved context',
      destinationHandle: 'host:private-thread:thread-1',
      outputs: ['minutes'],
    };
    const failed = await admission.intakes.compareAndSet('intake-1', current.revision, {
      ...current,
      judgmentState: 'confirmed',
      executionState: 'failed',
      healthState: 'degraded',
      unresolved: [],
      choices,
      repair: { code: 'route_unavailable', action: 'retry', observedAt: 12_000 },
      revision: current.revision + 1,
      updatedAt: 12_000,
    });
    assert.equal(failed.outcome, 'written');

    const dismissed = await app.inject({
      method: 'POST',
      url: '/api/meeting-intakes/intake-1/dismiss',
      headers: { 'x-test-session-user': 'owner-1' },
      payload: { expectedRevision: failed.intake.revision },
    });

    assert.equal(dismissed.statusCode, 200);
    assert.equal(dismissed.json().intake.judgmentState, 'dismissed');
    assert.equal(dismissed.json().intake.executionState, 'idle');
    assert.equal(dismissed.json().intake.healthState, 'healthy');
    assert.equal(dismissed.json().intake.repair, undefined);
    assert.deepEqual(dismissed.json().intake.choices, choices);
    assert.equal(deliveries.length, 0);

    const adapter = new F292ApprovalAdapter(admission.intakes);
    assert.deepEqual(await adapter.listPending('owner-1'), []);
    assert.equal((await adapter.listSettled('owner-1'))[0].status, 'rejected');

    const replay = await app.inject({
      method: 'POST',
      url: '/api/meeting-intakes/intake-1/dismiss',
      headers: { 'x-test-session-user': 'owner-1' },
      payload: { expectedRevision: dismissed.json().intake.revision },
    });
    assert.equal(replay.statusCode, 400);
    assert.equal(deliveries.length, 0);
  });

  it('retries the same confirmed intake after Feishu authorization is restored', async () => {
    let authorized = false;
    resolveArtifact = async () => {
      if (!authorized) {
        throw Object.assign(new Error('owner authorization expired'), { code: 'SOURCE_AUTH_REQUIRED' });
      }
      return { contentType: 'text/plain', text: 'Transcript' };
    };

    const degraded = await app.inject({
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
    assert.equal(degraded.statusCode, 200);
    assert.equal(degraded.json().intake.intakeId, 'intake-1');
    assert.equal(degraded.json().intake.repair.action, 'regrant');
    assert.equal(deliveries.length, 0);

    const stillDegraded = await app.inject({
      method: 'POST',
      url: '/api/meeting-intakes/intake-1/retry',
      headers: { 'x-test-session-user': 'owner-1' },
      payload: { expectedRevision: degraded.json().intake.revision },
    });
    assert.equal(stillDegraded.statusCode, 200);
    assert.equal(stillDegraded.json().intake.intakeId, 'intake-1');
    assert.equal(stillDegraded.json().intake.repair.action, 'regrant');
    assert.equal(deliveries.length, 0);

    authorized = true;
    const recovered = await app.inject({
      method: 'POST',
      url: '/api/meeting-intakes/intake-1/retry',
      headers: { 'x-test-session-user': 'owner-1' },
      payload: { expectedRevision: stillDegraded.json().intake.revision },
    });
    assert.equal(recovered.statusCode, 200);
    assert.equal(recovered.json().intake.intakeId, 'intake-1');
    assert.equal(recovered.json().intake.executionState, 'succeeded');
    assert.equal(recovered.json().intake.repair, undefined);
    assert.equal(deliveries.length, 1);
  });

  it('re-presents a succeeded intake without re-reading the source or mutating intake truth', async () => {
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
    const revision = confirmed.json().intake.revision;
    const sourceReadsBefore = deliveries.length;

    const retried = await app.inject({
      method: 'POST',
      url: '/api/meeting-intakes/intake-1/presentation-retry',
      headers: { 'x-test-session-user': 'owner-1' },
      payload: { expectedRevision: revision, clientRequestId: 'acceptance-attempt-1' },
    });

    assert.equal(retried.statusCode, 200);
    assert.equal(retried.json().intake.revision, revision);
    assert.equal(retried.json().presentationRetry.triggerMessageId, 'retry-message-1');
    assert.equal(presentationRetries.length, 1);
    assert.equal(presentationRetries[0].clientRequestId, 'acceptance-attempt-1');
    assert.equal(deliveries.length, sourceReadsBefore);
    assert.equal((await admission.intakes.get('intake-1')).revision, revision);

    const stale = await app.inject({
      method: 'POST',
      url: '/api/meeting-intakes/intake-1/presentation-retry',
      headers: { 'x-test-session-user': 'owner-1' },
      payload: { expectedRevision: revision - 1, clientRequestId: 'acceptance-attempt-2' },
    });
    assert.equal(stale.statusCode, 409);
    assert.equal(presentationRetries.length, 1);
  });

  it('rejects presentation retry for a foreign owner, stale revision, or unfinished intake', async () => {
    const foreign = await app.inject({
      method: 'POST',
      url: '/api/meeting-intakes/intake-1/presentation-retry',
      headers: { 'x-test-session-user': 'other-owner' },
      payload: { expectedRevision: 1, clientRequestId: 'attempt-1' },
    });
    assert.equal(foreign.statusCode, 404);

    const unfinished = await app.inject({
      method: 'POST',
      url: '/api/meeting-intakes/intake-1/presentation-retry',
      headers: { 'x-test-session-user': 'owner-1' },
      payload: { expectedRevision: 1, clientRequestId: 'attempt-1' },
    });
    assert.equal(unfinished.statusCode, 400);

    const malformed = await app.inject({
      method: 'POST',
      url: '/api/meeting-intakes/intake-1/presentation-retry',
      headers: { 'x-test-session-user': 'owner-1' },
      payload: { expectedRevision: 1, clientRequestId: '' },
    });
    assert.equal(malformed.statusCode, 400);
    const unsafeRequestId = await app.inject({
      method: 'POST',
      url: '/api/meeting-intakes/intake-1/presentation-retry',
      headers: { 'x-test-session-user': 'owner-1' },
      payload: { expectedRevision: 1, clientRequestId: 'attempt\n2' },
    });
    assert.equal(unsafeRequestId.statusCode, 400);
    for (const clientRequestId of [42, { value: 'attempt-2' }]) {
      const wrongTypeRequestId = await app.inject({
        method: 'POST',
        url: '/api/meeting-intakes/intake-1/presentation-retry',
        headers: { 'x-test-session-user': 'owner-1' },
        payload: { expectedRevision: 1, clientRequestId },
      });
      assert.equal(wrongTypeRequestId.statusCode, 400);
    }
    assert.equal(presentationRetries.length, 0);
  });

  it('keeps manual recovery reference-only and normalizes it onto the Feishu source adapter', async () => {
    resolveArtifact = async () => {
      throw Object.assign(new Error('source deleted'), { code: 'SOURCE_DELETED' });
    };
    const failed = await app.inject({
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
    assert.equal(failed.json().intake.repair.action, 'manual_import');

    const inlineBody = await app.inject({
      method: 'POST',
      url: '/api/meeting-intakes/intake-1/manual-import',
      headers: { 'x-test-session-user': 'owner-1' },
      payload: { expectedRevision: failed.json().intake.revision, transcript: 'must not cross this boundary' },
    });
    assert.equal(inlineBody.statusCode, 400);

    resolveArtifact = async () => ({ contentType: 'text/plain', text: 'Source-owned transcript' });
    const recovered = await app.inject({
      method: 'POST',
      url: '/api/meeting-intakes/intake-1/manual-import',
      headers: { 'x-test-session-user': 'owner-1' },
      payload: {
        expectedRevision: failed.json().intake.revision,
        reference: 'https://example.feishu.cn/minutes/obcn-manual',
      },
    });
    assert.equal(recovered.statusCode, 200);
    assert.equal(recovered.json().intake.executionState, 'succeeded');
    assert.equal(deliveries[0].artifact.sourceHandle, 'feishu://meeting-artifacts/minute/obcn-manual?revision=latest');
    assert.equal('text' in deliveries[0].artifact, false);
  });
});
