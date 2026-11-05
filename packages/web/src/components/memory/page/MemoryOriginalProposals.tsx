import type { EntityMemoryProposalView, PersonMemoryProposalView, ProfileMemoryProposalView } from '@cat-cafe/shared';
import { useRouter } from 'next/navigation';
import type { ReactNode } from 'react';
import { useCatData } from '@/hooks/useCatData';
import { handleTeleportEvent } from '@/hooks/useTeleport';
import { scrollToMessage } from '@/utils/scrollToMessage';

type Proposal = ProfileMemoryProposalView | EntityMemoryProposalView | PersonMemoryProposalView;
const statuses: Record<Proposal['status'], string> = {
  pending: '待你决定',
  approving: '正在确认结果',
  approved: '已接受',
  rejected: '已拒绝',
  pending_approval: '待你决定',
  not_now: '已暂缓',
  partially_materialized: '已接受一部分',
  materialized: '已接受',
  withdrawn: '已撤回',
};
const pending = new Set<Proposal['status']>([
  'pending',
  'approving',
  'pending_approval',
  'not_now',
  'partially_materialized',
]);

export function ProposalCard({ proposal, children }: { proposal: Proposal; children: ReactNode }) {
  const { getCatById } = useCatData();
  const cat = getCatById(proposal.sourceCatId);
  const router = useRouter();
  const ref = proposal.approvalState === 'anchored' ? proposal.approvalCardRef : undefined;
  return (
    <article className="space-y-3 rounded-lg bg-cafe-surface-sunken p-4">
      <p className="text-compact font-medium">
        {cat?.nickname || cat?.displayName || '猫'}的提案 · {statuses[proposal.status]}
      </p>
      {children}
      {'rejectionReason' in proposal && proposal.rejectionReason && (
        <p className="text-compact text-cafe-muted">拒绝理由：{proposal.rejectionReason}</p>
      )}
      {ref ? (
        <button
          type="button"
          className="text-compact text-cafe-accent underline"
          onClick={() =>
            handleTeleportEvent(ref, null, {
              pushThreadRoute: (id) => router.push(`/thread/${encodeURIComponent(id)}`),
              scrollToMessage,
            })
          }
        >
          {pending.has(proposal.status) ? '查看并决定' : '查看审批记录'}
        </button>
      ) : (
        <p className="text-compact text-cafe-muted">暂时没有可打开的审批记录。</p>
      )}
    </article>
  );
}
function ProposalSection({ proposals, children }: { proposals: Proposal[] | undefined; children: ReactNode }) {
  return (
    <section aria-label="这条记忆的提案" className="space-y-3">
      <h4 className="text-sm font-medium">这条记忆的提案</h4>
      {proposals === undefined ? (
        <p className="text-compact text-cafe-muted">一时读不到这条记忆的提案</p>
      ) : proposals.length === 0 ? (
        <p className="text-compact text-cafe-muted">还没有提案</p>
      ) : (
        children
      )}
    </section>
  );
}
export function MemoryEntityProposals({ proposals }: { proposals?: EntityMemoryProposalView[] }) {
  return (
    <ProposalSection proposals={proposals}>
      {proposals?.map((proposal) => (
        <ProposalCard key={proposal.proposalId} proposal={proposal}>
          <p className="break-words text-sm">建议名称：{proposal.suggestedPatch.canonicalName}</p>
          {proposal.suggestedPatch.aliases.length > 0 && (
            <p className="break-words text-compact">建议别名：{proposal.suggestedPatch.aliases.join('、')}</p>
          )}
          <p className="text-compact text-cafe-muted">{proposal.rationale}</p>
        </ProposalCard>
      ))}
    </ProposalSection>
  );
}
export function MemoryPersonProposals({ proposals }: { proposals?: PersonMemoryProposalView[] }) {
  return (
    <ProposalSection proposals={proposals}>
      {proposals?.map((proposal) => (
        <ProposalCard key={proposal.proposalId} proposal={proposal}>
          <p className="break-words text-sm">{proposal.displayName}</p>
          {proposal.remainingDraftIds.length > 0 && (
            <p className="text-compact text-cafe-muted">尚有 {proposal.remainingDraftIds.length} 条内容待确认</p>
          )}
        </ProposalCard>
      ))}
    </ProposalSection>
  );
}
