import type { ProfileMemoryProposalView } from '@cat-cafe/shared';
import { MemoryCapsuleProposals, pendingCapsuleProposals } from './MemoryCapsuleProposals';
import { ProposalCard } from './MemoryOriginalProposals';
import { MemoryProfileBody } from './MemoryProfileBody';

export function MemoryProfileProposals({
  proposals,
  revision,
  current,
}: {
  proposals?: ProfileMemoryProposalView[];
  revision: string;
  current: string;
}) {
  const pending = pendingCapsuleProposals(proposals) ?? [];
  const history = proposals?.filter((proposal) => !pending.includes(proposal)) ?? [];
  return (
    <section aria-label="这条记忆的提案" className="space-y-3">
      <h4 className="text-sm font-medium">猫提议的更新</h4>
      {proposals === undefined ? (
        <p className="text-compact text-cafe-muted">一时读不到这条记忆的提案</p>
      ) : proposals.length === 0 ? (
        <p className="text-compact text-cafe-muted">还没有提案</p>
      ) : null}
      {pending.length > 0 && (
        <MemoryCapsuleProposals proposals={pending} revision={revision} current={current} profile />
      )}
      {history.map((proposal) => (
        <ProposalCard key={proposal.proposalId} proposal={proposal}>
          <MemoryProfileBody content={proposal.suggestedContent} />
          <p className="text-compact text-cafe-muted">{proposal.rationale}</p>
        </ProposalCard>
      ))}
    </section>
  );
}
