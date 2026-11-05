import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRedisClient } from '@cat-cafe/shared/utils';
import { ApprovalIngress } from '../../../api/dist/domains/approval-hub/ApprovalIngress.js';
import { F276ApprovalAdapter } from '../../../api/dist/domains/approval-hub/adapters/F276ApprovalAdapter.js';
import { PersonMemoryKeys } from '../../../api/dist/domains/memory/people/person-memory-keys.js';
import { RedisPersonMemoryStore } from '../../../api/dist/domains/memory/people/RedisPersonMemoryStore.js';
import { registerPersonMemoryDecisionRoutes } from '../../../api/dist/routes/person-memory-decision-routes.js';
import { buildPersonMemoryProposalCard } from '../../../api/dist/routes/person-memory-proposal-card.js';
import { cleanupClientKeyspace } from '../../../api/test/helpers/redis-test-helpers.js';
import { createPersonMemoryReplacement } from './f322-inbox-person-memory-replacement.fixture.mjs';
import { createInboxProposalFixture } from './f322-inbox-proposal.fixture.mjs';

/** Real F276 Lua persistence on development6398/db15, unique owned namespace, no production data/provider. */
export async function createInboxPersonMemoryFixture(language) {
  return createInboxProposalFixture({
    configureApprovals: async ({ app, owner, messages, threads, socketManager }) => {
      const prefix = `f322-person-native:${randomUUID()}:`;
      const redis = createRedisClient({ url: 'redis://127.0.0.1:6398/15', keyPrefix: prefix });
      const store = new RedisPersonMemoryStore(redis),
        records = [];
      const close = async () => {
        try {
          await cleanupClientKeyspace(redis);
        } finally {
          await redis.quit();
        }
      };
      try {
        await redis.ping();
        const ingress = new ApprovalIngress({ messageStore: messages, socketManager });
        for (const entrance of ['Chat', 'Inbox']) {
          const thread = threads.create(owner, `${entrance} person memory`, 'default');
          for (const verb of ['approve', 'reject']) {
            const source = messages.append({
              userId: owner,
              threadId: thread.id,
              from: { kind: 'user', userId: owner },
              content: language === 'en' ? 'Lin enjoys hiking and lives in Hangzhou.' : '林喜欢爬山，住在杭州。',
              timestamp: Date.now(),
            });
            const proposalId = `person_candidate_${entrance.toLowerCase()}_${verb}`;
            const draftIds = [
              `person_draft_${entrance.toLowerCase()}_${verb}_hobby`,
              `person_draft_${entrance.toLowerCase()}_${verb}_city`,
            ];
            const staged = await store.stageCandidate({
              candidateId: proposalId,
              ownerUserId: owner,
              requesterCatId: 'codex61-sol',
              sourceMessageRef: { kind: 'message', threadId: thread.id, messageId: source.id },
              personDraft: { displayName: `Lin ${entrance} ${verb}`, privateAliases: [`Lin ${entrance} ${verb}`] },
              claimDrafts: draftIds.map((draftId, index) => ({
                draftId,
                payload: {
                  kind: 'reported_fact',
                  predicate: index === 0 ? 'hobby' : 'home_city',
                  value: index === 0 ? 'hiking' : 'Hangzhou',
                  assertedBy: 'owner',
                },
                normalizedDraft:
                  language === 'en'
                    ? index === 0
                      ? 'Lin enjoys hiking'
                      : 'Lin lives in Hangzhou'
                    : index === 0
                      ? '林喜欢爬山'
                      : '林住在杭州',
                sourceRole: 'owner_explicit',
                evidenceExcerpt: source.content,
                decision: 'pending',
              })),
              remainingDraftIds: draftIds,
              retention: 'owner_controlled_no_ttl',
              createdAt: Date.now(),
            });
            const envelope = await ingress.publish(
              {
                producerId: 'F276',
                canonicalProposalId: proposalId,
                ownerUserId: owner,
                requesterCatId: 'codex61-sol',
                originRef: staged.sourceMessageRef,
                cardThreadId: thread.id,
                cardContent: language === 'en' ? 'Choose the exact drafts to remember.' : '逐条选择要记住的内容。',
                cardBlock: buildPersonMemoryProposalCard(staged),
                createdAt: staged.createdAt,
              },
              store,
            );
            const message = messages.getById(envelope.approvalCardRef.messageId);
            assert.ok(message);
            records.push({
              entrance,
              verb,
              thread,
              proposalId,
              draftIds,
              envelope,
              block: message.extra.rich.blocks[0],
            });
          }
        }
        registerPersonMemoryDecisionRoutes(app, { store, socketManager });
        return {
          records,
          store,
          redis,
          prefix,
          adapters: [new F276ApprovalAdapter(store)],
          createReplacement: (thread) =>
            createPersonMemoryReplacement({ language, owner, thread, messages, store, ingress }),
          async effects() {
            return Promise.all(
              records.map(async (r) => {
                const candidate = await store.getCandidateForOwner(owner, r.proposalId);
                const claimKeys = await redis.keys(`${prefix}${PersonMemoryKeys.claim(owner, '')}*`);
                const claims = await Promise.all(
                  claimKeys.map(async (key) => JSON.parse(await redis.get(key.slice(prefix.length)))),
                );
                return {
                  proposalId: r.proposalId,
                  candidate,
                  candidateTtl: await redis.ttl(PersonMemoryKeys.candidate(owner, r.proposalId)),
                  claims: claims.filter((c) => c.materializedBy?.candidateId === r.proposalId),
                  relationships: candidate.materializedPersonId
                    ? await store.listRelationships(owner, candidate.materializedPersonId)
                    : [],
                };
              }),
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
