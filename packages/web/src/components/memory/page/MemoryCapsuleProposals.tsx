import type { ProfileMemoryProposalView } from '@cat-cafe/shared';
import { splitUserCapsule } from '@cat-cafe/shared/profile-contract';
import { useRouter } from 'next/navigation';
import { ExternalLinkIcon } from '@/components/HubConfigIcons';
import { useCatData } from '@/hooks/useCatData';
import { handleTeleportEvent } from '@/hooks/useTeleport';
import { scrollToMessage } from '@/utils/scrollToMessage';
import { capsulePrimary } from './MemoryCapsuleEditor';
import { MemoryProfileBody } from './MemoryProfileBody';

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
  profile = false,
}: {
  proposals: ProfileMemoryProposalView[];
  current: string;
  revision: string;
  profile?: boolean;
}) {
  const router = useRouter();
  const before = splitUserCapsule(current).body;
  return (
    <section aria-label={profile ? '待决定的画像更新' : '待确认的关于你'} className="space-y-4">
      {proposals.map((proposal) => {
        const after = splitUserCapsule(proposal.suggestedContent).body;
        const ref = proposal.approvalState === 'anchored' ? proposal.approvalCardRef : undefined;
        const stale = proposal.expectedRevision !== revision;
        return (
          <article
            key={proposal.proposalId}
            className="space-y-3 rounded-xl border border-[var(--semantic-warning)] bg-cafe-surface p-4"
          >
            <div className="flex flex-wrap items-start justify-between gap-3">
              <CapsulePendingLabel proposal={proposal} />
              {ref ? (
                <button
                  type="button"
                  className={`${capsulePrimary} inline-flex items-center gap-1`}
                  onClick={() => {
                    handleTeleportEvent(ref, null, {
                      pushThreadRoute: (id) => router.push(`/thread/${encodeURIComponent(id)}`),
                      scrollToMessage,
                    });
                  }}
                >
                  查看并决定
                  <span aria-hidden="true">
                    <ExternalLinkIcon />
                  </span>
                </button>
              ) : (
                <p className="text-compact text-cafe-muted">暂时没有可打开的审批记录。</p>
              )}
            </div>
            <p className="text-compact text-cafe-muted">为什么改：{proposal.rationale}</p>
            <div className="grid gap-3 xl:grid-cols-2">
              <div className="rounded-lg border border-cafe-subtle bg-[var(--console-card-bg)] p-3">
                <h3 className="text-xs text-cafe-muted">现在的版本</h3>
                {profile ? (
                  <div className="mt-2 max-h-72 overflow-y-auto">
                    <MemoryProfileBody content={current} compact />
                  </div>
                ) : (
                  <p className="mt-2 max-h-72 overflow-y-auto whitespace-pre-wrap break-words text-sm leading-relaxed">
                    {before ? <Difference text={before} before={before} after={after} old /> : '现在还是空的。'}
                  </p>
                )}
              </div>
              <div className="rounded-lg border border-cafe-subtle p-3">
                <h3 className="text-xs text-cafe-muted">起草的新版本 · 尚未生效</h3>
                {profile ? (
                  <div className="mt-2 max-h-72 overflow-y-auto">
                    <MemoryProfileBody content={proposal.suggestedContent} compact />
                  </div>
                ) : (
                  <p className="mt-2 max-h-72 overflow-y-auto whitespace-pre-wrap break-words text-sm leading-relaxed">
                    <Difference text={after} before={before} after={after} />
                  </p>
                )}
              </div>
            </div>
            <p className="text-compact">
              {stale
                ? '这版是按旧内容起草的，画像后来改过。请在原提案里核对。'
                : profile
                  ? '确认后替换当前画像，之后回看会读到新版。'
                  : '在原提案中接受后，会替换现在的版本，从下一个新对话开始生效。'}
            </p>
            <p className="text-xs text-cafe-muted">和待办里是同一件。这里看对比，决定回到原提案。</p>
          </article>
        );
      })}
    </section>
  );
}
