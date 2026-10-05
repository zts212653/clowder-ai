import { isDeepStrictEqual } from 'node:util';
import { NEEDS_ME_PRODUCER_IDS, type UnifiedAttentionItemV1 as UnifiedDecisionItem } from '@cat-cafe/shared';
import type { DecisionApproval, DecisionReceipt, DecisionWork } from './companion-decision-sources.js';

type ActionableReceipt = DecisionReceipt & { kind: 'judgment' | 'repair'; recommendation: string };
export type LinkedDecision = { ownerRead: DecisionWork; receipt: ActionableReceipt };
export type { UnifiedAttentionItemV1 as UnifiedDecisionItem } from '@cat-cafe/shared';

function producerDecisionRef(producer: DecisionReceipt['producer']): string {
  return producer.producerId === 'f246.approval'
    ? producer.subjectRef
    : `${producer.producerId}:${producer.subjectRef}`;
}

function approvalDecisionRef(approval: DecisionApproval): string {
  if (approval.sourceFeatureId === 'F292') return `f292.repair:${approval.proposalId}`;
  if (approval.sourceFeatureId === 'F306') return `f306.runtime_interaction:${approval.proposalId}`;
  return `approval:${approval.sourceFeatureId}:${approval.proposalId}`;
}

function exactTask(receipt: DecisionReceipt, work: DecisionWork): boolean {
  return (
    receipt.taskRef.subjectRef === work.envelope.subjectRef &&
    receipt.taskRef.observedRevision === work.envelope.revision
  );
}

function candidates(work: DecisionWork, reasons: Set<string>): LinkedDecision[] {
  if (!work.envelope.freshness || !work.brief?.current) reasons.add('owner_read_contract_unverified');
  if (
    work.envelope.freshness?.state !== 'current' ||
    work.envelope.freshness.observedRevision !== work.envelope.revision ||
    !work.preparedArtifact ||
    work.brief?.current?.state === 'done'
  )
    return [];
  return work.attentionReceipts
    .filter((receipt): receipt is ActionableReceipt => {
      if (!receipt.eligible) return false;
      const valid =
        exactTask(receipt, work) &&
        receipt.kind !== undefined &&
        typeof receipt.recommendation === 'string' &&
        receipt.action?.expectedProducerRevision === receipt.producer.revision &&
        NEEDS_ME_PRODUCER_IDS.some((id) => id === receipt.producer.producerId);
      if (!valid) reasons.add('producer_receipt_unverified');
      return valid;
    })
    .map((receipt) => ({ ownerRead: work, receipt }));
}

function association(approval: DecisionApproval, linked: LinkedDecision): 'exact' | 'conflict' | 'different' {
  const { receipt, ownerRead } = linked;
  if (receipt.producer.producerId === 'f246.approval') {
    if (receipt.producer.subjectRef !== `approval:${approval.sourceFeatureId}:${approval.proposalId}`)
      return 'different';
    return approval.entrustedWorkTaskRef?.subjectRef === ownerRead.envelope.subjectRef &&
      approval.entrustedWorkTaskRef.observedRevision === ownerRead.envelope.revision &&
      receipt.producer.revision === approval.createdAt &&
      approval.resolution === 'open'
      ? 'exact'
      : 'conflict';
  }
  const producerId =
    approval.sourceFeatureId === 'F292'
      ? 'f292.repair'
      : approval.sourceFeatureId === 'F306'
        ? 'f306.runtime_interaction'
        : undefined;
  if (receipt.producer.producerId !== producerId) return 'different';
  const witness = approval.needsMeDecisionRefs?.find(
    (ref) => ref.producerId === producerId && ref.subjectRef === receipt.producer.subjectRef,
  );
  if (!witness && receipt.producer.subjectRef !== approval.proposalId) return 'different';
  return witness?.revision === receipt.producer.revision && approval.resolution === 'open' ? 'exact' : 'conflict';
}

function approvalItems(
  approvals: DecisionApproval[],
  decisions: LinkedDecision[],
  consumed: Set<LinkedDecision>,
  reasons: Set<string>,
) {
  const items: UnifiedDecisionItem[] = [];
  const approvalByIdentity = new Map<string, DecisionApproval>();
  for (const approval of approvals) {
    const identity = approvalDecisionRef(approval);
    const previousApproval = approvalByIdentity.get(identity);
    if (previousApproval && isDeepStrictEqual(previousApproval, approval)) continue;
    if (previousApproval) reasons.add('ambiguous_decision_identity');
    approvalByIdentity.set(identity, approval);
    const linkedNeedsMe = decisions.filter((linked) => {
      const match = association(approval, linked);
      if (match === 'conflict') reasons.add('producer_version_or_link_unverified');
      if (match !== 'exact') return false;
      if (consumed.has(linked)) {
        reasons.add('ambiguous_decision_identity');
        return false;
      }
      consumed.add(linked);
      return true;
    });
    if (['F292', 'F306'].includes(approval.sourceFeatureId) && !approval.needsMeDecisionRefs?.length)
      reasons.add('producer_identity_coverage_unverified');
    const { ownerUserId: _ownerUserId, ...visibleApproval } = approval;
    items.push({
      decisionRef: identity,
      kind: 'approval',
      summary: approval.summary,
      approval: visibleApproval,
      linkedNeedsMe,
    });
  }
  return items;
}

function unlinkedItems(decisions: LinkedDecision[], consumed: Set<LinkedDecision>, reasons: Set<string>) {
  const items: UnifiedDecisionItem[] = [];
  const byIdentity = new Map<string, UnifiedDecisionItem>();
  for (const linked of decisions) {
    if (consumed.has(linked) || !linked.receipt.kind) continue;
    const { producer } = linked.receipt;
    const decisionRef = producerDecisionRef(producer);
    const previous = byIdentity.get(decisionRef);
    if (previous) {
      if (
        previous.linkedNeedsMe.some(
          (other) =>
            other.receipt.producer.revision !== producer.revision ||
            other.receipt.taskRef.subjectRef !== linked.receipt.taskRef.subjectRef ||
            other.receipt.taskRef.observedRevision !== linked.receipt.taskRef.observedRevision ||
            !isDeepStrictEqual(other.receipt.action, linked.receipt.action),
        )
      ) {
        reasons.add('producer_version_or_link_unverified');
        items.push({
          decisionRef,
          kind: linked.receipt.kind,
          summary: linked.receipt.recommendation,
          linkedNeedsMe: [linked],
        });
      }
      continue;
    }
    const item: UnifiedDecisionItem = {
      decisionRef,
      kind: linked.receipt.kind,
      summary: linked.receipt.recommendation,
      linkedNeedsMe: [linked],
    };
    byIdentity.set(decisionRef, item);
    items.push(item);
  }
  return items;
}

/** Count concrete source decisions, never Task groups. Cross-source identity requires an exact producer witness. */
export function projectDecisionItems(approvals: DecisionApproval[], works: DecisionWork[]) {
  const reasons = new Set<string>();
  const decisions = works.flatMap((work) => candidates(work, reasons));
  const consumed = new Set<LinkedDecision>();
  const items = approvalItems(approvals, decisions, consumed, reasons);
  items.push(...unlinkedItems(decisions, consumed, reasons));
  return { items, reasons: [...reasons] };
}
