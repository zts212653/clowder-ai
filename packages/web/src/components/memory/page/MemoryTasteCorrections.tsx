import type { TasteMemoryCorrectionProposalView } from '@cat-cafe/shared';
import { MemoryCorrectionCard, type MemoryCorrectionDecision } from './MemoryCorrectionCard';
import { memoryObject } from './owner-memory-read';

function matchesReceipt(body: unknown, proposalId: string, decision: MemoryCorrectionDecision) {
  return (
    memoryObject(body) &&
    body.proposalId === proposalId &&
    body.status === (decision === 'approve' ? 'approved' : 'rejected')
  );
}

export function MemoryTasteCorrections({
  proposals,
  revision,
  reread,
}: {
  proposals: TasteMemoryCorrectionProposalView[];
  revision: string;
  reread: () => void;
}) {
  if (!proposals.length) return null;
  return (
    <section aria-label="品味纠正建议" className="mt-5 space-y-3">
      <h3 className="text-base font-medium">猫的纠正建议</h3>
      <p className="text-compact text-cafe-muted">检查猫提出的新解释，再决定是否接受。当前品味在决定前保持原样。</p>
      {proposals.map((proposal) => (
        <MemoryCorrectionCard
          key={proposal.proposalId}
          proposal={proposal}
          revision={revision}
          reread={reread}
          noun="品味"
          endpoint="/api/taste-proposals"
          matchesReceipt={matchesReceipt}
        >
          {proposal.suggestedPatch.takeaway !== undefined && (
            <p className="whitespace-pre-wrap break-words text-sm">
              {proposal.suggestedPatch.takeaway ?? '删除这句概括'}
            </p>
          )}
          {proposal.suggestedPatch.scene !== undefined && (
            <p className="whitespace-pre-wrap break-words text-sm">当时的情景：{proposal.suggestedPatch.scene}</p>
          )}
          {proposal.suggestedPatch.quotes?.map((quote, index) => (
            <blockquote key={`${index}:${quote}`} className="whitespace-pre-wrap break-words text-sm">
              {quote}
            </blockquote>
          ))}
        </MemoryCorrectionCard>
      ))}
    </section>
  );
}
