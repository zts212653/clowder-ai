import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ApprovalIngress } from '../../../api/dist/domains/approval-hub/ApprovalIngress.js';
import { F193ApprovalAdapter } from '../../../api/dist/domains/approval-hub/adapters/F193ApprovalAdapter.js';
import { F221ApprovalAdapter } from '../../../api/dist/domains/approval-hub/adapters/F221ApprovalAdapter.js';
import { F260ApprovalAdapter } from '../../../api/dist/domains/approval-hub/adapters/F260ApprovalAdapter.js';
import { InMemoryDispatchProposalStore } from '../../../api/dist/domains/approval-hub/stores/ports/IDispatchProposalStore.js';
import { InMemoryEntityProposalStore } from '../../../api/dist/domains/approval-hub/stores/ports/IEntityProposalStore.js';
import { SqliteEvidenceStore } from '../../../api/dist/domains/memory/SqliteEvidenceStore.js';
import { InMemoryTasteProposalStore } from '../../../api/dist/domains/taste/stores/InMemoryTasteProposalStore.js';
import { buildDispatchProposalCardBlock } from '../../../api/dist/routes/dispatch-proposal-card-block.js';
import { dispatchProposalRoutes } from '../../../api/dist/routes/dispatch-proposal-routes.js';
import { buildEntityProposalCardBlock } from '../../../api/dist/routes/entity-proposal-card-block.js';
import { registerEntityProposalDecisionRoutes } from '../../../api/dist/routes/entity-proposal-decision-routes.js';
import { buildTasteProposalCardBlock } from '../../../api/dist/routes/taste-proposal-card-block.js';
import { registerTasteProposalDecisionRoutes } from '../../../api/dist/routes/taste-proposal-decision-routes.js';
import { createInboxProposalFixture } from './f322-inbox-proposal.fixture.mjs';

