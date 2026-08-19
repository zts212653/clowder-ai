/**
 * F167 — the system-origin exemption, exercised through real callback routes.
 *
 * Why this file exists (@codex-luna PR #1349 P2, and the clowder-ai maintainer on #1347):
 * approval-ingress.test.js proves the exemption against FABRICATED drafts. A fabricated
 * draft cannot show that a producer's real adapter ever puts the scheduler's wake row into
 * originRef — and that gap already produced a wrong test once: the original negative case
 * asserted rejection for F128, a producer that DOES bind, so it pinned a regression of the
 * very 500 this branch removes, and its green read as confirmation.
 *
 * So nothing here is constructed at the ingress boundary. Each case drives the real HTTP
 * route, authenticated by a real InvocationRegistry record, whose origin trigger is a real
 * scheduler wake row appended the way infrastructure/scheduler/delivery.ts appends it.
 *
 * The five `server_attested` producers must publish. F221 — deliberately `forbidden` — must
 * still be rejected on the identical path, which is what keeps the exemption a boundary
 * rather than a blanket.
 */

import '../helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import Fastify from 'fastify';
import { proposedReviewAction } from './helpers.js';
import {
  appendSchedulerWakeRow,
  assertAnchoredToWakeRow,
  CAT,
  load,
  OWNER,
  post,
  schedulerWokenAuth,
  socket,
} from './scheduler-origin-callback-fixtures.js';

