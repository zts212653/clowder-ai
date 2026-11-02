import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { F225ApprovalAdapter } from '../../../api/dist/domains/approval-hub/adapters/F225ApprovalAdapter.js';
import { F231ApprovalAdapter } from '../../../api/dist/domains/approval-hub/adapters/F231ApprovalAdapter.js';
import { InvocationQueue } from '../../../api/dist/domains/cats/services/agents/invocation/InvocationQueue.js';
import { SessionMutex } from '../../../api/dist/domains/cats/services/agents/invocation/SessionMutex.js';
import { FileProfileRepository } from '../../../api/dist/domains/cats/services/profile/ProfileRepository.js';
import { hashContent } from '../../../api/dist/domains/cats/services/profile/writeProfileUpdate.js';
import { buildHandoffProposalCardBlock } from '../../../api/dist/domains/cats/services/session/sessionHandoffPropose.js';
import { InMemoryProfileUpdateProposalStore } from '../../../api/dist/domains/cats/services/stores/ports/ProfileUpdateProposalStore.js';
import { SessionChainStore } from '../../../api/dist/domains/cats/services/stores/ports/SessionChainStore.js';
import { InMemorySessionHandoffProposalStore } from '../../../api/dist/domains/cats/services/stores/ports/SessionHandoffProposalStore.js';
import { buildProfileUpdateCardBlock } from '../../../api/dist/routes/profile-update-card-block.js';
import { registerProfileUpdateDecisionRoutes } from '../../../api/dist/routes/profile-update-decision-routes.js';
import { sessionHandoffApproveRoutes } from '../../../api/dist/routes/session-handoff-approve-routes.js';
import { createInboxProposalFixture } from './f322-inbox-proposal.fixture.mjs';

