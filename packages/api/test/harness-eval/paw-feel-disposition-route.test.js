import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import Fastify from 'fastify';
import { PawFeelDutyConfigStoreError } from '../../dist/infrastructure/harness-eval/paw-feel-disposition/duty-config-store.js';
import { pawFeelDispositionRoutes } from '../../dist/routes/paw-feel-disposition.js';

const PAGE = {
  generatedAt: '2026-07-26T12:00:00.000Z',
  projectionStatus: 'available',
  items: [],
  bundles: [],
  bundleCounts: {
    total: 0,
    byBasis: { message: 0, turn_invocation: 0, legacy_invocation: 0, single_signal: 0 },
  },
  denominator: {
    reportOccurrences: 0,
    uniqueSourceMessages: 0,
    historicalBackfill: 0,
    postActivationIntake: 0,
    typedConfirmed: 0,
    ambiguousOrContaminated: 0,
    reviewBundles: 0,
    problemFamilies: { status: 'unavailable', reason: 'No authoritative grouping contract' },
  },
  counts: { total: 0, unseen: 0, inProgress: 0, routePending: 0, disposed: 0, overdue: 0 },
  responsibilityCounts: { unreviewed: 0, bound_in_repair: 0, signature_waiting: 0, blocked: 0, terminal: 0 },
  degraded: false,
};

function callbackRegistry() {
  return {
    async verify(invocationId, callbackToken) {
      if (invocationId !== 'inv-1' || callbackToken !== 'token-1') {
        return { ok: false, reason: 'unknown_invocation' };
      }
      return {
        ok: true,
        record: {
          invocationId,
          callbackToken,
          threadId: 'thread_eval_friction',
          userId: 'user-1',
          catId: 'opus',
        },
      };
    },
  };
}

async function createApp(overrides = {}) {
  const app = Fastify();
  app.decorateRequest('sessionUserId', undefined);
  app.addHook('preHandler', async (request) => {
    const value = request.headers['x-session-user'];
    if (typeof value === 'string') request.sessionUserId = value;
  });
  const readQueries = [];
  const triageCalls = [];
  const actionCalls = [];
  const bundleCalls = [];
  const captureCalls = [];
  const captureIntentCalls = [];
  const dutyCalls = [];
  const receiptCalls = [];
  const readModel = Object.hasOwn(overrides, 'readModel')
    ? overrides.readModel
    : {
        async list(query) {
          readQueries.push(query);
          return PAGE;
        },
      };
  const dispositionService = Object.hasOwn(overrides, 'dispositionService')
    ? overrides.dispositionService
    : {
        async executeMany(principal, commands) {
          triageCalls.push({ principal, commands });
          return commands.map((command) => ({
            outcome: 'appended',
            projection: { signalId: command.signalId, sequence: command.expectedSequence + 1 },
          }));
        },
        async executeBundle(principal, command, options) {
          bundleCalls.push({ principal, command, options });
          return {
            bundleKey: command.bundleKey,
            results: [],
            counts: { appended: 0, duplicate: 0, conflict: 0, rejected: 0 },
          };
        },
      };
  const captureService = Object.hasOwn(overrides, 'captureService')
    ? overrides.captureService
    : {
        async capture(principal, sourceMessageId) {
          captureCalls.push({ principal, sourceMessageId });
          return { sourceMessageId, discoveredSignals: 1, signalIds: ['signal-typed-1'] };
        },
      };
  const captureIntentSidecar = Object.hasOwn(overrides, 'captureIntentSidecar')
    ? overrides.captureIntentSidecar
    : {
        declare(principal) {
          captureIntentCalls.push(principal);
          return { kind: 'declared', invocationId: principal.invocationId, expiresAt: 1234 };
        },
      };
  const dutyConfigStore = Object.hasOwn(overrides, 'dutyConfigStore')
    ? overrides.dutyConfigStore
    : {
        async read() {
          return null;
        },
        async update(principal, input) {
          dutyCalls.push({ principal, input });
          return {
            systemThreadId: 'thread_eval_friction',
            primaryCatId: input.primaryCatId,
            backupCatId: input.backupCatId,
            version: input.expectedVersion + 1,
            updatedAt: '2026-07-26T12:00:00.000Z',
            updatedBy: principal.id,
          };
        },
      };
  const dutyReceiptService = Object.hasOwn(overrides, 'dutyReceiptService')
    ? overrides.dutyReceiptService
    : {
        async reconcile(actorCatId) {
          receiptCalls.push(actorCatId);
          return { outcome: 'incomplete', uncoveredBundleKeys: ['bundle:remaining'] };
        },
      };
  await app.register(pawFeelDispositionRoutes, {
    readModel,
    dispositionService,
    captureService,
    captureIntentSidecar,
    dutyConfigStore,
    dutyReceiptService,
    callbackRegistry: callbackRegistry(),
  });
  await app.ready();
  return {
    app,
    readQueries,
    triageCalls,
    actionCalls,
    bundleCalls,
    captureCalls,
    captureIntentCalls,
    dutyCalls,
    receiptCalls,
  };
}