describe('F167 scheduler-origin exemption over real callback routes', () => {
  it('F225 — a timer-woken session can hand off (the exact failure this branch removes)', async () => {
    const { InvocationRegistry } = await load('domains/cats/services/agents/invocation/InvocationRegistry');
    const { MessageStore } = await load('domains/cats/services/stores/ports/MessageStore');
    const { InMemorySessionHandoffProposalStore } = await load(
      'domains/cats/services/stores/ports/SessionHandoffProposalStore',
    );
    const { callbacksRoutes } = await load('routes/index');

    const registry = new InvocationRegistry();
    const messageStore = new MessageStore();
    const store = new InMemorySessionHandoffProposalStore();
    const session = { id: 'sess_active', status: 'active', catId: CAT, threadId: 'thread_1', userId: OWNER };

    const app = Fastify();
    await app.register(callbacksRoutes, {
      registry,
      messageStore,
      socketManager: socket(),
      handoffProposalStore: store,
      sessionChainStore: {
        getActive: async (catId, threadId) =>
          catId === session.catId && threadId === session.threadId ? session : null,
      },
      evidenceStore: { ingestRaw() {}, search: () => [] },
      markerQueue: { enqueue() {} },
      reflectionService: { reflect() {} },
    });
    await app.ready();

    try {
      const wake = await appendSchedulerWakeRow(messageStore, 'thread_1');
      const auth = await schedulerWokenAuth(registry, 'thread_1', wake.id);

      const res = await post(app, '/api/callbacks/propose-session-handoff', auth, {
        done: 'ran long enough to be driven by the timer',
        nextSteps: 'hand the rest to the next session',
      });

      assert.equal(res.statusCode, 200, res.body);
      assert.equal(res.json().status, 'pending');
      await assertAnchoredToWakeRow(store, res.json().proposalId, 'thread_1', wake);
    } finally {
      await app.close();
    }
  });

  it('F128 — a scheduler-woken turn can propose a thread', async () => {
    const { InvocationRegistry } = await load('domains/cats/services/agents/invocation/InvocationRegistry');
    const { MessageStore } = await load('domains/cats/services/stores/ports/MessageStore');
    const { ThreadStore } = await load('domains/cats/services/stores/ports/ThreadStore');
    const { InMemoryProposalStore } = await load('domains/cats/services/stores/ports/ProposalStore');
    const { callbacksRoutes } = await load('routes/index');

    const registry = new InvocationRegistry();
    const messageStore = new MessageStore();
    const threadStore = new ThreadStore();
    const store = new InMemoryProposalStore();
    const source = await threadStore.create(OWNER, 'Source');

    const app = Fastify();
    await app.register(callbacksRoutes, {
      registry,
      messageStore,
      socketManager: socket(),
      threadStore,
      proposalStore: store,
      evidenceStore: { ingestRaw() {}, search: () => [] },
      markerQueue: { enqueue() {} },
      reflectionService: { reflect() {} },
    });
    await app.ready();

    try {
      const wake = await appendSchedulerWakeRow(messageStore, source.id);
      const auth = await schedulerWokenAuth(registry, source.id, wake.id);

      const res = await post(app, '/api/callbacks/propose-thread', auth, {
        title: 'Split the timer-driven work out',
        reason: 'The wake turn found a second track worth its own thread',
      });

      assert.equal(res.statusCode, 200, res.body);
      await assertAnchoredToWakeRow(store, res.json().proposalId, source.id, wake);
    } finally {
      await app.close();
    }
  });

  it('F193 — a scheduler-woken turn can propose a cross-thread dispatch', async () => {
    const { ApprovalIngress } = await load('domains/approval-hub/ApprovalIngress');
    const { InvocationRegistry } = await load('domains/cats/services/agents/invocation/InvocationRegistry');
    const { MessageStore } = await load('domains/cats/services/stores/ports/MessageStore');
    const { ThreadStore } = await load('domains/cats/services/stores/ports/ThreadStore');
    const { InMemoryDispatchProposalStore } = await load('domains/approval-hub/stores/ports/IDispatchProposalStore');
    const { callbacksRoutes } = await load('routes/callbacks');

    const registry = new InvocationRegistry();
    const messageStore = new MessageStore();
    const threadStore = new ThreadStore();
    const store = new InMemoryDispatchProposalStore();
    const source = await threadStore.create(OWNER, 'Source');
    const target = await threadStore.create(OWNER, 'Target');
    await threadStore.addParticipants(source.id, [CAT]);
    await threadStore.addParticipants(target.id, ['sonnet']);

    const app = Fastify();
    await app.register(callbacksRoutes, {
      registry,
      messageStore,
      threadStore,
      socketManager: socket(),
      router: { async *routeExecution() {}, getExecutions: () => [] },
      invocationRecordStore: { create: () => ({ outcome: 'created' }), update() {}, get: () => null },
      dispatchProposalStore: store,
      approvalIngress: new ApprovalIngress({ messageStore, socketManager: socket() }),
    });
    await app.ready();

    try {
      const wake = await appendSchedulerWakeRow(messageStore, source.id);
      const auth = await schedulerWokenAuth(registry, source.id, wake.id);

      const res = await post(app, '/api/callbacks/post-message', auth, {
        threadId: target.id,
        content: '@sonnet\nThe timer woke me and this needs another pair of paws',
        targetCats: ['sonnet'],
        effectClass: 'assign_work',
        proposedAction: proposedReviewAction(),
        clientMessageId: 'f167-scheduler-origin-dispatch',
      });

      assert.equal(res.statusCode, 200, res.body);
      const [proposal] = await store.listPendingByUser(OWNER);
      assert.ok(proposal, 'the dispatch intercept must have created a proposal');
      await assertAnchoredToWakeRow(store, proposal.proposalId, source.id, wake);
    } finally {
      await app.close();
    }
  });

  it('F231 — a scheduler-woken turn can propose a profile update', async () => {
    const { InvocationRegistry } = await load('domains/cats/services/agents/invocation/InvocationRegistry');
    const { MessageStore } = await load('domains/cats/services/stores/ports/MessageStore');
    const { InMemoryProfileUpdateProposalStore } = await load(
      'domains/cats/services/stores/ports/ProfileUpdateProposalStore',
    );
    const { FileProfileRepository } = await load('domains/cats/services/profile/ProfileRepository');
    const { registerCallbackAuthHook } = await load('routes/callback-auth-prehandler');
    const { registerCallbackProposeProfileUpdateRoutes } = await load('routes/callback-propose-profile-update-routes');

    const registry = new InvocationRegistry();
    const messageStore = new MessageStore();
    const store = new InMemoryProfileUpdateProposalStore();
    const dataDir = mkdtempSync(join(tmpdir(), 'f167-scheduler-origin-'));

    const app = Fastify();
    registerCallbackAuthHook(app, registry);
    registerCallbackProposeProfileUpdateRoutes(app, {
      registry,
      proposalStore: store,
      messageStore,
      socketManager: socket(),
      repository: new FileProfileRepository({ dataDir, relationshipKeyForCat: () => 'ragdoll' }),
    });
    await app.ready();

    try {
      const wake = await appendSchedulerWakeRow(messageStore, 'thread_1');
      const auth = await schedulerWokenAuth(registry, 'thread_1', wake.id);

      const res = await post(app, '/api/callbacks/propose-profile-update', auth, {
        afterContent: 'NEW primer written during a timer-driven turn',
        rationale: 'Observed while the scheduler had the ball',
        signalKind: 'cat-declared',
      });

      assert.equal(res.statusCode, 200, res.body);
      const [proposal] = await store.listPending(OWNER);
      assert.ok(proposal, 'the profile-update route must have created a proposal');
      await assertAnchoredToWakeRow(store, proposal.proposalId, 'thread_1', wake);
    } finally {
      await app.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('F260 — a scheduler-woken turn can propose an entity', async () => {
    const { ApprovalIngress } = await load('domains/approval-hub/ApprovalIngress');
    const { InvocationRegistry } = await load('domains/cats/services/agents/invocation/InvocationRegistry');
    const { MessageStore } = await load('domains/cats/services/stores/ports/MessageStore');
    const { InMemoryEntityProposalStore } = await load('domains/approval-hub/stores/ports/IEntityProposalStore');
    const { callbackProposeEntityRoutes } = await load('routes/callback-propose-entity-routes');

    const registry = new InvocationRegistry();
    const messageStore = new MessageStore();
    const store = new InMemoryEntityProposalStore();

    const app = Fastify();
    await app.register(callbackProposeEntityRoutes, {
      registry,
      entityProposalStore: store,
      messageStore,
      socketManager: socket(),
      approvalIngress: new ApprovalIngress({ messageStore, socketManager: socket() }),
    });
    await app.ready();

    try {
      const wake = await appendSchedulerWakeRow(messageStore, 'thread_1');
      const auth = await schedulerWokenAuth(registry, 'thread_1', wake.id);

      const res = await post(app, '/api/callbacks/propose-entity', auth, {
        entityId: 'concept:hold-ball-wake',
        entityType: 'concept',
        canonicalName: 'Hold-ball wake',
        aliases: ['持球唤醒'],
        stance: 'endorsed',
        visibilityScope: 'workspace',
        provenance: [{ source: 'f167-scheduler-origin-integration' }],
        rationale: 'Named during a timer-driven turn',
        clientRequestId: 'f167-scheduler-origin-entity',
      });

      assert.equal(res.statusCode, 200, res.body);
      await assertAnchoredToWakeRow(store, res.json().proposalId, 'thread_1', wake);
    } finally {
      await app.close();
    }
  });

  it('F221 — a producer whose adapter permits a body-chosen origin gets no exemption on the same path', async () => {
    // Not "this request's origin is unbound" — here it comes off the record exactly as F225's
    // does. The catalog gate is per PRODUCER, not per request: F221's deriveTasteOriginRef
    // prefers a body-supplied sourceMessageId with no equality check, so no request of its
    // shape can be attested. This is the negative the earlier fabricated-F128 case should
    // have been, and it is the case that dies if anyone widens the exemption back to global.
    const { ApprovalIngress } = await load('domains/approval-hub/ApprovalIngress');
    const { InvocationRegistry } = await load('domains/cats/services/agents/invocation/InvocationRegistry');
    const { MessageStore } = await load('domains/cats/services/stores/ports/MessageStore');
    const { InMemoryTasteProposalStore } = await load('domains/taste/stores/InMemoryTasteProposalStore');
    const { callbackProposeTasteRoutes } = await load('routes/callback-propose-taste-routes');

    const registry = new InvocationRegistry();
    const messageStore = new MessageStore();
    const store = new InMemoryTasteProposalStore();

    const app = Fastify();
    await app.register(callbackProposeTasteRoutes, {
      registry,
      tasteProposalStore: store,
      socketManager: socket(),
      approvalIngress: new ApprovalIngress({ messageStore, socketManager: socket() }),
    });
    await app.ready();

    try {
      const wake = await appendSchedulerWakeRow(messageStore, 'thread_1');
      const auth = await schedulerWokenAuth(registry, 'thread_1', wake.id);

      const res = await post(app, '/api/callbacks/propose-taste', auth, {
        scene: 'A timer-driven turn tried to record a taste',
        quote: 'The exemption must not follow the origin across producers',
        tags: ['cognitive-honesty'],
        dimension: 'cognitive-honesty',
        privacy: 'public',
        clientRequestId: 'f167-scheduler-origin-taste',
      });

      assert.ok(res.statusCode >= 500, `expected the ingress to reject, got ${res.statusCode}`);
      assert.match(
        res.body,
        /owner mismatch/i,
        'must fail on the owner check specifically — any other 500 would pass this case for the wrong reason',
      );
      for (const proposal of await store.listPending(OWNER)) {
        assert.notEqual((await store.getPublication(proposal.id))?.state, 'anchored');
      }
    } finally {
      await app.close();
    }
  });
});
