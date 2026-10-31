import {
  type EventMemoryCorrectionPatch,
  type EventMemoryCorrectionProposalView,
  memoryOwnerRevisionSchema,
} from '@cat-cafe/shared';
import { MemoryCorrectionCard, type MemoryCorrectionDecision } from './MemoryCorrectionCard';
import { memoryObject } from './owner-memory-read';

function matchesReceipt(body: unknown, proposalId: string, decision: MemoryCorrectionDecision) {
  return (
    memoryObject(body) &&
    body.proposalId === proposalId &&
    body.status === (decision === 'approve' ? 'approved' : 'rejected') &&
    (decision === 'reject' || memoryOwnerRevisionSchema.safeParse(body.appliedRevision).success)
  );
}

function EventCorrectionPatchPreview({ patch }: { patch: EventMemoryCorrectionPatch }) {
  return (
    <>
      {patch.summary !== undefined && <p className="whitespace-pre-wrap break-words text-sm">{patch.summary}</p>}
      {patch.cognitiveTransition !== undefined && (
        <p className="text-compact">认知转变：{patch.cognitiveTransition ?? '未记录'}</p>
      )}
      {patch.relatedHarness !== undefined && (
        <p className="break-words text-compact">关联规则：{patch.relatedHarness?.join('、') || '无'}</p>
      )}
      {patch.confidence !== undefined && <p className="text-compact">判断把握：{patch.confidence}</p>}
    </>
  );
}

export function MemoryEventCorrections({
  proposals,
  revision,
  reread,
}: {
  proposals: EventMemoryCorrectionProposalView[];
  revision: string;
  reread: () => void;
}) {
  if (!proposals.length) return null;
  return (
    <section aria-label="事件纠正建议" className="space-y-3">
      <h3 className="text-base font-medium">猫的纠正建议</h3>
      <p className="text-compact text-cafe-muted">检查猫提出的新解释，再决定是否接受。</p>
      {proposals.map((proposal) => (
        <MemoryCorrectionCard
          key={proposal.proposalId}
          proposal={proposal}
          revision={revision}
          reread={reread}
          noun="事件"
          endpoint="/api/event-memory-corrections"
          matchesReceipt={matchesReceipt}
        >
          <EventCorrectionPatchPreview patch={proposal.suggestedPatch} />
        </MemoryCorrectionCard>
      ))}
    </section>
  );
}
