import assert from 'node:assert/strict';
import { afterEach, before, describe, it } from 'node:test';
import Fastify from 'fastify';

let capabilityEvolutionProgramRoutes;
let EvolutionProgramServiceError;
const apps = [];

before(async () => {
  ({ capabilityEvolutionProgramRoutes } = await import('../dist/routes/capability-evolution-program-routes.js'));
  ({ EvolutionProgramServiceError } = await import(
    '../dist/infrastructure/capability-evolution/program-command-contract.js'
  ));
});

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

const programId = 'evolution-program:33333333333333333333333333333333';
const projection = { program: { programId, workspaceId: 'user:operator', sequence: 8 } };

const serviceWith = (overrides = {}) => ({
  get: async () => projection,
  proposeChange: async () => ({ outcome: 'waiting', projection }),
  syncChange: async () => ({ outcome: 'waiting', projection }),
  decideChange: async () => ({ outcome: 'appended', projection }),
  ...overrides,
});

async function appWith(service, principal = { kind: 'session', userId: 'operator' }) {
  const app = Fastify();
  if (principal) {
    app.addHook('preHandler', (request, _reply, done) => {
      if (principal.kind === 'session') request.sessionUserId = principal.userId;
      else {
        request.callbackPrincipal = principal;
        if (principal.kind === 'invocation') {
          request.callbackAuth = {
            ...principal,
            callbackToken: 'secret',
            ownerAuthProvenance: { kind: 'session', userId: principal.userId },
            originTriggerMessageId: principal.originMessageId,
            clientMessageIds: new Set(),
            createdAt: 1,
            expiresAt: null,
            state: 'active',
          };
        }
      }
      done();
    });
  }
  await app.register(capabilityEvolutionProgramRoutes, { service });
  apps.push(app);
  return app;
}

const payload = (action) => ({
  expectedSequence: 8,
  clientMessageId: 'change-1',
  action,
});

describe('F311 Phase 4 change API terminal guards', () => {
  it('reports an unwired F266/F313 owner as unavailable instead of fabricating local state', async () => {
    const app = await appWith(
      serviceWith({
        proposeChange: async () => {
          throw new EvolutionProgramServiceError(
            'owner_contract_unavailable',
            'F266/F313 change owner contract is unavailable',
          );
        },
      }),
      {
        kind: 'invocation',
        invocationId: 'inv-phase4',
        threadId: 'thread-phase4',
        userId: 'operator',
        catId: 'codex-sol',
        originMessageId: 'message-phase4',
      },
    );
    const response = await app.inject({
      method: 'POST',
      url: `/api/capability-evolution/programs/${programId}/changes`,
      payload: payload({ kind: 'propose' }),
    });
    assert.equal(response.statusCode, 503);
    assert.equal(response.json().error, 'owner_contract_unavailable');
  });

  it('keeps unauthenticated and cross-workspace callers out', async () => {
    const unauthenticated = await appWith(serviceWith(), null);
    assert.equal(
      (
        await unauthenticated.inject({
          method: 'POST',
          url: `/api/capability-evolution/programs/${programId}/changes`,
          payload: payload({ kind: 'sync' }),
        })
      ).statusCode,
      401,
    );

    const other = await appWith(serviceWith(), { kind: 'session', userId: 'other' });
    assert.equal(
      (
        await other.inject({
          method: 'POST',
          url: `/api/capability-evolution/programs/${programId}/changes`,
          payload: payload({ kind: 'sync' }),
        })
      ).statusCode,
      404,
    );
  });
});