function callbackHeaders() {
  return { 'x-invocation-id': 'inv-1', 'x-callback-token': 'token-1' };
}

function seenCommand(overrides = {}) {
  return {
    type: 'mark_seen',
    eventId: 'event-1',
    signalId: 'signal-1',
    expectedSequence: 1,
    ...overrides,
  };
}

describe('F278 paw-feel disposition routes', () => {
  const apps = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  it('requires session auth for Workspace reads and forwards bounded filters', async () => {
    const fixture = await createApp();
    apps.push(fixture.app);

    const denied = await fixture.app.inject({ method: 'GET', url: '/api/paw-feel/inbox' });
    const allowed = await fixture.app.inject({
      method: 'GET',
      url: '/api/paw-feel/inbox?states=new,seen&limit=25&overdueOnly=true&sort=newest',
      headers: { 'x-session-user': 'user-1' },
    });

    assert.equal(denied.statusCode, 401);
    assert.equal(allowed.statusCode, 200);
    assert.deepEqual(fixture.readQueries[0], {
      states: ['new', 'seen'],
      overdueOnly: true,
      limit: 25,
      sort: 'newest',
    });
  });

  it('loads original-message projection through the same read model', async () => {
    const fixture = await createApp();
    apps.push(fixture.app);

    const response = await fixture.app.inject({
      method: 'GET',
      url: '/api/paw-feel/source/message-123',
      headers: { 'x-session-user': 'user-1' },
    });

    assert.equal(response.statusCode, 200);
    assert.equal(fixture.readQueries[0].sourceMessageId, 'message-123');
  });

  it('supports callback and agent-key-safe cat reads without accepting caller identity', async () => {
    const fixture = await createApp();
    apps.push(fixture.app);

    const denied = await fixture.app.inject({ method: 'GET', url: '/api/callbacks/paw-feel-inbox' });
    const allowed = await fixture.app.inject({
      method: 'GET',
      url: '/api/callbacks/paw-feel-inbox?sourceCatId=codex-sol',
      headers: callbackHeaders(),
    });

    assert.equal(denied.statusCode, 401);
    assert.equal(allowed.statusCode, 200);
    assert.deepEqual(fixture.readQueries[0], { sourceCatId: 'codex-sol' });
  });

  it('derives the triage actor from callback auth and rejects spoofing or oversized batches', async () => {
    const fixture = await createApp();
    apps.push(fixture.app);

    const spoofed = await fixture.app.inject({
      method: 'POST',
      url: '/api/callbacks/paw-feel-triage',
      headers: callbackHeaders(),
      payload: { commands: [seenCommand({ actor: { kind: 'cat', id: 'codex-sol' } })] },
    });
    const oversized = await fixture.app.inject({
      method: 'POST',
      url: '/api/callbacks/paw-feel-triage',
      headers: callbackHeaders(),
      payload: {
        commands: Array.from({ length: 51 }, (_, index) =>
          seenCommand({ eventId: `event-${index}`, signalId: `signal-${index}` }),
        ),
      },
    });
    const allowed = await fixture.app.inject({
      method: 'POST',
      url: '/api/callbacks/paw-feel-triage',
      headers: callbackHeaders(),
      payload: { commands: [seenCommand()] },
    });

    assert.equal(spoofed.statusCode, 400);
    assert.equal(oversized.statusCode, 400);
    assert.equal(allowed.statusCode, 200);
    assert.deepEqual(fixture.triageCalls[0].principal, { kind: 'cat', id: 'opus' });
    assert.equal(fixture.triageCalls[0].commands.length, 1);
  });

  it('captures a new report through authenticated sourceMessageId-only intake', async () => {
    const fixture = await createApp();
    apps.push(fixture.app);
    const response = await fixture.app.inject({
      method: 'POST',
      url: '/api/callbacks/paw-feel-capture',
      headers: callbackHeaders(),
      payload: { sourceMessageId: 'message-typed-1' },
    });

    assert.equal(response.statusCode, 200);
    assert.deepEqual(fixture.captureCalls, [
      { principal: { kind: 'cat', id: 'opus' }, sourceMessageId: 'message-typed-1' },
    ]);
    assert.equal(JSON.stringify(fixture.captureCalls).includes('symptom'), false);
  });

  it('declares a current-turn capture intent without source text or a future message ID', async () => {
    const fixture = await createApp();
    apps.push(fixture.app);
    const response = await fixture.app.inject({
      method: 'POST',
      url: '/api/callbacks/paw-feel-capture-intent',
      headers: callbackHeaders(),
      payload: {},
    });

    assert.equal(response.statusCode, 200);
    assert.deepEqual(fixture.captureIntentCalls, [
      {
        kind: 'invocation',
        invocationId: 'inv-1',
        threadId: 'thread_eval_friction',
        userId: 'user-1',
        catId: 'opus',
      },
    ]);
    assert.deepEqual(JSON.parse(response.body), {
      kind: 'declared',
      invocationId: 'inv-1',
      expiresAt: 1234,
    });
  });

  it('accepts one callback bundle snapshot instead of requiring per-row routing calls', async () => {
    const fixture = await createApp();
    apps.push(fixture.app);
    const missingSnapshot = await fixture.app.inject({
      method: 'POST',
      url: '/api/callbacks/paw-feel-bundle-triage',
      headers: callbackHeaders(),
      payload: {
        bundleKey: 'turn:turn-1',
        eventIdPrefix: 'bundle-missing-snapshot',
        members: [{ signalId: 'signal-1', expectedSequence: 1 }],
        action: { type: 'no_action', reasonCode: 'not_actionable' },
      },
    });
    const response = await fixture.app.inject({
      method: 'POST',
      url: '/api/callbacks/paw-feel-bundle-triage',
      headers: callbackHeaders(),
      payload: {
        bundleKey: 'turn:turn-1',
        membershipToken: 'signed-list-snapshot',
        eventIdPrefix: 'bundle-1',
        members: [
          { signalId: 'signal-1', expectedSequence: 1 },
          { signalId: 'signal-2', expectedSequence: 1 },
        ],
        action: { type: 'no_action', reasonCode: 'not_actionable' },
      },
    });

    assert.equal(missingSnapshot.statusCode, 400);
    assert.equal(response.statusCode, 200);
    assert.equal(fixture.bundleCalls.length, 1);
    assert.deepEqual(fixture.bundleCalls[0].principal, { kind: 'cat', id: 'opus' });
    assert.equal(fixture.bundleCalls[0].command.members.length, 2);
    assert.deepEqual(fixture.receiptCalls, ['opus']);
    assert.deepEqual(JSON.parse(response.body).dutyReceipt, {
      outcome: 'incomplete',
      uncoveredBundleKeys: ['bundle:remaining'],
    });
  });

  it('keeps durable triage successful when auxiliary receipt reconciliation fails', async () => {
    const fixture = await createApp({
      dutyReceiptService: {
        async reconcile() {
          throw new Error('notice message unavailable');
        },
      },
    });
    apps.push(fixture.app);

    const response = await fixture.app.inject({
      method: 'POST',
      url: '/api/callbacks/paw-feel-triage',
      headers: callbackHeaders(),
      payload: { commands: [seenCommand()] },
    });

    assert.equal(response.statusCode, 200);
    const body = JSON.parse(response.body);
    assert.equal(body.results[0].outcome, 'appended');
    assert.deepEqual(body.dutyReceiptWarning, {
      code: 'receipt_reconciliation_failed',
      detail: 'notice message unavailable',
    });
  });

  it('prevents operator from attributing cat-signed terminal actions while retaining verified-fix override', async () => {
    const previousOwner = process.env.DEFAULT_OWNER_USER_ID;
    process.env.DEFAULT_OWNER_USER_ID = 'user-1';
    try {
      const fixture = await createApp({
        dispositionService: {
          async executeMany(principal, commands, options) {
            fixture.actionCalls.push({ principal, commands, options });
            return commands.map((command) => ({
              outcome: 'appended',
              projection: { signalId: command.signalId, state: command.type.replace('mark_', '') },
            }));
          },
        },
      });
      apps.push(fixture.app);
      const duplicate = await fixture.app.inject({
        method: 'POST',
        url: '/api/paw-feel/actions',
        headers: { 'x-session-user': 'user-1' },
        payload: {
          type: 'duplicate',
          eventId: 'ui-duplicate-1',
          signalId: 'signal-1',
          expectedSequence: 1,
          duplicateOf: 'signal-0',
          ownerCatId: 'opus',
        },
      });
      const noAction = await fixture.app.inject({
        method: 'POST',
        url: '/api/paw-feel/actions',
        headers: { 'x-session-user': 'user-1' },
        payload: {
          type: 'no_action',
          eventId: 'ui-no-action-1',
          signalId: 'signal-2',
          expectedSequence: 1,
          reasonCode: 'not_actionable',
          ownerCatId: 'opus',
        },
      });
      const fix = await fixture.app.inject({
        method: 'POST',
        url: '/api/paw-feel/actions',
        headers: { 'x-session-user': 'user-1' },
        payload: {
          type: 'fix',
          eventId: 'ui-fix-1',
          signalId: 'signal-3',
          expectedSequence: 1,
          leaseId: 'lease-active',
        },
      });
      const legacy = await fixture.app.inject({
        method: 'POST',
        url: '/api/paw-feel/actions',
        headers: { 'x-session-user': 'user-1' },
        payload: {
          type: 'confirm_routed',
          eventId: 'ui-route-1',
          signalId: 'signal-4',
          expectedSequence: 1,
          receiptRef: 'message:transport-only',
        },
      });

      assert.deepEqual([duplicate.statusCode, noAction.statusCode, fix.statusCode], [403, 403, 200]);
      assert.equal(legacy.statusCode, 400);
      assert.deepEqual(
        fixture.actionCalls.map((call) => call.principal),
        [{ kind: 'cvo', id: 'user-1' }],
      );
      assert.equal(fixture.actionCalls[0].commands[0].type, 'mark_fix');

      const forgedBundle = await fixture.app.inject({
        method: 'POST',
        url: '/api/paw-feel/bundle-actions',
        headers: { 'x-session-user': 'user-1' },
        payload: {
          bundleKey: 'turn:turn-1',
          eventIdPrefix: 'ui-forged-bundle',
          members: [{ signalId: 'signal-1', expectedSequence: 1 }],
          action: { type: 'no_action', reasonCode: 'not_actionable' },
          ownerCatId: 'opus',
        },
      });
      assert.equal(forgedBundle.statusCode, 400, 'ownerCatId is not accepted on the operator bundle path');
      assert.equal(fixture.bundleCalls.length, 0);
    } finally {
      if (previousOwner === undefined) delete process.env.DEFAULT_OWNER_USER_ID;
      else process.env.DEFAULT_OWNER_USER_ID = previousOwner;
    }
  });

  it('keeps duty assignment on the owner-session operator path with version conflicts', async () => {
    const previousOwner = process.env.DEFAULT_OWNER_USER_ID;
    process.env.DEFAULT_OWNER_USER_ID = 'user-1';
    try {
      const fixture = await createApp();
      apps.push(fixture.app);
      const allowed = await fixture.app.inject({
        method: 'PATCH',
        url: '/api/paw-feel/duty',
        headers: { 'x-session-user': 'user-1' },
        payload: { expectedVersion: 0, primaryCatId: 'codex-sol', backupCatId: 'opus' },
      });

      assert.equal(allowed.statusCode, 200);
      assert.deepEqual(fixture.dutyCalls[0].principal, { kind: 'cvo', id: 'user-1' });

      const partial = await fixture.app.inject({
        method: 'PATCH',
        url: '/api/paw-feel/duty',
        headers: { 'x-session-user': 'user-1' },
        payload: { expectedVersion: 1, primaryCatId: 'opus' },
      });
      assert.equal(partial.statusCode, 400);
      assert.equal(fixture.dutyCalls.length, 1, 'partial duty must be rejected before persistence');

      const conflictFixture = await createApp({
        dutyConfigStore: {
          async read() {
            return null;
          },
          async update() {
            throw new PawFeelDutyConfigStoreError('version_conflict', 'stale', 4);
          },
        },
      });
      apps.push(conflictFixture.app);
      const conflict = await conflictFixture.app.inject({
        method: 'PATCH',
        url: '/api/paw-feel/duty',
        headers: { 'x-session-user': 'user-1' },
        payload: { expectedVersion: 3, primaryCatId: 'opus', backupCatId: 'kimi' },
      });

      assert.equal(conflict.statusCode, 409);
      assert.equal(JSON.parse(conflict.body).actualVersion, 4);
    } finally {
      if (previousOwner === undefined) delete process.env.DEFAULT_OWNER_USER_ID;
      else process.env.DEFAULT_OWNER_USER_ID = previousOwner;
    }
  });

  it('returns 503 when canonical services are absent instead of in-memory success', async () => {
    const fixture = await createApp({
      readModel: undefined,
      dispositionService: undefined,
      captureService: undefined,
      captureIntentSidecar: undefined,
      dutyConfigStore: undefined,
    });
    apps.push(fixture.app);

    const read = await fixture.app.inject({
      method: 'GET',
      url: '/api/paw-feel/inbox',
      headers: { 'x-session-user': 'user-1' },
    });

    assert.equal(read.statusCode, 503);
  });
});
