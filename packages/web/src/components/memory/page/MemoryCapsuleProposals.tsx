import type { ProfileMemoryProposalView } from '@cat-cafe/shared';
import { splitUserCapsule } from '@cat-cafe/shared/profile-contract';
import { useRouter } from 'next/navigation';
import { useCatData } from '@/hooks/useCatData';
import { handleTeleportEvent } from '@/hooks/useTeleport';
import { scrollToMessage } from '@/utils/scrollToMessage';
import { capsulePrimary } from './MemoryCapsuleEditor';

export const pendingCapsuleProposals = (items: ProfileMemoryProposalView[] | undefined) =>
  items?.filter((item) => item.status === 'pending' || item.status === 'approving');

export function CapsulePendingLabel({ proposal }: { proposal: ProfileMemoryProposalView }) {
  const { getCatById } = useCatData();
  const cat = getCatById(proposal.sourceCatId);
  return (
    <p className="mt-2 flex items-start gap-2 text-compact">
      <span aria-hidden="true" className="mt-1 h-2 w-2 shrink-0 rounded-full bg-[var(--semantic-warning)]" />
      <span>
        {cat?.nickname || cat?.displayName || '猫'}起草了新版本 ·{' '}
        {proposal.status === 'approving' ? '正在确认结果' : '待你决定'}
      </span>
    </p>
  );
}

function changedRange(before: string, after: string) {
  const left = [...before];
  const right = [...after];
  let start = 0;
  let suffix = 0;
  while (start < left.length && start < right.length && left[start] === right[start]) start++;
  while (
    suffix < left.length - start &&
    suffix < right.length - start &&
    left[left.length - suffix - 1] === right[right.length - suffix - 1]
  )
    suffix++;
  return { start, suffix };
}
function Difference({ text, before, after, old }: { text: string; before: string; after: string; old?: boolean }) {
  const { start, suffix } = changedRange(before, after);
  const chars = [...text];
  const end = chars.length - suffix;
  const changed = chars.slice(start, end).join('');
  return (
    <>
      {chars.slice(0, start).join('')}
      {old ? <del>{changed}</del> : <mark className="rounded bg-cafe-surface-sunken text-cafe">{changed}</mark>}
      {chars.slice(end).join('')}
    </>
  );
}

export function MemoryCapsuleProposals({
  proposals,
  current,
  revision,
}: {
  proposals: ProfileMemoryProposalView[];
  current: string;
  revision: string;
}) {
  const router = useRouter();
  const before = splitUserCapsule(current).body;
  return (
    <section aria-label="待确认的开场简介" className="space-y-4">
      {proposals.map((proposal) => {
        const after = splitUserCapsule(proposal.suggestedContent).body;
        const ref = proposal.approvalState === 'anchored' ? proposal.approvalCardRef : undefined;
        const stale = proposal.expectedRevision !== revision;
        return (
          <article key={proposal.proposalId} className="space-y-3 border-t border-cafe-subtle pt-3">
            <CapsulePendingLabel proposal={proposal} />
            <div className="rounded-lg border border-cafe-subtle bg-cafe-surface-sunken p-3">
              <h3 className="text-xs text-cafe-muted">现在的版本</h3>
              <p className="mt-2 whitespace-pre-wrap break-words text-sm leading-relaxed">
                {before ? <Difference text={before} before={before} after={after} old /> : '现在还是空的。'}
              </p>
            </div>
            <div className="rounded-lg border border-cafe-subtle p-3">
              <h3 className="text-xs text-cafe-muted">起草的新版本 · 尚未生效</h3>
              <p className="mt-2 whitespace-pre-wrap break-words text-sm leading-relaxed">
                <Difference text={after} before={before} after={after} />
              </p>
            </div>
            <p className="text-compact text-cafe-muted">为什么改：{proposal.rationale}</p>
            <p className="text-compact">
              {stale
                ? '这版是按旧内容起草的，简介后来改过。请在原提案里核对。'
                : '在原提案中接受后，会替换现在的版本，从下一个新对话开始生效。'}
            </p>
            {ref ? (
              <button
                type="button"
                className={capsulePrimary}
                onClick={() => {
                  handleTeleportEvent(ref, null, {
                    pushThreadRoute: (id) => router.push(`/thread/${encodeURIComponent(id)}`),
                    scrollToMessage,
                  });
                }}
              >
                查看并决定
              </button>
            ) : (
              <p className="text-compact text-cafe-muted">暂时没有可打开的审批记录。</p>
            )}
          </article>
        );
      })}
    </section>
  );
}
