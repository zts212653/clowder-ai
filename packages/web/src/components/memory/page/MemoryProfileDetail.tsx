import { readProfileOpeningReference, splitProfileBody } from '@cat-cafe/shared/profile-opening-reference';
import { useEffect, useRef, useState } from 'react';
import { MemoryProfileProposals } from './MemoryOriginalProposals';
import { MemoryForgetControl, MemoryOwnerFeedback, MemoryOwnerSource } from './MemoryOwnerControls';
import { MemoryProfileOpening } from './MemoryProfileOpening';
import { MemoryReadState } from './MemoryReadState';
import { isProfileEntry, type ProfileMemoryRead } from './owner-memory-read';
import { useMemoryOwnerAction } from './use-memory-owner-action';
import { useMemoryRead } from './use-memory-read';

export function ProfileDetail({
  entry,
  close,
  reload,
}: {
  entry: ProfileMemoryRead;
  close: () => void;
  reload: () => void;
}) {
  const panel = useRef<HTMLElement>(null);
  useEffect(() => {
    panel.current?.scrollIntoView?.({ block: 'start' });
  }, []);
  const path = `/api/memory/profile/${encodeURIComponent(entry.id)}`;
  const detail = useMemoryRead<ProfileMemoryRead>(
    `${path}?revision=${encodeURIComponent(entry.revision)}`,
    isProfileEntry,
  );
  const [editing, setEditing] = useState(false);
  const [content, setContent] = useState(entry.content);
  const action = useMemoryOwnerAction(`${path}/actions`, entry.id, () => {
    close();
    reload();
  });
  const data = detail.data;
  const opening = data?.layer === 'primer' ? readProfileOpeningReference(data.content) : null;
  return (
    <aside
      ref={panel}
      aria-label="画像详情"
      className="space-y-4 rounded-xl border border-cafe-subtle bg-[var(--console-card-bg)] p-4 md:p-6"
    >
      <div className="flex justify-between gap-3">
        <h2 className="text-base font-medium">画像详情</h2>
        <button type="button" onClick={close} className="text-compact text-cafe-accent underline">
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
          <h3 className="text-display-sm">{data.title}</h3>
          {opening && (
            <MemoryProfileOpening reference={opening} content={data.content} revision={data.revision} action={action} />
          )}
          {data.layer === 'primer' && !opening && (
            <p className="text-compact text-cafe-muted">关系材料按需回看。可以在对话里请猫挑选开场参考，确认后生效。</p>
          )}
          <p className="whitespace-pre-wrap break-words text-sm">{splitProfileBody(data.content).body}</p>
          <MemoryOwnerSource endpoint={`${path}/source?revision=${encodeURIComponent(data.revision)}`} />
          <MemoryProfileProposals proposals={data.proposals} revision={data.revision} />
          <button
            type="button"
            disabled={action.blocked}
            onClick={() => {
              setContent(splitProfileBody(data.content).body);
              setEditing(!editing);
            }}
            className="text-compact text-cafe-accent underline"
          >
            修改画像
          </button>
          {editing && (
            <form
              className="space-y-3"
              onSubmit={(event) => {
                event.preventDefault();
                if (content.trim())
                  action.submit({
                    action: 'replace_content',
                    expectedRevision: data.revision,
                    content: splitProfileBody(data.content).prefix + content,
                  });
              }}
            >
              <label className="block text-compact">
                画像内容
                <textarea
                  aria-label="画像内容"
                  required
                  maxLength={20000}
                  value={content}
                  onChange={(event) => setContent(event.target.value)}
                  className="mt-1 min-h-40 w-full rounded-lg border border-cafe-subtle bg-cafe-surface-sunken p-3"
                />
              </label>
              <button type="submit" disabled={action.blocked} className="text-compact text-cafe-accent underline">
                保存画像
              </button>
            </form>
          )}
          <MemoryForgetControl revision={data.revision} noun="画像" action={action} retainedAudit />
        </>
      )}
    </aside>
  );
}