/** Original F225/F231 stores, publication proof and owner HTTP writers. Profile writes only this fixture's mkdtemp. */
export async function createInboxOriginalApprovalFixture(language) {
  return createInboxProposalFixture({
    configureApprovals: async ({ app, owner, messages, threads, socketManager }) => {
      const root = await mkdtemp(path.join(tmpdir(), 'f322-original-approval-'));
      try {
        const handoffs = new InMemorySessionHandoffProposalStore(),
          profiles = new InMemoryProfileUpdateProposalStore();
        const sessions = new SessionChainStore(),
          queue = new InvocationQueue(),
          seals = [];
        const repository = new FileProfileRepository({ dataDir: root, relationshipKeyForCat: () => 'maine-coon' });
        const profileDir = repository.profileDir(owner),
          targetPath = 'relationship/maine-coon-primer.md';
        await mkdir(path.join(profileDir, 'relationship'), { recursive: true });
        const before = '## Confirmed preference\n\nUse concrete evidence.';
        const after =
          language === 'en'
            ? '## Confirmed preference\n\nExplain the result before implementation details.'
            : '## 已确认的偏好\n\n先讲结果，再讲实现细节。';
        const file = path.join(profileDir, targetPath);
        await writeFile(file, before);
        const records = [];
        function publish(store, proposal, kind, block, thread, origin) {
          block.meta = { ...block.meta, approval: { producerId: kind, canonicalProposalId: proposal.proposalId } };
          const card = messages.append({
            userId: owner,
            threadId: thread.id,
            from: { kind: 'agent', catId: 'codex61-sol' },
            content: language === 'en' ? 'Please decide on this proposal.' : '请决定这条提议。',
            timestamp: Date.now(),
            extra: { rich: { blocks: [block] } },
          });
          store.commitEnvelope(proposal.proposalId, {
            canonicalProposalId: proposal.proposalId,
            ownerUserId: owner,
            requesterCatId: 'codex61-sol',
            sourceFeatureId: kind,
            createdAt: proposal.createdAt,
            originRef: { kind: 'message', threadId: thread.id, messageId: origin.id },
            approvalCardRef: { threadId: thread.id, messageId: card.id },
          });
          records.push({ kind, proposalId: proposal.proposalId, thread, card, block });
        }
        for (const verb of ['approve', 'reject']) {
          const thread = threads.create(
            owner,
            language === 'en' ? `Original proposals — ${verb}` : `原提议验证 — ${verb}`,
            'default',
          );
          const origin = messages.append({
            userId: owner,
            threadId: thread.id,
            from: { kind: 'user', userId: owner },
            content:
              language === 'en' ? 'Keep these changes within the controlled sample.' : '这些改动只用于隔离样本。',
            timestamp: Date.now(),
          });
          const session = sessions.create({ threadId: thread.id, userId: owner, catId: 'codex61-sol' });
          const handoff = handoffs.create({
            sourceThreadId: thread.id,
            sourceSessionId: session.id,
            sourceCatId: 'codex61-sol',
            sourceMessageId: origin.id,
            userId: owner,
            note: {
              done:
                language === 'en'
                  ? '**Completed** the original route.\n\n' + '- Verified evidence.\n'.repeat(40)
                  : '**已完成**原接口验证。\n\n' + '- 核对证据。\n'.repeat(40),
              nextSteps: language === 'en' ? 'Continue the accepted verification.' : '继续已接受的验证。',
              gotchas: language === 'en' ? 'Do not extend this sample to the live provider.' : '不要外推到真实提供方。',
              worktreeBranch: 'owned-original-card-sample',
              commits: ['controlled-a', 'controlled-b'],
            },
          });
          publish(handoffs, handoff, 'F225', buildHandoffProposalCardBlock(handoff), thread, origin);
          const profile = profiles.create({
            sourceThreadId: thread.id,
            sourceInvocationId: 'controlled-original-invocation',
            sourceCatId: 'codex61-sol',
            targetLayer: 'primer',
            targetPath,
            beforeContent: before,
            afterContent: after,
            baseContentHash: hashContent(before),
            rationale:
              language === 'en' ? 'You asked for explanations that begin with the result.' : '你要求说明先讲结果。',
            signalProvenance: { kind: 'cvo-instructed', sourceThreadId: thread.id },
            createdBy: owner,
          });
          publish(profiles, profile, 'F231', buildProfileUpdateCardBlock(profile), thread, origin);
        }
        await app.register(sessionHandoffApproveRoutes, {
          handoffProposalStore: handoffs,
          sessionChainStore: sessions,
          invocationQueue: queue,
          socketManager,
          // Deliberately bounded sealer: real proposal transaction/notes/Queue, no provider or transcript export.
          sessionSealer: {
            requestSeal: async ({ sessionId, reason }) => {
              seals.push({ sessionId, reason });
              sessions.update(sessionId, { status: 'sealing', sealReason: reason });
              return { accepted: true, status: 'sealing' };
            },
            finalize: async ({ sessionId }) => {
              sessions.update(sessionId, { status: 'sealed' });
            },
          },
        });
        registerProfileUpdateDecisionRoutes(app, {
          store: profiles,
          lock: new SessionMutex(),
          repository,
          socketManager,
          clearL0Cache: () => {},
          clearL0CacheOwner: () => {},
        });
        return {
          records,
          handoffs,
          profiles,
          sessions,
          queue,
          seals,
          before,
          after,
          adapters: [new F225ApprovalAdapter(handoffs), new F231ApprovalAdapter(profiles)],
          createExpired() {
            const thread = threads.create(owner, 'Expired handoff original', 'default');
            const origin = messages.append({
              userId: owner,
              threadId: thread.id,
              from: { kind: 'user', userId: owner },
              content: 'Controlled expiry source',
              timestamp: Date.now(),
            });
            const session = sessions.create({ threadId: thread.id, userId: owner, catId: 'codex61-sol' });
            const proposal = handoffs.create({
              userId: owner,
              sourceThreadId: thread.id,
              sourceSessionId: session.id,
              sourceCatId: 'codex61-sol',
              sourceMessageId: origin.id,
              note: {
                done: 'Controlled closed original',
                nextSteps: language === 'en' ? 'Continue the accepted verification.' : '继续已接受的验证。',
              },
            });
            publish(handoffs, proposal, 'F225', buildHandoffProposalCardBlock(proposal), thread, origin);
            const record = records.pop();
            assert.equal(handoffs.markExpired(proposal.proposalId).status, 'expired');
            return record;
          },
          async readProfile() {
            const content = await readFile(file, 'utf8');
            assert.ok(content === before || content === after);
            return content;
          },
          async close() {
            await rm(root, { recursive: true, force: true });
          },
        };
      } catch (error) {
        await rm(root, { recursive: true, force: true });
        throw error;
      }
    },
  });
}
