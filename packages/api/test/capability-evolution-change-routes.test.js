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

const payload = (action, overrides = {}) => ({
  expectedSequence: 8,
  clientMessageId: 'change-1',
  action,
  ...overrides,
});

describe('F311 Phase 4 change API authority boundary', () => {
  it('does not let a browser session mint a canonical change proposal', async () => {
    let calls = 0;
    const app = await appWith(
      serviceWith({
        proposeChange: async () => {
          calls += 1;
          return { outcome: 'waiting', projection };
        },
      }),
    );
    const response = await app.inject({
      method: 'POST',
      url: `/api/capability-evolution/programs/${programId}/changes`,
      payload: payload({ kind: 'propose' }),
    });

    assert.equal(response.statusCode, 403, response.body);
    assert.equal(response.json().error, 'change_proposal_requires_authenticated_invocation');
    assert.equal(calls, 0);
  });

  it('passes an authenticated callback principal and exact source origin to proposal ingress', async () => {
    let received;
    const app = await appWith(
      serviceWith({
        proposeChange: async (input) => {
          received = input;
          return { outcome: 'waiting', projection };
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
      url: `/api/callbacks/evolution-programs/${programId}/changes`,
      payload: payload({ kind: 'propose' }),
    });

    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual(received.requestAuthority, {
      invocationId: 'inv-phase4',
      userId: 'operator',
      catId: 'codex-sol',
      threadId: 'thread-phase4',
      originMessageId: 'message-phase4',
    });
    assert.equal(received.ownerUserId, undefined);
  });

  it('fails closed when a callback invocation has no source message binding', async () => {
    let calls = 0;
    const app = await appWith(
      serviceWith({
        proposeChange: async () => {
          calls += 1;
          return { outcome: 'waiting', projection };
        },
      }),
      {
        kind: 'invocation',
        invocationId: 'inv-phase4',
        threadId: 'thread-phase4',
        userId: 'operator',
        catId: 'codex-sol',
      },
    );
    const response = await app.inject({
      method: 'POST',
      url: `/api/callbacks/evolution-programs/${programId}/changes`,
      payload: payload({ kind: 'propose' }),
    });

    assert.equal(response.statusCode, 409, response.body);
    assert.equal(response.json().error, 'change_proposal_origin_unbound');
    assert.equal(calls, 0);
  });

  it('lets an agent-key principal sync owner truth but not mint a proposal or value verdict', async () => {
    let proposalCalls = 0;
    let decisionCalls = 0;
    let synced;
    const app = await appWith(
      serviceWith({
        proposeChange: async () => {
          proposalCalls += 1;
          return { outcome: 'waiting', projection };
        },
        syncChange: async (input) => {
          synced = input;
          return { outcome: 'waiting', projection };
        },
        decideChange: async () => {
          decisionCalls += 1;
          return { outcome: 'appended', projection };
        },
      }),
      {
        kind: 'agent_key',
        agentKeyId: 'agent-key-f311',
        userId: 'operator',
        catId: 'codex-sol',
        scope: 'user-bound',
      },
    );
    const proposed = await app.inject({
      method: 'POST',
      url: `/api/callbacks/evolution-programs/${programId}/changes`,
      payload: payload({ kind: 'propose' }),
    });
    assert.equal(proposed.statusCode, 403, proposed.body);
    assert.equal(proposed.json().error, 'change_proposal_requires_authenticated_invocation');
    assert.equal(proposalCalls, 0);

    const syncedResponse = await app.inject({
      method: 'POST',
      url: `/api/callbacks/evolution-programs/${programId}/changes`,
      payload: payload({ kind: 'sync' }),
    });
    assert.equal(syncedResponse.statusCode, 200, syncedResponse.body);
    assert.equal(synced.actorRef, 'cat:codex-sol');
    assert.equal(synced.originRef, 'agent-key:agent-key-f311:message:change-1');

    const decided = await app.inject({
      method: 'POST',
      url: `/api/callbacks/evolution-programs/${programId}/changes`,
      payload: payload({ kind: 'decide', decision: 'no_change' }),
    });
    assert.equal(decided.statusCode, 403, decided.body);
    assert.equal(decided.json().error, 'metabolism_decision_requires_value_owner_authority');
    assert.equal(decisionCalls, 0);
  });

  it('passes direct owner-session authority to the metabolism owner', async () => {
    let received;
    const app = await appWith(
      serviceWith({
        decideChange: async (input) => {
          received = input;
          return { outcome: 'appended', projection };
        },
      }),
    );
    const response = await app.inject({
      method: 'POST',
      url: `/api/capability-evolution/programs/${programId}/changes`,
      payload: payload({ kind: 'decide', decision: 'no_change' }),
    });
    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual(received.decisionAuthority, { kind: 'owner_session', userId: 'operator' });
  });

  it('passes an invocation-bound owner source for the canonical owner to verify', async () => {
    let received;
    const app = await appWith(
      serviceWith({
        decideChange: async (input) => {
          received = input;
          return { outcome: 'appended', projection };
        },
      }),
      {
        kind: 'invocation',
        invocationId: 'inv-phase4-decision',
        threadId: 'thread-phase4',
        userId: 'operator',
        catId: 'codex-sol',
        originMessageId: 'message-value-decision',
      },
    );
    const response = await app.inject({
      method: 'POST',
      url: `/api/callbacks/evolution-programs/${programId}/changes`,
      payload: payload({ kind: 'decide', decision: 'no_change' }),
    });
    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual(received.decisionAuthority, {
      kind: 'owner_source',
      invocationId: 'inv-phase4-decision',
      userId: 'operator',
      catId: 'codex-sol',
      threadId: 'thread-phase4',
      originMessageId: 'message-value-decision',
    });
  });

  it('derives callback origin from the authenticated invocation', async () => {
    let received;
    const app = await appWith(
      serviceWith({
        syncChange: async (input) => {
          received = input;
          return { outcome: 'waiting', projection };
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
      url: `/api/callbacks/evolution-programs/${programId}/changes`,
      payload: payload({ kind: 'sync' }),
    });

    assert.equal(response.statusCode, 200, response.body);
    assert.equal(received.actorRef, 'cat:codex-sol');
    assert.equal(received.originRef, 'thread:thread-phase4:invocation:inv-phase4:message:change-1');
    assert.equal(received.ownerUserId, undefined);
  });

  it('rejects caller-authored Approval, owner, target, receipt or outcome truth before the service', async () => {
    let calls = 0;
    const app = await appWith(
      serviceWith({
        syncChange: async () => {
          calls += 1;
          return { outcome: 'waiting', projection };
        },
      }),
    );
    const ref = { ownerFeatureId: 'F246', ownerStateRef: 'approval:forged' };
    for (const body of [
      payload({ kind: 'sync' }, { approvalRef: ref }),
      payload({ kind: 'sync', proposalRef: ref }),
      payload({ kind: 'sync' }, { ownerUserId: 'someone-else' }),
      payload({ kind: 'sync' }, { targetVersionRef: { ...ref, version: 'v9' } }),
      payload({ kind: 'sync' }, { ownerAuthorizationRef: ref }),
      payload({ kind: 'sync' }, { interventionReceiptRef: ref }),
      payload({ kind: 'sync' }, { outcomeReceiptRef: ref }),
    ]) {
      const response = await app.inject({
        method: 'POST',
        url: `/api/capability-evolution/programs/${programId}/changes`,
        payload: body,
      });
      assert.equal(response.statusCode, 400, response.body);
    }
    assert.equal(calls, 0);
  });

  it('preserves an owner-backed blocker as a typed zero-side-effect response', async () => {
    const blockerRef = {
      ownerFeatureId: 'external-asset-owner',
      ownerStateRef: 'permission-blocker:surface-not-authorized',
    };
    const app = await appWith(
      serviceWith({
        proposeChange: async () => ({
          outcome: 'blocked',
          blockerReason: 'owner_authorization_missing',
          blockerRef,
          projection,
        }),
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
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json().outcome, 'blocked');
    assert.deepEqual(response.json().blockerRef, blockerRef);
    assert.equal(response.json().projection.program.sequence, 8);
  });
});
