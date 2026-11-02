import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { ApprovalDecisionReceiptOutbox } from '../../../api/dist/domains/approval-hub/ApprovalDecisionReceiptOutbox.js';
import { ApprovalDecisionReceiptService } from '../../../api/dist/domains/approval-hub/ApprovalDecisionReceiptService.js';
import {
  ApprovalProducerRegistry,
  bindLegacyApprovalProducer,
} from '../../../api/dist/domains/approval-hub/ApprovalProducerRegistry.js';
import { F128ApprovalAdapter } from '../../../api/dist/domains/approval-hub/adapters/F128ApprovalAdapter.js';
import { installApprovalDecisionReceiptHooks } from '../../../api/dist/domains/approval-hub/approval-decision-receipt-hooks.js';
import { CALENDAR_THREAD } from './f310-work-calendar.fixture.mjs';
import { createInboxProposalFixture } from './f322-inbox-proposal.fixture.mjs';

/** Disposable native stores, original receipts and controlled history. It never connects to a runtime Redis or model. */
export async function createMailboxHistoryFixture(tree) {
  const outboxDb = new Database(':memory:');
  let fixture, service;
  const close = async () => {
    try {
      await service?.drain();
    } finally {
      try {
        await fixture?.close();
      } finally {
        outboxDb.close();
      }
    }
  };
  try {
    fixture = await createInboxProposalFixture({
      proposalProjectPath: tree,
      configureReceipts({ app, messages, threads, proposals }) {
        const registry = new ApprovalProducerRegistry({
          F128: bindLegacyApprovalProducer(new F128ApprovalAdapter(proposals, (id) => threads.get(id))),
        });
        service = new ApprovalDecisionReceiptService({
          registry,
          messageStore: messages,
          outbox: new ApprovalDecisionReceiptOutbox(outboxDb),
          logger: app.log,
        });
        installApprovalDecisionReceiptHooks(app, () => service);
      },
    });
    const owner = 'default-user';
    const origin = fixture.messages.append({
      userId: owner,
      threadId: CALENDAR_THREAD,
      from: { kind: 'user', userId: owner },
      content: '受控历史分页验收来源',
      timestamp: Date.now() - 86400000,
    });
    const fixedNow = Date.now() - 86400000,
      originalNow = Date.now;
    const expected = [];
    try {
      Date.now = () => fixedNow;
      for (let index = 0; index < 251; index++) {
        const p = fixture.proposals.create({
          proposalId: `history-${String(index).padStart(4, '0')}`,
          sourceThreadId: CALENDAR_THREAD,
          sourceInvocationId: `controlled-${index}`,
          sourceCatId: 'codex61-sol',
          sourceMessageId: origin.id,
          title: `分页原记录 ${index}`,
          reason: '真实原 store 的拒绝结果；不是用户生产记录',
          parentThreadId: CALENDAR_THREAD,
          preferredCats: ['codex61-sol'],
          projectPath: tree,
          createdBy: owner,
        });
        const card = fixture.messages.append({
          userId: owner,
          threadId: CALENDAR_THREAD,
          from: { kind: 'agent', catId: 'codex61-sol' },
          content: p.title,
          timestamp: fixedNow,
        });
        fixture.proposals.commitEnvelope(p.proposalId, {
          canonicalProposalId: p.proposalId,
          sourceFeatureId: 'F128',
          ownerUserId: owner,
          requesterCatId: 'codex61-sol',
          createdAt: p.createdAt,
          originRef: { kind: 'message', threadId: CALENDAR_THREAD, messageId: origin.id },
          approvalCardRef: { threadId: CALENDAR_THREAD, messageId: card.id },
        });
        assert.ok(fixture.proposals.markRejected({ proposalId: p.proposalId, rejectedBy: owner }));
        expected.push(p.proposalId);
      }
    } finally {
      Date.now = originalNow;
    }
    for (const title of ['待核对的原件', '稍后再处理的请求']) {
      const thread = fixture.threads.create(owner, title, tree);
      fixture.messages.append({
        userId: owner,
        threadId: thread.id,
        from: { kind: 'agent', catId: 'codex61-sol' },
        mentionsUser: true,
        content: `@co-creator\n${title}`,
        timestamp: Date.now(),
      });
    }

    return {
      ...fixture,
      owner,
      origin,
      expected,
      close,
      appendLiveHistory() {
        const live = fixture.proposals.create({
          proposalId: 'history-live-head',
          sourceThreadId: CALENDAR_THREAD,
          sourceInvocationId: 'controlled-live',
          sourceCatId: 'codex61-sol',
          sourceMessageId: origin.id,
          title: '新来的历史原记录',
          reason: 'Controlled canonical insertion',
          parentThreadId: CALENDAR_THREAD,
          preferredCats: ['codex61-sol'],
          projectPath: tree,
          createdBy: owner,
        });
        fixture.proposals.commitEnvelope(live.proposalId, {
          canonicalProposalId: live.proposalId,
          sourceFeatureId: 'F128',
          ownerUserId: owner,
          requesterCatId: 'codex61-sol',
          createdAt: live.createdAt,
          originRef: { kind: 'message', threadId: CALENDAR_THREAD, messageId: origin.id },
          approvalCardRef: { threadId: CALENDAR_THREAD, messageId: origin.id },
        });
        fixture.proposals.markRejected({
          proposalId: live.proposalId,
          rejectedBy: owner,
          rejectionReason: 'Controlled insertion',
        });
        return live;
      },
    };
  } catch (error) {
    await close();
    throw error;
  }
}
