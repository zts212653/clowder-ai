import assert from 'node:assert/strict';
import { afterEach, before, describe, it } from 'node:test';
import Fastify from 'fastify';

/**
 * Route-level contract for the F311 Phase 3 evaluation ingress.
 *
 * The service tests prove the Program can reach the states; these prove the HTTP surface cannot be
 * used to skip the owner. The most important assertions here are negative: a caller must not be
 * able to state an owner verdict, reach another workspace's Program, or bypass auth.
 */

let capabilityEvolutionProgramRoutes;
const apps = [];

before(async () => {
  ({ capabilityEvolutionProgramRoutes } = await import('../dist/routes/capability-evolution-program-routes.js'));
});

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

const programId = 'evolution-program:22222222222222222222222222222222';
const projection = { program: { programId, workspaceId: 'user:operator', sequence: 4 }, attribution: null };

const measurement = { evidenceProofRef: { ownerFeatureId: 'F267', ownerStateRef: 'measurement-proof:proof-1' } };

const body = (action, overrides = {}) => ({
  expectedSequence: 4,
  clientMessageId: 'evaluate-1',
  action,
  ...overrides,
});

async function appWith(service, { authenticated = true } = {}) {
  const app = Fastify();
  if (authenticated) {
    app.addHook('preHandler', (request, _reply, done) => {
      request.sessionUserId = 'operator';
      done();
    });
  }
  await app.register(capabilityEvolutionProgramRoutes, { service });
  apps.push(app);
  return app;
}

const baseService = (overrides = {}) => ({
  get: async () => projection,
  linkCertificates: async () => ({ outcome: 'appended', projection }),
  triggerEvaluation: async () => ({ outcome: 'appended', projection }),
  linkMeasurement: async () => ({ outcome: 'appended', projection }),
  linkAttribution: async () => ({ outcome: 'appended', projection }),
  linkIntervention: async () => ({ outcome: 'appended', projection }),
  ...overrides,
});

const ref = (ownerFeatureId, ownerStateRef) => ({ ownerFeatureId, ownerStateRef });
const constitutionBody = (overrides = {}) => ({
  expectedSequence: 4,
  clientMessageId: 'constitute-1',
  certificates: {
    goal: ref('F311', 'goal:p'),
    measurement: ref('F267', 'measurement-certificate:p'),
    economic: ref('F311', 'economic:p'),
  },
  valueOwnerRef: ref('F311', 'value-owner:p'),
  measurementRoleRefs: {
    observer: ref('F267', 'observer:p'),
    domainOwner: ref('F267', 'domain-owner:p'),
    consumer: ref('F267', 'consumer:p'),
    calibrator: ref('F267', 'calibrator:p'),
  },
  ...overrides,
});

