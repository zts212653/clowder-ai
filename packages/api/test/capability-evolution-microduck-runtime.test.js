import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import Fastify from 'fastify';
import {
  createMicroduckRuntimeAdapter,
  MicroduckOwnerRuntimeRegistration,
} from '../dist/infrastructure/capability-evolution/adapters/microduck-owner-runtime.js';
import { ProgramAdapterRegistry } from '../dist/infrastructure/capability-evolution/adapters/program-adapter-registry.js';
import { capabilityEvolutionProgramRoutes } from '../dist/routes/capability-evolution-program-routes.js';
import {
  exactBase,
  makeHarness,
  objectRef,
  permissionRef,
  programRef,
  showState,
  targetVersionRef,
} from './helpers/microduck-owner-harness.js';

describe('F311 Microduck runtime federation', () => {
  it('keeps the permanent runtime seam registered but fail-closed until the owner connects', async () => {
    const registration = new MicroduckOwnerRuntimeRegistration();
    const adapter = createMicroduckRuntimeAdapter({ registration });
    const result = await adapter.manifest({ ...exactBase(), programSequence: 1 });

    assert.equal(result.manifestVersion, 'f311-microduck-show-v1');
    assert.equal(result.tier, 'B');
    assert.equal(result.actionState, 'disabled');
    assert.deepEqual(result.blockers, [{ code: 'owner_route_unavailable' }]);
  });

  it('turns owner runtime failures into typed blockers at the credential boundary', async () => {
    const registration = new MicroduckOwnerRuntimeRegistration();
    registration.connect({
      owner: {
        async observe() {
          throw new Error('remote owner unavailable');
        },
        async resolveShowState() {
          throw new Error('remote owner unavailable');
        },
      },
      credentialBoundary: {
        async authorize() {
          throw new Error('secret provider unavailable');
        },
      },
    });
    const adapter = createMicroduckRuntimeAdapter({ registration });

    assert.deepEqual(await adapter.observe(exactBase()), { status: 'blocked', code: 'owner_route_unavailable' });
    assert.deepEqual(
      await adapter.permission({
        ...exactBase(),
        targetVersionRef,
        permissionRef,
        operation: 'mutate',
      }),
      { status: 'blocked', code: 'permission_missing' },
    );
    assert.equal((await adapter.manifest({ ...exactBase(), programSequence: 1 })).tier, 'B');
  });

  it('publishes the generated manifest through a GET-only canonical Program route', async () => {
    const { adapter } = makeHarness();
    const adapterRegistry = new ProgramAdapterRegistry();
    adapterRegistry.register(adapter);
    const service = {
      async get() {
        return {
          program: {
            programId: programRef.ownerStateRef,
            workspaceId: 'user:operator',
            objectRef,
            cycle: 1,
            sequence: 12,
          },
        };
      },
    };
    const app = Fastify();
    app.addHook('preHandler', (request, _reply, done) => {
      request.sessionUserId = 'operator';
      done();
    });
    await app.register(capabilityEvolutionProgramRoutes, {
      adapterRegistry,
      service,
    });

    const url = `/api/capability-evolution/programs/${encodeURIComponent(programRef.ownerStateRef)}/adapter-manifest`;
    const read = await app.inject({ method: 'GET', url });
    assert.equal(read.statusCode, 200);
    assert.equal(read.json().manifestVersion, 'f311-microduck-show-v1');
    assert.equal(read.json().tier, 'A');
    assert.equal(read.json().programSequence, 12);
    assert.equal((await app.inject({ method: 'POST', url, payload: { tier: 'A' } })).statusCode, 404);

    const intruder = Fastify();
    intruder.addHook('preHandler', (request, _reply, done) => {
      request.sessionUserId = 'someone-else';
      done();
    });
    await intruder.register(capabilityEvolutionProgramRoutes, {
      adapterRegistry,
      service,
    });
    assert.equal((await intruder.inject({ method: 'GET', url })).statusCode, 404);
    assert.equal(
      (await intruder.inject({ method: 'GET', url: url.replace(/adapter-manifest$/u, 'adapter-media/1') })).statusCode,
      404,
    );
    await intruder.close();
    await app.close();
  });

  it('streams only owner-resolved image/video bytes from the canonical authenticated media route', async () => {
    const captureRef = showState().baseline.captureRef;
    let contentType = 'image/png';
    let exactEvidence = true;
    let canonicalApproval = true;
    let deploymentMatches = true;
    let mediaResolutions = 0;
    const { adapter } = makeHarness({
      owner: {
        async resolveShowState() {
          const state = showState({
            sceneMedia: [{ sceneIndex: 1, source: 'real_capture', captureRef, kind: 'image' }],
            ...(deploymentMatches ? {} : { deployedArtifactSha256: 'b'.repeat(64) }),
          });
          return exactEvidence
            ? state
            : {
                ...state,
                baseline: {
                  ...state.baseline,
                  evaluationRef: {
                    ownerFeatureId: 'microduck-owner',
                    ownerStateRef: `capture:sha256:${'d'.repeat(64)}`,
                  },
                },
              };
        },
        async resolveShowMedia() {
          mediaResolutions += 1;
          return {
            status: 'resolved',
            captureRef,
            kind: 'image',
            contentType,
            bytes: new Uint8Array([137, 80, 78, 71]),
          };
        },
      },
      approvalResolver: {
        async resolve() {
          const state = showState();
          return {
            status: 'approved',
            approvalRef: state.approvalRef,
            proposalRef: state.approvalProposalRef,
            programRef,
            cycleRef: exactBase().cycleRef,
            interventionRef: state.interventionRef,
            targetVersionRef: canonicalApproval ? targetVersionRef : { ...targetVersionRef, version: '4'.repeat(40) },
          };
        },
      },
    });
    const adapterRegistry = new ProgramAdapterRegistry();
    adapterRegistry.register(adapter);
    const mediaService = {
      async get() {
        return {
          program: {
            programId: programRef.ownerStateRef,
            workspaceId: 'user:operator',
            objectRef,
            cycle: 1,
            sequence: 12,
          },
        };
      },
    };
    const app = Fastify();
    app.addHook('preHandler', (request, _reply, done) => {
      request.sessionUserId = 'operator';
      done();
    });
    await app.register(capabilityEvolutionProgramRoutes, {
      adapterRegistry,
      service: mediaService,
    });

    const url = `/api/capability-evolution/programs/${encodeURIComponent(programRef.ownerStateRef)}/adapter-media/1`;
    const read = await app.inject({ method: 'GET', url });
    assert.equal(read.statusCode, 200);
    assert.equal(read.headers['content-type'], 'image/png');
    assert.deepEqual([...read.rawPayload], [137, 80, 78, 71]);
    assert.equal(mediaResolutions, 1);
    assert.equal((await app.inject({ method: 'GET', url: url.replace(/\/1$/u, '/2') })).statusCode, 422);
    exactEvidence = false;
    assert.equal((await app.inject({ method: 'GET', url })).statusCode, 422);
    assert.equal(mediaResolutions, 1);
    exactEvidence = true;
    canonicalApproval = false;
    assert.equal((await app.inject({ method: 'GET', url })).statusCode, 422);
    assert.equal(mediaResolutions, 1);
    canonicalApproval = true;
    deploymentMatches = false;
    assert.equal((await app.inject({ method: 'GET', url })).statusCode, 422);
    assert.equal(mediaResolutions, 1);
    deploymentMatches = true;
    contentType = 'image/svg+xml';
    assert.equal((await app.inject({ method: 'GET', url })).statusCode, 422);
    assert.equal((await app.inject({ method: 'POST', url })).statusCode, 404);
    const unauthenticated = Fastify();
    await unauthenticated.register(capabilityEvolutionProgramRoutes, { adapterRegistry, service: mediaService });
    assert.equal((await unauthenticated.inject({ method: 'GET', url })).statusCode, 401);
    await unauthenticated.close();
    await app.close();
  });

  it('turns an adapter projection failure into a typed fail-closed route response', async () => {
    const { adapter } = makeHarness();
    const adapterRegistry = new ProgramAdapterRegistry();
    adapterRegistry.register({
      ...adapter,
      async manifest() {
        throw new Error('external owner timed out');
      },
    });
    const app = Fastify();
    app.addHook('preHandler', (request, _reply, done) => {
      request.sessionUserId = 'operator';
      done();
    });
    await app.register(capabilityEvolutionProgramRoutes, {
      adapterRegistry,
      service: {
        async get() {
          return {
            program: {
              programId: programRef.ownerStateRef,
              workspaceId: 'user:operator',
              objectRef,
              cycle: 1,
              sequence: 12,
            },
          };
        },
      },
    });

    const url = `/api/capability-evolution/programs/${encodeURIComponent(programRef.ownerStateRef)}/adapter-manifest`;
    const response = await app.inject({ method: 'GET', url });
    assert.equal(response.statusCode, 503);
    assert.deepEqual(response.json(), { status: 'blocked', code: 'owner_manifest_unavailable' });
    await app.close();
  });
});
