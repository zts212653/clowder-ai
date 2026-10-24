import assert from 'node:assert/strict';
import { test } from 'node:test';
import { APPROVAL_PRODUCER_IDS, approvalProducerMeta } from '@cat-cafe/shared';
import Database from 'better-sqlite3';
import Fastify from 'fastify';
import { ApprovalDecisionReceiptOutbox } from '../../dist/domains/approval-hub/ApprovalDecisionReceiptOutbox.js';
import { ApprovalDecisionReceiptService } from '../../dist/domains/approval-hub/ApprovalDecisionReceiptService.js';
import {
  ApprovalProducerRegistry,
  bindLegacyApprovalProducer,
  bindV1ApprovalProducer,
} from '../../dist/domains/approval-hub/ApprovalProducerRegistry.js';
import { installApprovalDecisionReceiptHooks } from '../../dist/domains/approval-hub/approval-decision-receipt-hooks.js';
import { assembleContext } from '../../dist/domains/cats/services/context/ContextAssembler.js';
import { isDisplayOnlySystemMessage } from '../../dist/domains/cats/services/stores/host-message-policy.js';
import { MessageStore } from '../../dist/domains/cats/services/stores/ports/MessageStore.js';
import { applyMigrations } from '../../dist/domains/memory/schema.js';
import { redisIsolationSkipReason } from '../helpers/redis-test-helpers.js';
import { CARD_THREAD, createProducer, OWNER, REASON, SECRET } from './decision-receipt-producer-fixtures.js';

// The catalog drives this suite. A new producer without a real canonical fixture
// or exact reader fails, rather than inheriting a silent notification exemption.
for (const producerId of APPROVAL_PRODUCER_IDS) {
  for (const action of ['approve', 'reject']) {
    test(
      `${producerId} ${action}: canonical decision -> one durable receipt -> next invocation`,
      {
        skip: producerId === 'F276' ? redisIsolationSkipReason(process.env.REDIS_URL) : false,
      },
      async (t) => {
        const db = new Database(':memory:');
        t.after(() => db.close());
        applyMigrations(db);
        const { adapter, id, settle, expectedDecisionTimes } = await createProducer(producerId, db, t);
        const meta = approvalProducerMeta(producerId);
        assert.equal(meta.decisionReceipt.mode, 'shared-origin-thread');
        assert.match(meta.decisionReceipt.routePrefix ?? meta.decisionEndpointBase, /^\/api\//);
        const bind = producerId === 'F266' ? bindV1ApprovalProducer : bindLegacyApprovalProducer;
        const registry = new ApprovalProducerRegistry({ [producerId]: bind(adapter) });
        const messageStore = new MessageStore();
        const outbox = new ApprovalDecisionReceiptOutbox(db);
        const warnings = [];
        const options = { registry, messageStore, outbox, logger: { warn: (...args) => warnings.push(args) } };
        const service = new ApprovalDecisionReceiptService(options);
        const subject = { ownerUserId: OWNER, producerId, canonicalProposalId: id };
        service.prepare(subject);
        assert.equal(await service.deliver(subject), false, 'an in-flight decision retains its delivery intent');
        assert.equal(outbox.list().length, 1);
        const app = Fastify();
        t.after(() => app.close());
        app.decorateRequest('sessionUserId', undefined);
        app.addHook('onRequest', async (request) => {
          request.sessionUserId = OWNER;
        });
        installApprovalDecisionReceiptHooks(app, () => service);
        const base = meta.decisionReceipt.routePrefix ?? meta.decisionEndpointBase;
        app.post(`${base}/:proposalId/${action}`, async () => {
          await settle(action);
          return { ok: true };
        });
        const response = await app.inject({ method: 'POST', url: `${base}/${encodeURIComponent(id)}/${action}` });
        assert.equal(response.statusCode, 200);
        assert.equal(response.headers['x-approval-receipt-status'], 'complete');
        const decision = await adapter.readDecision(OWNER, id);
        assert.equal(decision.state, 'decided', 'exercise the actual canonical producer transition');
        assert.equal(decision.item.status, action === 'approve' ? 'approved' : 'rejected');
        assert.deepEqual(await adapter.readDecision('foreign-owner', id), { state: 'closed' });

        await Promise.all(Array.from({ length: 6 }, () => service.deliver(subject)));
        service.prepare(subject); // repeated HTTP request / lost response
        assert.equal(await new ApprovalDecisionReceiptService(options).recover(), true);
        const messages = await messageStore.getByThread(CARD_THREAD, 50, OWNER);
        assert.equal(messages.length, 1);
        const [message] = messages;
        assert.deepEqual(message.mentions, [], 'a durable receipt does not dispatch or wake a cat');
        assert.equal(message.from.kind, 'system');
        assert.equal(message.source.meta.approvalDecisionReceipt.canonicalProposalId, id);
        assert.equal(message.source.meta.approvalDecisionReceipt.producerId, producerId);
        const resolution = action === 'approve' ? 'accepted' : 'rejected';
        assert.equal(message.source.meta.approvalDecisionReceipt.resolution, resolution);
        if (expectedDecisionTimes)
          assert.equal(message.source.meta.approvalDecisionReceipt.decidedAt, expectedDecisionTimes[action]);
        assert.equal(JSON.stringify(message).includes(SECRET), false, 'never copy the proposal body or summary');
        assert.equal((await messageStore.getByThread('original-source-thread')).length, 0);
        const result = action === 'approve' ? '已批准' : '已拒绝';
        assert.match(assembleContext(messages).contextText, new RegExp(result));
        assert.equal(isDisplayOnlySystemMessage(message), false);
        assert.equal(isDisplayOnlySystemMessage({ ...message, from: { kind: 'system', service: 'unrelated' } }), true);
        assert.equal(isDisplayOnlySystemMessage({ ...message, source: { ...message.source, meta: {} } }), true);
        if (action === 'reject' && !['F193', 'F306'].includes(producerId))
          assert.match(message.content, new RegExp(REASON));
        assert.deepEqual(outbox.list(), []);
        assert.deepEqual(warnings, []);
      },
    );
  }
}

test('receipt runtime refuses a producer with no exact canonical reader', () => {
  const registry = new ApprovalProducerRegistry({
    F139: bindLegacyApprovalProducer({
      featureId: 'F139',
      listPending: () => [],
      listSettled: () => [],
    }),
  });
  assert.throws(() => new ApprovalDecisionReceiptService({ registry }), /lacks an exact canonical.*reader/);
});