describe('F311 Phase 3 evaluation API', () => {
  it('exposes constitution and round-opening as real endpoints', async () => {
    // These two transitions previously had no public producer at all, so a freshly created Program
    // could never leave `constituting` except by writing to the event log from a test.
    let constituted;
    let round;
    const app = await appWith(
      baseService({
        linkCertificates: async (input) => {
          constituted = input;
          return { outcome: 'appended', projection };
        },
        triggerEvaluation: async (input) => {
          round = input;
          return { outcome: 'appended', projection };
        },
      }),
    );
    const constitution = await app.inject({
      method: 'POST',
      url: `/api/capability-evolution/programs/${programId}/constitution`,
      payload: constitutionBody(),
    });
    assert.equal(constitution.statusCode, 200, constitution.body);
    assert.equal(constituted.certificates.measurement.ownerStateRef, 'measurement-certificate:p');
    assert.equal(constituted.actorRef.length > 0, true);

    const opened = await app.inject({
      method: 'POST',
      url: `/api/capability-evolution/programs/${programId}/evaluation-rounds`,
      payload: {
        expectedSequence: 4,
        clientMessageId: 'round-1',
        evidenceProofRef: ref('F267', 'measurement-proof:p'),
      },
    });
    assert.equal(opened.statusCode, 200, opened.body);
    // The receipt and the exposure proof are owner-held; the request carries only an identity.
    assert.equal(round.ownerUserId, 'operator');
    assert.equal('triggerReceiptRef' in round, false);
    assert.equal('exposureProofRef' in round, false);
  });

  it('refuses a caller-stated trigger receipt or exposure proof', async () => {
    let called = false;
    const app = await appWith(
      baseService({
        triggerEvaluation: async () => {
          called = true;
          return { outcome: 'appended', projection };
        },
      }),
    );
    const response = await app.inject({
      method: 'POST',
      url: `/api/capability-evolution/programs/${programId}/evaluation-rounds`,
      payload: {
        expectedSequence: 4,
        clientMessageId: 'round-1',
        evidenceProofRef: ref('F267', 'measurement-proof:p'),
        triggerReceiptRef: ref('F192', 'eval-trigger-receipt:forged'),
      },
    });
    assert.equal(response.statusCode, 400);
    assert.equal(called, false, 'a request carrying an owner receipt must never reach the service');
  });

  it('treats a reversed 2x2 matrix as the same command, and rejects a repeated coordinate', async () => {
    // The rejudge matrix is addressed by (rubric, candidate), never by position. Before this, the
    // same completed matrix written bottom-up digested differently, so a semantic retry came back as
    // an idempotency collision instead of a duplicate.
    const seen = [];
    const app = await appWith(
      baseService({
        linkAttribution: async (input) => {
          seen.push(input);
          return { outcome: 'appended', projection };
        },
      }),
    );
    const cell = (rubric, candidate) => ({
      rubric,
      candidate,
      evidenceProofRef: ref('F267', `measurement-proof:${rubric}-${candidate}`),
    });
    const matrix = [
      cell('previous', 'previous'),
      cell('previous', 'current'),
      cell('current', 'previous'),
      cell('current', 'current'),
    ];
    const post = (cells, clientMessageId) =>
      app.inject({
        method: 'POST',
        url: `/api/capability-evolution/programs/${programId}/evaluations`,
        payload: {
          expectedSequence: 4,
          clientMessageId,
          action: {
            kind: 'attribution',
            measurement,
            attribution: { candidates: [], rejudge: { cells } },
          },
        },
      });

    assert.equal((await post(matrix, 'attribute-1')).statusCode, 200);
    assert.equal((await post([...matrix].reverse(), 'attribute-1')).statusCode, 200);
    // Same command: the service must receive byte-identical cells, so the digest is identical too.
    assert.deepEqual(seen[0].rejudge.cells, seen[1].rejudge.cells);

    // One coordinate, filled twice, is a caller error rather than a merge.
    const duplicated = await post([cell('previous', 'previous'), cell('previous', 'previous')], 'attribute-2');
    assert.equal(duplicated.statusCode, 400);
    assert.equal(seen.length, 2, 'a repeated coordinate must never reach the service');
  });

  it('keeps attribution evidence refs in the order the caller submitted them', async () => {
    // `evidenceRefs` is a sequence, not a set — unlike the layers and the matrix coordinates.
    const seen = [];
    const app = await appWith(
      baseService({
        linkAttribution: async (input) => {
          seen.push(input);
          return { outcome: 'appended', projection };
        },
      }),
    );
    const first = ref('F299', 'inv:1');
    const second = ref('F278', 'paw-feel:2');
    await app.inject({
      method: 'POST',
      url: `/api/capability-evolution/programs/${programId}/evaluations`,
      payload: {
        expectedSequence: 4,
        clientMessageId: 'attribute-order',
        action: {
          kind: 'attribution',
          measurement,
          attribution: { candidates: [{ layer: 'execution', evidenceRefs: [first, second] }] },
        },
      },
    });
    assert.deepEqual(seen[0].candidates[0].evidenceRefs, [first, second]);
  });

  it('rejects an unauthenticated caller', async () => {
    const app = await appWith(baseService(), { authenticated: false });
    const response = await app.inject({
      method: 'POST',
      url: `/api/capability-evolution/programs/${programId}/evaluations`,
      payload: body({ kind: 'measurement', measurement }),
    });
    assert.equal(response.statusCode, 401);
  });

  it('does not expose a Program from another workspace', async () => {
    const app = await appWith(
      baseService({ get: async () => ({ program: { programId, workspaceId: 'user:someone-else', sequence: 4 } }) }),
    );
    const response = await app.inject({
      method: 'POST',
      url: `/api/capability-evolution/programs/${programId}/evaluations`,
      payload: body({ kind: 'measurement', measurement }),
    });
    assert.equal(response.statusCode, 404);
  });

  it('refuses a caller-stated owner verdict', async () => {
    let called = false;
    const app = await appWith(
      baseService({
        linkMeasurement: async () => {
          called = true;
          return { outcome: 'appended', projection };
        },
      }),
    );
    const response = await app.inject({
      method: 'POST',
      url: `/api/capability-evolution/programs/${programId}/evaluations`,
      payload: body({
        kind: 'measurement',
        measurement: { ...measurement, ownerDecisionStatus: 'usable' },
      }),
    });
    assert.equal(response.statusCode, 400);
    assert.equal(called, false, 'a request carrying an owner verdict must never reach the service');
  });

  it('refuses caller-stated discrimination and a caller-chosen cycle', async () => {
    const app = await appWith(baseService());
    const attribution = {
      previousRubricRef: {
        ownerFeatureId: 'F192',
        ownerStateRef: 'rubric:evolve',
        version: 'v3',
        assetKind: 'rubric',
        assetId: 'evolve',
      },
      currentRubricRef: {
        ownerFeatureId: 'F192',
        ownerStateRef: 'rubric:evolve',
        version: 'v3',
        assetKind: 'rubric',
        assetId: 'evolve',
      },
      candidates: [{ layer: 'execution', evidenceRefs: [{ ownerFeatureId: 'F299', ownerStateRef: 'inv:1' }] }],
    };
    const withDiscrimination = await app.inject({
      method: 'POST',
      url: `/api/capability-evolution/programs/${programId}/evaluations`,
      payload: body({
        kind: 'attribution',
        measurement,
        attribution: {
          ...attribution,
          candidates: [{ ...attribution.candidates[0], discriminating: true }],
        },
      }),
    });
    assert.equal(withDiscrimination.statusCode, 400);

    const withCycle = await app.inject({
      method: 'POST',
      url: `/api/capability-evolution/programs/${programId}/evaluations`,
      payload: body({ kind: 'attribution', measurement, attribution: { ...attribution, cycle: 99 } }),
    });
    assert.equal(withCycle.statusCode, 400);
  });

  it('passes the server-derived owner identity to the service', async () => {
    let seen;
    const app = await appWith(
      baseService({
        linkMeasurement: async (input) => {
          seen = input;
          return { outcome: 'appended', projection };
        },
      }),
    );
    const response = await app.inject({
      method: 'POST',
      url: `/api/capability-evolution/programs/${programId}/evaluations`,
      payload: body({ kind: 'measurement', measurement }),
    });
    assert.equal(response.statusCode, 200);
    assert.equal(seen.ownerUserId, 'operator');
    assert.equal(seen.actorRef.length > 0, true);
  });

  it('reports duplicate and conflict outcomes distinctly', async () => {
    const duplicate = await appWith(
      baseService({ linkMeasurement: async () => ({ outcome: 'duplicate', projection }) }),
    );
    const duplicateResponse = await duplicate.inject({
      method: 'POST',
      url: `/api/capability-evolution/programs/${programId}/evaluations`,
      payload: body({ kind: 'measurement', measurement }),
    });
    assert.equal(duplicateResponse.statusCode, 200);

    const conflict = await appWith(
      baseService({
        linkMeasurement: async () => ({ outcome: 'conflict', actualSequence: 9, projection }),
      }),
    );
    const conflictResponse = await conflict.inject({
      method: 'POST',
      url: `/api/capability-evolution/programs/${programId}/evaluations`,
      payload: body({ kind: 'measurement', measurement }),
    });
    assert.equal(conflictResponse.statusCode, 409);
    assert.equal(conflictResponse.json().actualSequence, 9);
  });
});
