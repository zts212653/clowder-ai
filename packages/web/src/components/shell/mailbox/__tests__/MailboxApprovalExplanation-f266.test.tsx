import {
  type ApprovalHubItem,
  evalRepairDecisionExplanationV1Schema,
  normalizeApprovalLifecycleProjection,
} from '@cat-cafe/shared';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import { F266ApprovalAdapter } from '../../../../../../api/src/domains/approval-hub/adapters/F266ApprovalAdapter';
import { EvalRepairApprovalService } from '../../../../../../api/src/infrastructure/harness-eval/eval-repair-approval';
import type { IReevalClosureEventLog } from '../../../../../../api/src/infrastructure/harness-eval/reeval-closure-event-log';
import type { EvalLifecycleEvent } from '../../../../../../api/src/infrastructure/harness-eval/reeval-closure-schema';
import { EvalRepairDecisionDetails } from '../../../rich/eval-repair/EvalRepairDecisionDetails';
import { evalRepairModel } from '../../../rich/eval-repair-model';

vi.mock('@/hooks/useCatNameResolver', () => ({ useCatNameResolver: () => (catId: string) => catId }));

const decisionExplanation = evalRepairDecisionExplanationV1Schema.parse({
  schemaVersion: 1,
  expectedChange: '把 approved source 用在下一次本地审阅',
  beforeSummary: '后续任务没有来源提示',
  afterSummary: '后续任务显示 exact version 与撤销入口',
  changeSetSummary: '消费回执、消息来源行、恢复路径一起交付',
  attributionBoundary: '只证明这条版本被使用，不证明整体交付改善',
  independentVerification: '非作者在 exact HEAD 上复核回归旅程',
  rejectedCandidates: ['从回复文字猜版本', '同意后立即写成已生效'],
  costAndRollback: '一条可逆提交；回退恢复原版本并保留回执',
});

async function productionItem(): Promise<ApprovalHubItem> {
  const caseId = 'case-f266-decision-explanation';
  const events: EvalLifecycleEvent[] = [];
  const eventLog: IReevalClosureEventLog = {
    async read(subjectId: string) {
      return subjectId === caseId ? structuredClone(events) : [];
    },
    async listSubjectIds() {
      return [caseId];
    },
    async listVerdictIds() {
      return [caseId];
    },
    async append(event: EvalLifecycleEvent, expectedSequence: number) {
      if (events.some((candidate) => candidate.eventId === event.eventId)) return { outcome: 'duplicate' as const };
      if (events.length !== expectedSequence) return { outcome: 'conflict' as const, actualSequence: events.length };
      events.push(structuredClone(event));
      return { outcome: 'appended' as const, sequence: expectedSequence };
    },
  };
  const targetVersionRef = {
    ownerFeatureId: 'F100',
    ownerStateRef: 'skill:cat-cafe-skills/request-review/SKILL.md',
    assetKind: 'skill',
    assetId: 'cat-cafe-skills/request-review/SKILL.md',
    version: 'b'.repeat(64),
  };
  const service = new EvalRepairApprovalService({
    eventLog,
    epochAuthority: {
      async authorize() {
        return {
          allowed: true as const,
          record: {
            producerId: 'F266' as const,
            epoch: 1,
            revision: 3,
            phase: 'v1_active' as const,
            updatedAt: '2026-10-14T18:00:00.000Z',
            cutoverReceiptRef: 'receipt:f266:v1',
          },
        };
      },
    },
    async resolveCaseAction() {
      return {
        caseId,
        verdictId: 'verdict-f266-decision-explanation',
        domainId: 'eval:friction',
        findingKey: 'request-review-source-line',
        analysisDisposition: 'repair' as const,
        approvalRequirement: { kind: 'required' as const, reason: 'repair' as const },
        findingArtifactRef: 'docs/harness-feedback/bundles/example/finding.json',
        repairTarget: { featureId: 'F100', componentId: 'request-review', version: targetVersionRef.version },
        expectedChange: decisionExplanation.expectedChange,
        costAndRollback: decisionExplanation.costAndRollback,
        withdrawalCondition: 'owner、授权或 exact target 变化时撤回',
        decisionExplanation,
      };
    },
    async resolveOwnerChangeContract() {
      return {
        status: 'resolved' as const,
        ownerRef: { ownerFeatureId: 'F100', ownerStateRef: 'owner:request-review' },
        ownerAuthorizationRef: { ownerFeatureId: 'F100', ownerStateRef: 'authorization:request-review-v1' },
        targetVersionRef,
        dispatchRef: { ownerFeatureId: 'F100', ownerStateRef: 'dispatch:request-review-v1' },
      };
    },
    approvalIngress: {
      async publish(draft, store) {
        const envelope = {
          canonicalProposalId: draft.canonicalProposalId,
          sourceFeatureId: 'F266' as const,
          ownerUserId: draft.ownerUserId,
          requesterCatId: draft.requesterCatId,
          originRef: draft.originRef,
          approvalCardRef: { threadId: draft.cardThreadId, messageId: 'message-f266-card' },
          createdAt: draft.createdAt,
        };
        await store.commitEnvelope(draft.canonicalProposalId, envelope);
        return envelope;
      },
    },
    canonicalRepairDispatcher: {
      async materialize() {
        throw new Error('decision explanation test must not materialize');
      },
    },
    now: () => '2026-10-14T18:00:00.000Z',
  });
  const published = await service.propose({
    caseActionRef: 'case-action:f266:decision-explanation',
    clientMessageId: 'client-f266-decision-explanation',
    principal: {
      invocationId: 'inv-f266-decision-explanation',
      userId: 'operator',
      catId: 'codex-sol',
      threadId: 'thread-f266-decision-explanation',
      originMessageId: 'message-f266-origin',
    },
  });
  if (published.status !== 'published') throw new Error(`Expected published proposal, got ${published.status}`);
  const [legacyItem] = await new F266ApprovalAdapter(eventLog).listPending('operator');
  if (!legacyItem) throw new Error('Expected projected F266 Approval item');
  const { status, decisionMode: legacyDecisionMode, ...item } = legacyItem;
  const decisionMode = legacyDecisionMode === 'resume-only' ? undefined : legacyDecisionMode;
  return {
    ...item,
    ...(decisionMode ? { decisionMode } : {}),
    ...normalizeApprovalLifecycleProjection({ status }),
  };
}

describe('F266 original-card decision explanation', () => {
  it('renders the owner-backed producer contract rather than fixture-only flat fields', async () => {
    const item = await productionItem();
    const model = evalRepairModel(item);
    if (!model) throw new Error('Expected the production F266 projection to remain readable');
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => root.render(<EvalRepairDecisionDetails item={item} model={model} />));
    for (const text of [
      '这次只批准一件事',
      '把 approved source 用在下一次本地审阅',
      '后续任务没有来源提示',
      '后续任务显示 exact version 与撤销入口',
      '消费回执、消息来源行、恢复路径一起交付',
      '只证明这条版本被使用，不证明整体交付改善',
      '非作者在 exact HEAD 上复核回归旅程',
      '从回复文字猜版本',
      '同意后立即写成已生效',
      '一条可逆提交；回退恢复原版本并保留回执',
      'owner、授权或 exact target 变化时撤回',
      'b'.repeat(64),
    ]) {
      expect(container.textContent).toContain(text);
    }
    act(() => root.unmount());
    container.remove();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });
});
