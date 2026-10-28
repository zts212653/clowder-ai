import { readProfileOpeningReference, splitProfileBody } from '@cat-cafe/shared/profile-opening-reference';
import { useEffect, useRef, useState } from 'react';
import { CatAvatar } from '@/components/CatAvatar';
import { useCatData } from '@/hooks/useCatData';
import { capsuleSecondary } from './MemoryCapsuleEditor';
import { MemoryForgetControl, MemoryOwnerFeedback } from './MemoryOwnerControls';
import { MemoryProfileBody } from './MemoryProfileBody';
import { MemoryProfileEditor } from './MemoryProfileEditor';
import { MemoryProfileOpening } from './MemoryProfileOpening';
import { MemoryProfileProposals } from './MemoryProfileProposals';
import { MemoryProfileSource } from './MemoryProfileSource';
import { MemoryReadState } from './MemoryReadState';
import { isProfileEntry, type ProfileMemoryRead } from './owner-memory-read';
import { profileIdentity } from './profile-presentation';
import { useMemoryOwnerAction } from './use-memory-owner-action';
import { formatMemoryDate, useMemoryRead } from './use-memory-read';
import { useProfileProposalRefresh } from './use-profile-proposal-refresh';

export function ProfileDetail({
  entry,
  close,
  reload,
  onDirtyChange,
}: {
  entry: ProfileMemoryRead;
  close: () => void;
  reload: () => void;
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const panel = useRef<HTMLElement>(null);
  useEffect(() => {
    if (window.innerWidth < 1024) panel.current?.scrollIntoView?.({ block: 'start' });
  }, []);
  const path = `/api/memory/profile/${encodeURIComponent(entry.id)}`;
  const detail = useMemoryRead<ProfileMemoryRead>(
    `${path}?revision=${encodeURIComponent(entry.revision)}`,
    isProfileEntry,
  );
  const [editing, setEditing] = useState(false);
  const [content, setContent] = useState(entry.content);
  const action = useMemoryOwnerAction(`${path}/actions`, entry.id, () => {
    setEditing(false);
    reload();
  });
  const data = detail.data;
  const { cats = [], hasFetched } = useCatData();
  const identity = profileIdentity(data ?? entry, cats, hasFetched);
  useEffect(() => {
    onDirtyChange?.(editing && content !== splitProfileBody(entry.content).body);
  }, [editing, content, entry.content, onDirtyChange]);
  const proposalIds = data?.proposals?.map((proposal) => proposal.proposalId).join(',') ?? '';
  useProfileProposalRefresh(proposalIds, editing, detail.retry, reload);
  const opening = data?.layer === 'primer' ? readProfileOpeningReference(data.content) : null;
  return (
    <aside
      ref={panel}
      aria-label="画像详情"
      className="min-w-0 space-y-4 rounded-xl border border-cafe-subtle bg-[var(--console-card-bg)] p-4 md:p-6"
    >
      <div className="flex justify-between gap-3 lg:hidden">
        <h2 className="text-base font-medium">画像详情</h2>
        <button type="button" onClick={close} className="text-compact text-cafe-accent underline lg:hidden">
          返回画像
        </button>
      </div>
      <MemoryReadState
        loading={detail.loading}
        error={detail.error}
        empty={false}
        noun="画像详情"
        retry={detail.retry}
      />
      <MemoryOwnerFeedback action={action} reread={reload} />
      {data && (
        <>
          <div className="flex flex-wrap items-center gap-2">
            {identity.members.map((cat) => (
              <CatAvatar key={cat.id} catId={cat.id} size={28} ring="none" />
            ))}
            <h3 className="text-display-sm">{identity.title}</h3>
            {!editing && (
              <button
                type="button"
                disabled={action.blocked}
                className={`ml-auto ${capsuleSecondary}`}
                onClick={() => {
                  setContent(splitProfileBody(data.content).body);
                  setEditing(true);
                }}
              >
                编辑
              </button>
            )}
          </div>
          {identity.memberNotice && <p className="text-xs text-cafe-muted">{identity.memberNotice}</p>}
          <p className="text-xs text-cafe-muted">
            {data.layer === 'corpus' ? '全部猫通用 · 按需回看' : identity.memberLabels || '按需回看'}
            {data.updatedAt !== undefined ? ` · ${formatMemoryDate(data.updatedAt)} 更新` : ''}
          </p>
          {opening && (
            <MemoryProfileOpening reference={opening} content={data.content} revision={data.revision} action={action} />
          )}
          {data.layer === 'primer' && !opening && (
            <p className="text-compact text-cafe-muted">关系材料按需回看。可以在对话里请猫挑选开场参考，确认后生效。</p>
          )}
          {editing ? (
            <MemoryProfileEditor
              entry={data}
              value={content}
              change={setContent}
              cancel={() => setEditing(false)}
              action={action}
            />
          ) : (
            <>
              <MemoryProfileBody content={data.content} />
              <MemoryProfileSource endpoint={`${path}/source?revision=${encodeURIComponent(data.revision)}`} />
              <MemoryProfileProposals proposals={data.proposals} revision={data.revision} current={data.content} />
              <MemoryForgetControl revision={data.revision} noun="画像" action={action} retainedAudit quiet />
            </>
          )}
        </>
      )}
    </aside>
  );
}
