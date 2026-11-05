import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { ApprovalIngress } from '../../../api/dist/domains/approval-hub/ApprovalIngress.js';
import { F266ApprovalAdapter } from '../../../api/dist/domains/approval-hub/adapters/F266ApprovalAdapter.js';
import { TaskStore } from '../../../api/dist/domains/cats/services/stores/ports/TaskStore.js';
import { MemoryRequestReviewOwnerLedger } from '../../../api/dist/infrastructure/capability-evolution/adapters/request-review/request-review-owner-ledger.js';
import { RequestReviewCanonicalRepairDispatcher } from '../../../api/dist/infrastructure/capability-evolution/change/request-review-canonical-dispatcher.js';
import { EvalRepairApprovalService } from '../../../api/dist/infrastructure/harness-eval/eval-repair-approval.js';
import { locateEvalRepairApproval } from '../../../api/dist/infrastructure/harness-eval/eval-repair-approval-contracts.js';
import { evalRepairApprovalRoutes } from '../../../api/dist/routes/eval-repair-approval-routes.js';
import { MemoryEventLog } from '../../../api/test/harness-eval/eval-repair-approval-fixtures.js';
import { createInboxProposalFixture } from './f322-inbox-proposal.fixture.mjs';

/** Original Ingress/service/adapter/routes/dispatcher; its existing Task and lease ports are fixture-owned memory only. */
export async function createInboxEvalRepairFixture(language) {
  return createInboxProposalFixture({
    configureApprovals: async ({ app, owner, messages, threads, socketManager }) => {
      const eventLog = new MemoryEventLog(),
        ledger = new MemoryRequestReviewOwnerLedger(),
        tasks = new TaskStore();
      const leases = new Map(),
        actions = new Map(),
        records = [];
      const version = createHash('sha256')
        .update(await readFile(new URL('../../../../cat-cafe-skills/request-review/SKILL.md', import.meta.url)))
        .digest('hex');
      const target = {
        ownerFeatureId: 'F100',
        ownerStateRef: 'skill:cat-cafe-skills/request-review/SKILL.md',
        assetKind: 'skill',
        assetId: 'cat-cafe-skills/request-review/SKILL.md',
        version,
      };
      const snapshot = {
        status: 'resolved',
        ownerRef: { ownerFeatureId: 'F100', ownerStateRef: 'owner:request-review' },
        ownerAuthorizationRef: { ownerFeatureId: 'F100', ownerStateRef: `authorization:request-review:${version}` },
        targetVersionRef: target,
        dispatchRef: { ownerFeatureId: 'F100', ownerStateRef: `dispatch:request-review:${version}` },
      };
      const dispatcher = new RequestReviewCanonicalRepairDispatcher({
        eventLog,
        ledger,
        taskStore: tasks,
        leaseStore: {
          async get(id) {
            return leases.get(id) ?? null;
          },
        },
        lineageBindingResolver: {
          async resolveProposalScope({ proposal }) {
            return { status: 'resolved', caseActionRef: proposal.caseActionRef };
          },
        },
        resolveCurrentSnapshot: async () => structuredClone(snapshot),
        now: () => new Date().toISOString(),
      });
      const service = new EvalRepairApprovalService({
        eventLog,
        epochAuthority: {
          async authorize() {
            return {
              allowed: true,
              record: {
                producerId: 'F266',
                epoch: 1,
                revision: 3,
                phase: 'v1_active',
                updatedAt: new Date().toISOString(),
                cutoverReceiptRef: 'fixture:f266:v1',
              },
            };
          },
        },
        resolveCaseAction: async (ref) => actions.get(ref) ?? null,
        resolveOwnerChangeContract: async () => structuredClone(snapshot),
        approvalIngress: new ApprovalIngress({ messageStore: messages, socketManager }),
        canonicalRepairDispatcher: dispatcher,
      });
      for (const entrance of ['Chat', 'Inbox']) {
        const thread = threads.create(
          owner,
          `${language === 'en' ? 'Original evaluation repair' : '原评估修复'} ${entrance}`,
          'default',
        );
        for (const verb of ['approve', 'reject']) {
          const origin = messages.append({
            userId: owner,
            threadId: thread.id,
            from: { kind: 'user', userId: owner },
            content: `Controlled original ${entrance} ${verb} authorization`,
            timestamp: Date.now(),
          });
          const actionRef = `case-action:controlled:${entrance}:${verb}`;
          const caseId = `eval-case-v1-${createHash('sha256').update(actionRef).digest('hex')}`,
            verdictId = `controlled-repair-${entrance}-${verb}`;
          const task = tasks.create({
            title: `Original repair responsibility ${entrance} ${verb}`,
            threadId: thread.id,
            ownerCatId: 'codex61-sol',
            userId: owner,
          });
          tasks.update(task.id, { status: 'doing' });
          const lease = {
            leaseId: `controlled-lease-${entrance}-${verb}`,
            generation: 1,
            status: 'active',
            subjectRef: `subject:task:${task.id}`,
            actionFamily: 'implement',
            successorSlot: 'implementer',
            holderCatIds: ['codex61-sol'],
            holderThreadId: thread.id,
            tenantScope: owner,
            terminalPredicate: { kind: 'task_done' },
          };
          leases.set(lease.leaseId, lease);
          actions.set(actionRef, {
            caseId,
            verdictId,
            domainId: 'eval:friction',
            findingKey:
              language === 'en' ? `Original approval evidence ${entrance} ${verb}` : `原审批证据 ${entrance} ${verb}`,
            analysisDisposition: 'repair',
            approvalRequirement: { kind: 'required', reason: 'repair' },
            findingArtifactRef: `artifact:controlled:${entrance}:${verb}`,
            repairTarget: {
              featureId: 'F100',
              componentId: 'capability:development-process-harness-effectiveness',
              version,
            },
            expectedChange:
              language === 'en'
                ? 'Make the original review request show its exact evidence.'
                : '让原审查请求显示对应的真实证据。',
            costAndRollback:
              language === 'en'
                ? 'One reversible review; revert the approved commit.'
                : '一次可回滚的审查；回退已批准的提交。',
            withdrawalCondition:
              language === 'en'
                ? 'Withdraw if the original target or authorization changes.'
                : '原目标或授权改变时撤回。',
          });
          const proposed = await service.propose({
            caseActionRef: actionRef,
            clientMessageId: `controlled-${entrance}-${verb}`,
            principal: {
              invocationId: `controlled-inv-${entrance}-${verb}`,
              userId: owner,
              catId: 'codex61-sol',
              threadId: thread.id,
              originMessageId: origin.id,
            },
          });
          assert.equal(proposed.status, 'published');
          const located = await locateEvalRepairApproval(eventLog, proposed.proposalId);
          assert.equal(located.record.publication.state, 'anchored');
          const envelope = located.record.publication.envelope;
          const message = messages.getById(envelope.approvalCardRef.messageId),
            block = message.extra.rich.blocks[0];
          assert.deepEqual(block.meta.approval, { producerId: 'F266', canonicalProposalId: proposed.proposalId });
          const events = await eventLog.read(caseId);
          await eventLog.append(
            {
              eventId: `responsibility:${caseId}`,
              caseId,
              verdictId,
              domainId: 'eval:friction',
              type: 'responsibility_bound',
              actor: { kind: 'automation', id: 'controlled-owner' },
              occurredAt: new Date().toISOString(),
              reason: 'Fixture-owned existing responsibility',
              refs: [{ kind: 'task', availability: 'available', value: `task:${task.id}` }],
              taskId: task.id,
              leaseId: lease.leaseId,
              leaseGeneration: 1,
            },
            events.length,
          );
          records.push({
            entrance,
            verb,
            proposalId: proposed.proposalId,
            thread,
            envelope,
            block,
            taskId: task.id,
            leaseId: lease.leaseId,
            caseId,
          });
        }
      }
      await app.register(evalRepairApprovalRoutes, {
        service,
        callbackRegistry: {
          async verify() {
            return { ok: false, reason: 'invalid_token' };
          },
        },
      });
      return {
        records,
        service,
        adapters: [new F266ApprovalAdapter(eventLog)],
        async effects() {
          return {
            ownerLedger: await ledger.read(),
            tasks: records.map((r) => tasks.get(r.taskId)),
            leases: [...leases.values()],
            approvals: await Promise.all(
              records.map(async (r) => (await locateEvalRepairApproval(eventLog, r.proposalId)).record),
            ),
          };
        },
        async close() {},
      };
    },
  });
}
