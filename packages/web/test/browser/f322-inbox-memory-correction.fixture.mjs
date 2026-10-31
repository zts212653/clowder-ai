import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ApprovalIngress } from '../../../api/dist/domains/approval-hub/ApprovalIngress.js';
import { F321ApprovalAdapter } from '../../../api/dist/domains/approval-hub/adapters/F321ApprovalAdapter.js';
import { SessionMutex } from '../../../api/dist/domains/cats/services/agents/invocation/SessionMutex.js';
import { EventMemoryStore, eventMemoryRevision } from '../../../api/dist/domains/memory/EventMemoryStore.js';
import { EventMemoryLifecycleService } from '../../../api/dist/domains/memory/event/EventMemoryLifecycleService.js';
import { InMemoryEventMemoryCorrectionProposalStore } from '../../../api/dist/domains/memory/event/InMemoryEventMemoryCorrectionProposalStore.js';
import {
  InMemoryOwnerMemoryActionReceiptStore,
  OwnerMemoryActionCoordinator,
} from '../../../api/dist/domains/memory/owner/OwnerMemoryActionCoordinator.js';
import { buildEventMemoryCorrectionCardBlock } from '../../../api/dist/routes/event-memory-correction-card-block.js';
import { registerEventMemoryCorrectionDecisionRoutes } from '../../../api/dist/routes/event-memory-correction-decision-routes.js';
import { readEventMemorySource } from '../../../api/dist/routes/event-memory-source.js';
import { eventsRoutes } from '../../../api/dist/routes/events.js';
import { createInboxProposalFixture } from './f322-inbox-proposal.fixture.mjs';

/** Real owner session/CSRF, original Ingress/adapters/writer, and a private SQLite event store. No Redis/provider. */
export async function createInboxMemoryCorrectionFixture(language, { withRecovery = false } = {}) {
  return createInboxProposalFixture({
    configureApprovals: async ({ app, owner, messages, threads, socketManager }) => {
      const directory = await mkdtemp(path.join(tmpdir(), 'f322-correction-'));
      const events = new EventMemoryStore(path.join(directory, 'events.sqlite'));
      const proposals = new InMemoryEventMemoryCorrectionProposalStore();
      let failFinalization = false;
      const finalize = proposals.finalizeApproval.bind(proposals);
      proposals.finalizeApproval = async (...args) => {
        if (failFinalization) {
          failFinalization = false;
          throw new Error('Owned fixture interruption after the original SQLite effect');
        }
        return finalize(...args);
      };
      // EventMemoryStore has no public close port. This test owns its actual SQLite handle and releases only that handle.
      const close = async () => {
        events.db?.close();
        await rm(directory, { recursive: true, force: true });
      };
      try {
        await events.initialize();
        const ingress = new ApprovalIngress({ messageStore: messages, socketManager });
        const coordinator = new OwnerMemoryActionCoordinator({
          store: new InMemoryOwnerMemoryActionReceiptStore(),
          lock: new SessionMutex(),
        });
        const lifecycle = new EventMemoryLifecycleService({
          store: events,
          coordinator,
          sourceAvailable: async (event) =>
            (await readEventMemorySource(event, owner, { threadStore: threads, messageStore: messages })).status ===
            'ready',
        });
        const records = [];
        for (const verb of withRecovery ? ['approve', 'reject', 'recover'] : ['approve', 'reject']) {
          const thread = threads.create(
            owner,
            language === 'en' ? `Memory correction ${verb}` : `记忆纠错 ${verb}`,
            'default',
          );
          const origin = messages.append({
            userId: owner,
            threadId: thread.id,
            from: { kind: 'user', userId: owner },
            content:
              language === 'en' ? 'Check the original evidence before interpreting it.' : '解释之前先检查原证据。',
            timestamp: Date.now(),
          });
          const previous = events.markEvent(
            {
              type: 'cat_declared',
              trigger: 'human_brake',
              cat: 'codex61-sol',
              threadId: thread.id,
              messageId: origin.id,
              timestamp: origin.timestamp,
              summary:
                (language === 'en' ? 'The original explanation.' : '原来的解释。') +
                '\nOriginal bounded source.\n'.repeat(45),
              cognitiveTransition: 'scope_correction',
              relatedHarness: ['F321'],
              confidence: 'high',
            },
            owner,
          ).event;
          assert.ok(previous);
          const proposal = await proposals.create({
            proposalId: `memory-correction-${verb}`,
            eventId: previous.eventId,
            expectedRevision: eventMemoryRevision(previous),
            reason: 'outdated',
            suggestedPatch: {
              summary:
                (language === 'en' ? 'The corrected explanation.' : '核实后的解释。') +
                '\nVerified bounded change.\n'.repeat(45),
              confidence: 'mid',
            },
            ownerUserId: owner,
            sourceCatId: 'codex61-sol',
            sourceThreadId: thread.id,
            sourceInvocationId: `private-${verb}`,
            source: { threadId: thread.id, messageId: origin.id },
            clientRequestId: `private-${verb}`,
            approvalOriginRef: { kind: 'message', threadId: thread.id, messageId: origin.id },
          });
          const envelope = await ingress.publish(
            {
              producerId: 'F321',
              canonicalProposalId: proposal.proposalId,
              ownerUserId: owner,
              requesterCatId: proposal.sourceCatId,
              originRef: proposal.approvalOriginRef,
              cardThreadId: thread.id,
              cardContent: language === 'en' ? 'Please check this suggested correction.' : '请核对这条纠正建议。',
              cardBlock: buildEventMemoryCorrectionCardBlock(proposal),
              createdAt: proposal.createdAt,
            },
            proposals,
          );
          const card = messages.getById(envelope.approvalCardRef.messageId);
          assert.ok(card);
          records.push({
            verb,
            proposalId: proposal.proposalId,
            eventId: previous.eventId,
            previous,
            thread,
            card,
            block: card.extra.rich.blocks[0],
            envelope,
          });
        }
        await app.register(eventsRoutes, {
          eventMemoryStore: events,
          lifecycleService: lifecycle,
          correctionProposalStore: proposals,
          threadStore: threads,
          messageStore: messages,
        });
        registerEventMemoryCorrectionDecisionRoutes(app, { store: proposals, lifecycle, socketManager });
        return {
          records,
          events,
          proposals,
          adapters: [new F321ApprovalAdapter(proposals)],
          failFinalizationOnce() {
            failFinalization = true;
          },
          async effects() {
            return Promise.all(
              records.map(async (r) => ({
                verb: r.verb,
                proposal: await proposals.get(r.proposalId),
                event: events.getEvent(r.eventId),
                evidence: events.getOwnerActionEvidence(r.eventId, owner, `event-correction-proposal:${r.proposalId}`),
              })),
            );
          },
          close,
        };
      } catch (error) {
        await close();
        throw error;
      }
    },
  });
}
