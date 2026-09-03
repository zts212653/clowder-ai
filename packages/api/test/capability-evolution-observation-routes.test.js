import assert from 'node:assert/strict';
import { afterEach, before, describe, it } from 'node:test';
import Fastify from 'fastify';

let capabilityEvolutionProgramRoutes;
const apps = [];

before(async () => {
  ({ capabilityEvolutionProgramRoutes } = await import('../dist/routes/capability-evolution-program-routes.js'));
});

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

const programId = 'evolution-program:11111111111111111111111111111111';
const projection = {
  program: { programId, workspaceId: 'user:operator', sequence: 2 },
  observation: { status: 'insufficient', connectedEyes: [], gaps: [] },
};
const payload = {
  expectedSequence: 2,
  clientMessageId: 'observe-1',
  trajectoryRef: { ownerFeatureId: 'F299', ownerStateRef: 'inv:invocation-1' },
  sourceBindings: [
    {
      sourceKind: 'paw-feel-disposition',
      ownerSurfaceRef: { ownerFeatureId: 'F278', ownerStateRef: 'paw-feel:signal-1' },
      joinKey: 'message:message-1',
      namedConsumerRef: { ownerFeatureId: 'F311', ownerStateRef: 'evolution-consumer:program' },
      instrumentationRef: { ownerFeatureId: 'F278', ownerStateRef: 'instrumentation:paw-feel-v1' },
    },
    {
      sourceKind: 'human-disposition',
      ownerSurfaceRef: { ownerFeatureId: 'F281', ownerStateRef: 'human-disposition:decision-1' },
      joinKey: 'subject:proposal-1',
      namedConsumerRef: { ownerFeatureId: 'F311', ownerStateRef: 'evolution-consumer:program' },
      instrumentationRef: { ownerFeatureId: 'F281', ownerStateRef: 'instrumentation:human-disposition-v1' },
    },
  ],
  evidenceProofRef: { ownerFeatureId: 'F267', ownerStateRef: 'measurement-proof:proof-1' },
};

async function appWith(service) {
  const app = Fastify();
  app.addHook('preHandler', (request, _reply, done) => {
    request.sessionUserId = 'operator';
    done();
  });
  await app.register(capabilityEvolutionProgramRoutes, { service });
  apps.push(app);
  return app;
}

describe('F311 observation API', () => {
  it('derives owner identity server-side and returns typed insufficient without appending', async () => {
    const calls = [];
    const blocker = { code: 'evidence_owner_contract_unavailable', ownerFeatureId: 'F267' };
    const app = await appWith({
      get: async () => projection,
      linkObservation: async (input) => {
        calls.push(input);
        return { outcome: 'insufficient', blockers: [blocker], projection };
      },
    });
    const response = await app.inject({
      method: 'POST',
      url: `/api/capability-evolution/programs/${encodeURIComponent(programId)}/observations`,
      payload,
    });

    assert.equal(response.statusCode, 422);
    assert.equal(response.json().outcome, 'insufficient');
    assert.deepEqual(response.json().blockers, [blocker]);
    assert.equal(calls[0].ownerUserId, 'operator');
    assert.equal(calls[0].actorRef, 'user:operator');
    assert.equal(calls[0].trajectoryRef.ownerStateRef, 'inv:invocation-1');
  });

  it('rejects caller-authored owner identity and payload copies', async () => {
    const app = await appWith({ get: async () => projection, linkObservation: async () => assert.fail() });
    for (const smuggled of [
      { ownerUserId: 'someone-else' },
      { payload: { copied: true } },
      { sourceMessageBody: 'copied owner payload' },
    ]) {
      const response = await app.inject({
        method: 'POST',
        url: `/api/capability-evolution/programs/${encodeURIComponent(programId)}/observations`,
        payload: { ...payload, ...smuggled },
      });
      assert.equal(response.statusCode, 400);
    }
  });
});
