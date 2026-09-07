import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import Fastify from 'fastify';

const PROGRAM_ID = 'evolution-program:bcc336788a7df9d6075b1efb4c0a7e68';

describe('F267 capability-evolution measurement issuance route', () => {
  const apps = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  async function createApp({ principal, measurementIssuer }) {
    const app = Fastify();
    if (principal) {
      app.addHook('preHandler', (request, _reply, done) => {
        request.callbackPrincipal = principal;
        done();
      });
    }
    const { capabilityEvolutionProgramRoutes } = await import('../dist/routes/capability-evolution-program-routes.js');
    await app.register(capabilityEvolutionProgramRoutes, { measurementIssuer });
    apps.push(app);
    return app;
  }

  it('derives owner and eval cat from callback auth and accepts only program id + client message id', async () => {
    const calls = [];
    const app = await createApp({
      principal: {
        kind: 'invocation',
        invocationId: 'inv-f267-e0',
        threadId: 'thread-f267',
        userId: 'operator',
        catId: 'codex-sol',
      },
      measurementIssuer: {
        issue: async (input) => {
          calls.push(input);
          return {
            status: 'insufficient',
            reason: 'source_owner_manifest_missing',
            blockers: ['measurement_birth_contract_missing'],
          };
        },
      },
    });

    const response = await app.inject({
      method: 'POST',
      url: `/api/callbacks/evolution-programs/${encodeURIComponent(PROGRAM_ID)}/measurement-issuance`,
      payload: { clientMessageId: 'message-issue-e0' },
    });

    assert.equal(response.statusCode, 422);
    assert.equal(response.json().reason, 'source_owner_manifest_missing');
    assert.deepEqual(calls, [
      {
        programId: PROGRAM_ID,
        ownerUserId: 'operator',
        catId: 'codex-sol',
        clientMessageId: 'message-issue-e0',
      },
    ]);

    const smuggled = await app.inject({
      method: 'POST',
      url: `/api/callbacks/evolution-programs/${encodeURIComponent(PROGRAM_ID)}/measurement-issuance`,
      payload: { clientMessageId: 'message-issue-e0', ownerUserId: 'other', certificate: {} },
    });
    assert.equal(smuggled.statusCode, 400);
    assert.equal(calls.length, 1);

    const injectedTrailer = await app.inject({
      method: 'POST',
      url: `/api/callbacks/evolution-programs/${encodeURIComponent(PROGRAM_ID)}/measurement-issuance`,
      payload: { clientMessageId: 'source-a\nSource-Message: source-b' },
    });
    assert.equal(injectedTrailer.statusCode, 400);
    assert.equal(calls.length, 1);

    for (const clientMessageId of ['source-a\n', 'source-a\r']) {
      const trailingControl = await app.inject({
        method: 'POST',
        url: `/api/callbacks/evolution-programs/${encodeURIComponent(PROGRAM_ID)}/measurement-issuance`,
        payload: { clientMessageId },
      });
      assert.equal(trailingControl.statusCode, 400);
      assert.equal(calls.length, 1);
    }
  });

  it('is callback-only and fails closed when the issuer is unavailable', async () => {
    const noPrincipal = await createApp({
      measurementIssuer: { issue: async () => assert.fail('unauthenticated request reached issuer') },
    });
    const unauthorized = await noPrincipal.inject({
      method: 'POST',
      url: `/api/callbacks/evolution-programs/${encodeURIComponent(PROGRAM_ID)}/measurement-issuance`,
      payload: { clientMessageId: 'message-issue-e0' },
    });
    assert.equal(unauthorized.statusCode, 401);

    const unavailable = await createApp({
      principal: {
        kind: 'agent_key',
        agentKeyId: 'agent-key-codex-sol',
        userId: 'operator',
        catId: 'codex-sol',
      },
    });
    const response = await unavailable.inject({
      method: 'POST',
      url: `/api/callbacks/evolution-programs/${encodeURIComponent(PROGRAM_ID)}/measurement-issuance`,
      payload: { clientMessageId: 'message-issue-e0' },
    });
    assert.equal(response.statusCode, 503);
    assert.equal(response.json().error, 'capability_evolution_measurement_issuer_unavailable');
  });
});
