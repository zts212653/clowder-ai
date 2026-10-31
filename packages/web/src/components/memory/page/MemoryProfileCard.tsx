import { readProfileOpeningReference } from '@cat-cafe/shared/profile-opening-reference';
import { CatAvatar } from '@/components/CatAvatar';
import { useCatData } from '@/hooks/useCatData';
import { CapsulePendingLabel, pendingCapsuleProposals } from './MemoryCapsuleProposals';
import { MemoryProfileCardFrame } from './MemoryProfileCardFrame';
import type { ProfileMemoryRead } from './owner-memory-read';
import { profileIdentity, profileSections, profileText } from './profile-presentation';
import { formatMemoryDate } from './use-memory-read';

export function MemoryProfileCard({
  entry,
  selected,
  select,
}: {
  entry: ProfileMemoryRead;
  selected: boolean;
  select: () => void;
}) {
  const { cats = [], hasFetched } = useCatData();
  const identity = profileIdentity(entry, cats, hasFetched);
  const pending = pendingCapsuleProposals(entry.proposals);
  const opening = entry.layer === 'primer' && readProfileOpeningReference(entry.content);
  return (
    <MemoryProfileCardFrame selected={selected} select={select}>
      <div className="flex items-center gap-2">
        {identity.members.map((cat) => (
          <CatAvatar key={cat.id} catId={cat.id} size={24} ring="none" />
        ))}
        <button
          type="button"
          onClick={select}
          aria-pressed={selected}
          className="shell-focusable min-w-0 text-left text-sm font-medium"
        >
          {identity.title}
        </button>
        <span className="ml-auto shrink-0 rounded bg-cafe-surface-sunken px-2 py-0.5 text-xs text-cafe-muted">
          {opening ? '新对话会参考' : entry.layer === 'corpus' ? '全员共享' : '按需回看'}
        </span>
      </div>
      {identity.memberNotice && <p className="mt-1 text-xs text-cafe-muted">{identity.memberNotice}</p>}
      {identity.memberLabels && <p className="mt-1 text-xs text-cafe-muted">{identity.memberLabels}</p>}
      <p className="mt-2 line-clamp-3 break-words text-compact text-cafe-muted">{profileText(entry.content)}</p>
      <div className="mt-2 flex flex-wrap justify-between gap-2 text-xs text-cafe-muted">
        <span>{profileSections(entry.content).length} 个小节 · 按需回看</span>
        {entry.updatedAt !== undefined && <span>{formatMemoryDate(entry.updatedAt)} 更新</span>}
      </div>
      {pending?.[0] && <CapsulePendingLabel proposal={pending[0]} />}
    </MemoryProfileCardFrame>
  );
}