/** Real staged stores/Ingress/owner writers. Only this mkdtemp vignette/SQLite and these in-memory Messages are written. */
export async function createInboxInformationFixture(language) {
  return createInboxProposalFixture({
    configureApprovals: async ({ app, owner, messages, threads, socketManager }) => {
      const root = await mkdtemp(path.join(tmpdir(), 'f322-information-'));
      const dispatch = new InMemoryDispatchProposalStore(),
        taste = new InMemoryTasteProposalStore(),
        entity = new InMemoryEntityProposalStore();
      const registry = new SqliteEvidenceStore(path.join(root, 'entities.sqlite'));
      let failTasteFinalization = false;
      const finalizeTaste = taste.finalizeApproval.bind(taste);
      taste.finalizeApproval = (...args) => {
        if (failTasteFinalization) {
          failTasteFinalization = false;
          throw new Error('Owned fixture interruption after the original vignette checkpoint');
        }
        return finalizeTaste(...args);
      };
      try {
        await registry.initialize();
        const ingress = new ApprovalIngress({ messageStore: messages, socketManager });
        const target = threads.create(
          owner,
          language === 'en' ? 'Original destination discussion' : '原派活目标对话',
          'default',
        );
        const records = [],
          deliveries = [],
          vignettes = [];
        for (const verb of ['approve', 'reject', 'unknown']) {
          const thread = threads.create(
            owner,
            language === 'en' ? `Information proposals ${verb}` : `信息卡原操作 ${verb}`,
            'default',
          );
          const origin = messages.append({
            userId: owner,
            threadId: thread.id,
            from: { kind: 'user', userId: owner },
            content: 'Controlled original authorization',
            timestamp: Date.now(),
          });
          const originRef = { kind: 'message', threadId: thread.id, messageId: origin.id };
          const work = (
            await dispatch.create({
              proposalId: `information-dispatch-${verb}`,
              sourceInvocationId: `private-${verb}`,
              sourceThreadId: thread.id,
              targetThreadId: target.id,
              senderCatId: 'codex61-sol',
              ownerUserId: owner,
              targetCats: ['codex61-sol'],
              createdAt: Date.now(),
              approvalOriginRef: originRef,
              content:
                (language === 'en'
                  ? 'Check the original evidence and return the result.\n\n'
                  : '核对原证据并送回结果。\n\n') + '- Controlled original request.\n'.repeat(40),
            })
          ).proposal;
          const preference =
            verb === 'unknown'
              ? null
              : taste.create({
                  proposalId: `information-taste-${verb}`,
                  userId: owner,
                  catId: 'codex61-sol',
                  threadId: thread.id,
                  sourceMessageId: origin.id,
                  approvalOriginRef: originRef,
                  dimension: 'cognitive-honesty',
                  tags: ['evidence'],
                  privacy: 'public',
                  scene: language === 'en' ? 'Discussing how to describe verified work' : '讨论怎样说明已验证的工作',
                  takeaway: language === 'en' ? 'Explain the actual result first' : '先说明实际结果',
                  quote: 'Keep the original evidence.\n'.repeat(40),
                });
          const name = language === 'en' ? `Observable result ${verb}` : `可见结果 ${verb}`;
          const concept = entity.create({
            proposalId: `information-entity-${verb}`,
            entityId: `concept:information-${verb}`,
            entityType: 'concept',
            canonicalName: name,
            aliases: [language === 'en' ? `Verifiable outcome ${verb}` : `可核验结果 ${verb}`],
            stance: 'endorsed',
            visibilityScope: 'workspace',
            provenance: [{ source: 'thread', anchor: thread.id }],
            rationale: 'Keep a stable shared name.\n'.repeat(40),
            sourceThreadId: thread.id,
            sourceCatId: 'codex61-sol',
            ownerUserId: owner,
            approvalOriginRef: originRef,
          });
          for (const [kind, proposal, store, builder] of [
            ['F193', work, dispatch, buildDispatchProposalCardBlock],
            ['F221', preference, taste, buildTasteProposalCardBlock],
            ['F260', concept, entity, buildEntityProposalCardBlock],
          ]) {
            if (verb === 'unknown' && kind === 'F221') continue;
            const proposalId = proposal.proposalId ?? proposal.id;
            const envelope = await ingress.publish(
              {
                producerId: kind,
                canonicalProposalId: proposalId,
                ownerUserId: owner,
                requesterCatId: 'codex61-sol',
                originRef,
                cardThreadId: thread.id,
                cardContent: language === 'en' ? 'Please decide on this original proposal.' : '请决定这条原提议。',
                cardBlock: builder(proposal),
                createdAt: proposal.createdAt,
              },
              store,
            );
            const card = messages.getById(envelope.approvalCardRef.messageId);
            assert.ok(card);
            records.push({
              kind,
              verb,
              initiallySettled: verb === 'unknown',
              proposalId,
              thread,
              card,
              block: card.extra.rich.blocks[0],
              envelope,
            });
            // Exact approved-without-effect crash window: no delivery/upsert takes place.
            if (verb === 'unknown') {
              if (kind === 'F193') await dispatch.approve(proposalId, owner, 'strict');
              else entity.markApproved(proposalId, owner);
            }
          }
        }
        await app.register(dispatchProposalRoutes, {
          store: dispatch,
          rolloutState: 'shadow',
          notifyUpdate() {},
          deliverMessage: async (proposal) => {
            const delivered = messages.append({
              userId: owner,
              threadId: proposal.targetThreadId,
              from: { kind: 'agent', catId: proposal.senderCatId },
              content: proposal.content,
              timestamp: Date.now(),
            });
            deliveries.push({ proposalId: proposal.proposalId, messageId: delivered.id, threadId: delivered.threadId });
            return delivered.id;
          },
        });
        registerTasteProposalDecisionRoutes(app, {
          tasteProposalStore: taste,
          socketManager,
          writeVignette: async (proposal) => {
            const file = path.join(root, `${proposal.id}.md`);
            await writeFile(file, `${proposal.takeaway}\n${proposal.quote}`);
            vignettes.push({ proposalId: proposal.id, path: file });
            return { slug: proposal.id, path: file };
          },
        });
        registerEntityProposalDecisionRoutes(app, {
          store: entity,
          socketManager,
          upsertEntities: (values, context) => registry.upsertEntities(values, context),
          inspectEntityConflict: (incoming, viewer) => registry.inspectEntityConflict(incoming, viewer),
          resolveEntityConflict: (incoming, resolution, context) =>
            registry.resolveEntityConflict(incoming, resolution, context),
        });
        return {
          records,
          dispatch,
          taste,
          entity,
          deliveries,
          vignettes,
          target,
          async createSuperseded(thread) {
            const origin = messages.append({
              userId: owner,
              threadId: thread.id,
              from: { kind: 'user', userId: owner },
              content: 'Controlled same-lineage replacement',
              timestamp: Date.now(),
            });
            const published = [];
            for (const proposalId of ['superseded-original', 'superseding-current']) {
              const { proposal } = await dispatch.create({
                proposalId,
                sourceThreadId: thread.id,
                targetThreadId: target.id,
                senderCatId: 'codex61-sol',
                ownerUserId: owner,
                targetCats: ['codex61-sol'],
                createdAt: Date.now(),
                approvalOriginRef: { kind: 'message', threadId: thread.id, messageId: origin.id },
                content: 'This assignment was replaced by a newer request.',
              });
              const envelope = await ingress.publish(
                {
                  producerId: 'F193',
                  canonicalProposalId: proposalId,
                  ownerUserId: owner,
                  requesterCatId: 'codex61-sol',
                  originRef: proposal.approvalOriginRef,
                  cardThreadId: thread.id,
                  cardContent: 'Controlled replacement proposal',
                  cardBlock: buildDispatchProposalCardBlock(proposal),
                  createdAt: proposal.createdAt,
                },
                dispatch,
              );
              const card = messages.getById(envelope.approvalCardRef.messageId);
              published.push({ proposalId, card, block: card.extra.rich.blocks[0] });
            }
            return published;
          },
          failTasteFinalizationOnce() {
            failTasteFinalization = true;
          },
          adapters: [
            new F193ApprovalAdapter(dispatch),
            new F221ApprovalAdapter(taste),
            new F260ApprovalAdapter(entity, undefined, (p) =>
              registry.getEntityProposalEffectProof(p.entityId, p.proposalId, p.ownerUserId),
            ),
          ],
          async effects() {
            return {
              deliveries,
              targetMessages: messages.getByThread(target.id, 100, owner),
              vignettes: await Promise.all(
                vignettes.map(async (v) => ({ ...v, content: await readFile(v.path, 'utf8') })),
              ),
              entities: await Promise.all(
                records
                  .filter((r) => r.kind === 'F260')
                  .map((r) => registry.getEntity(`concept:information-${r.verb}`)),
              ),
            };
          },
          async close() {
            await registry.close();
            await rm(root, { recursive: true, force: true });
          },
        };
      } catch (error) {
        await registry.close();
        await rm(root, { recursive: true, force: true });
        throw error;
      }
    },
  });
}
