import type { ProfileMemoryOwnerBrowse } from '@cat-cafe/shared';
import { splitUserCapsule, userCapsuleCharacterCount } from '@cat-cafe/shared/profile-contract';
import { useEffect, useId, useRef, useState } from 'react';
import { capsulePrimary, capsuleSecondary, MemoryCapsuleEditor } from './MemoryCapsuleEditor';
import { CapsulePendingLabel, MemoryCapsuleProposals, pendingCapsuleProposals } from './MemoryCapsuleProposals';
import { MemoryForgetControl, MemoryOwnerFeedback } from './MemoryOwnerControls';
import { MemoryProfileCardFrame } from './MemoryProfileCardFrame';
import { MemoryProfileSource } from './MemoryProfileSource';
import { MemoryReadState } from './MemoryReadState';
import {
  isProfileBrowse,
  isProfileEntry,
  type ProfileMemoryBrowseRead,
  type ProfileMemoryRead,
} from './owner-memory-read';
import { useMemoryOwnerAction } from './use-memory-owner-action';
import { formatMemoryDate, useMemoryRead } from './use-memory-read';
import { useProfileProposalRefresh } from './use-profile-proposal-refresh';

export function MemoryCapsuleCard({
  entry,
  setup,
  selected,
  select,
}: {
  entry?: ProfileMemoryRead;
  setup?: ProfileMemoryOwnerBrowse['capsuleSetup'];
  selected: boolean;
  select: () => void;
}) {
  const pending = pendingCapsuleProposals(entry?.proposals ?? setup?.proposals);
  return (
    <MemoryProfileCardFrame selected={selected} select={select}>
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={select}
          aria-pressed={selected}
          className="shell-focusable text-left text-base font-medium"
        >
          关于你
        </button>
        <span className="rounded-full bg-cafe-surface-sunken px-2 py-0.5 text-xs">每场新对话带上</span>
      </div>
      {pending?.[0] && <CapsulePendingLabel proposal={pending[0]} />}
      <p className="mt-2 line-clamp-3 break-words text-compact text-cafe-muted">
        {entry ? splitUserCapsule(entry.content).body : setup ? '还没有填写' : '暂时读不到关于你'}
      </p>
      {entry && (
        <p className="mt-2 text-xs text-cafe-muted">
          全部猫通用 · {userCapsuleCharacterCount(entry.content)} / 300 字
          {entry.updatedAt !== undefined ? ` · ${formatMemoryDate(entry.updatedAt)} 修改` : ''}
        </p>
      )}
    </MemoryProfileCardFrame>
  );
}

function CapsuleHelp() {
  const [open, setOpen] = useState(false);
  const id = useId();
  const explanation = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (open) explanation.current?.scrollIntoView?.({ block: 'nearest' });
  }, [open]);
  return (
    <span className="relative">
      <button
        type="button"
        aria-label="关于你的使用说明"
        aria-expanded={open}
        aria-controls={id}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            setOpen(false);
            event.stopPropagation();
          }
        }}
        className="shell-focusable inline-flex h-5 w-5 items-center justify-center rounded-full border border-cafe-subtle text-xs text-cafe-muted"
        onClick={() => setOpen(!open)}
      >
        ?
      </button>
      {open && (
        <span
          ref={explanation}
          id={id}
          role="note"
          className="absolute bottom-7 right-0 z-10 block w-64 rounded-xl border border-cafe-subtle bg-[var(--console-card-bg)] p-3 text-compact font-normal text-cafe shadow-md"
        >
          猫在新对话开场时会读到这段，最多 300
          字，空白不计。内容只存在你自己的资料里，其他账号看不到。猫可以起草新版本，你确认后才替换。
        </span>
      )}
    </span>
  );
}

export function MemoryCapsuleDetail({
  entry,
  close,
  reload,
  onDirtyChange,
}: {
  entry?: ProfileMemoryRead;
  close: () => void;
  reload: () => void;
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const panel = useRef<HTMLElement>(null);
  useEffect(() => {
    if (window.innerWidth < 1024) panel.current?.scrollIntoView?.({ block: 'start' });
  }, []);
  const path = '/api/memory/profile/capsule';
  const read = useMemoryRead<ProfileMemoryRead | ProfileMemoryBrowseRead>(
    entry ? `${path}?revision=${encodeURIComponent(entry.revision)}` : '/api/memory/profile',
    entry ? isProfileEntry : isProfileBrowse,
  );
  const browse = read.data && 'entries' in read.data ? read.data : undefined;
  const current = browse
    ? browse.entries.find((item) => item.id === 'capsule')
    : read.data && 'id' in read.data && read.data.id === 'capsule'
      ? read.data
      : undefined;
  const setup = browse?.capsuleSetup;
  const revision = current?.revision ?? setup?.revision;
  const content = current?.content ?? '';
  const proposals = pendingCapsuleProposals(current?.proposals ?? setup?.proposals);
  const ready = !read.loading && !read.error && !!revision;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [message, setMessage] = useState('');
  const [leaving, setLeaving] = useState(false);
  useEffect(() => {
    onDirtyChange?.(editing && draft !== splitUserCapsule(content).body);
  }, [editing, draft, content, onDirtyChange]);
  const action = useMemoryOwnerAction(`${path}/actions`, 'capsule', (receipt) => {
    setEditing(false);
    setMessage(receipt.action === 'hard_forget' ? '已遗忘这段。' : '已保存 · 从下一个新对话开始生效');
    // Pinned details refresh after the owner list supplies the new revision.
    if (!entry) read.retry();
    reload();
  });
  const proposalIds = proposals?.map((proposal) => proposal.proposalId).join(',') ?? '';
  useProfileProposalRefresh(proposalIds, editing, read.retry, reload);
  const startEditing = () => {
    setDraft(splitUserCapsule(content).body);
    setEditing(true);
    setMessage('');
  };
  return (
    <aside
      ref={panel}
      aria-label="画像详情"
      className="min-w-0 space-y-4 rounded-xl border border-cafe-subtle bg-[var(--console-card-bg)] p-4 md:p-6"
    >
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs text-cafe-muted">每场新对话自动带上 · 全部猫通用</p>
        <button
          type="button"
          className="shell-focusable text-compact text-cafe-accent underline lg:hidden"
          disabled={action.busy}
          onClick={() => (editing && draft !== splitUserCapsule(content).body ? setLeaving(true) : close())}
        >
          返回画像
        </button>
      </div>
      {leaving && (
        <div className="space-y-2 rounded-lg bg-cafe-surface-sunken p-3 text-compact">
          <p>修改还没保存。</p>
          <button type="button" className={capsuleSecondary} onClick={() => setLeaving(false)}>
            继续编辑
          </button>{' '}
          <button type="button" className={capsuleSecondary} onClick={close}>
            放弃并返回
          </button>
        </div>
      )}
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-display-sm">关于你</h3>
        <div className="flex items-center gap-3">
          {!editing && ready && (current || !!proposals?.length) && (
            <button type="button" className={capsuleSecondary} disabled={action.blocked} onClick={startEditing}>
              {current ? '编辑' : '自己填写'}
            </button>
          )}
          <CapsuleHelp />
        </div>
      </div>
      <p className="text-compact text-cafe-muted">
        每次开始新对话时，猫会先读到这段。你可以随时直接编辑；猫起草的更新会在待办「等你决定」。
      </p>
      <MemoryReadState
        loading={read.loading}
        error={read.error || (!read.loading && !revision)}
        empty={false}
        noun="关于你"
        retry={() => {
          read.retry();
          reload();
        }}
      />
      {!editing && message && <output className="block text-compact">{message}</output>}
      {editing ? (
        <MemoryCapsuleEditor
          value={draft}
          change={setDraft}
          original={content}
          revision={revision}
          ready={ready}
          action={action}
          cancel={() => {
            setEditing(false);
            action.reset();
            setMessage('');
          }}
          reread={() => {
            action.reset();
            read.retry();
            reload();
            setMessage('请核对最新版本后再保存；你的修改还在。');
          }}
          message={message}
          setMessage={setMessage}
        />
      ) : (
        ready && (
          <>
            {current?.updatedAt !== undefined && (
              <p className="text-xs text-cafe-muted">上次修改 {formatMemoryDate(current.updatedAt)}</p>
            )}
            {!proposals?.length &&
              (current ? (
                <section aria-label="现在生效的内容" className="space-y-3 border-t border-cafe-subtle pt-3">
                  <div className="flex justify-between text-xs text-cafe-muted">
                    <span>现在生效的内容</span>
                    <span>{userCapsuleCharacterCount(content)} / 300 字</span>
                  </div>
                  <ol className="space-y-2 rounded-xl border border-cafe-subtle bg-cafe-surface p-4 text-sm leading-relaxed">
                    {splitUserCapsule(content)
                      .body.split(/\n+/)
                      .filter(Boolean)
                      .map((line, index) => (
                        <li key={`${index}:${line}`} className="flex gap-3">
                          <span className="text-cafe-accent">{index + 1}</span>
                          <span className="min-w-0 break-words">{line}</span>
                        </li>
                      ))}
                  </ol>
                </section>
              ) : (
                <>
                  <p className="text-sm">猫在新对话开场时会读到这段。现在还是空的。</p>
                  <button type="button" className={capsulePrimary} onClick={startEditing}>
                    添加关于你
                  </button>
                  <p className="text-compact text-cafe-muted">也可以在对话里请猫起草，起草的版本会在这里等你确认。</p>
                </>
              ))}
            {!!proposals?.length && revision && (
              <MemoryCapsuleProposals proposals={proposals} current={content} revision={revision} />
            )}
            {current && (
              <MemoryProfileSource
                opening
                endpoint={`${path}/source?revision=${encodeURIComponent(current.revision)}`}
              />
            )}
            <MemoryOwnerFeedback
              action={action}
              reread={() => {
                read.retry();
                reload();
              }}
            />
            {(current || !!proposals?.length) && (
              <div className="flex flex-wrap items-start justify-between gap-3 border-t border-cafe-subtle pt-3">
                {current && (
                  <MemoryForgetControl revision={current.revision} noun="关于你" action={action} retainedAudit quiet />
                )}
              </div>
            )}
          </>
        )
      )}
    </aside>
  );
}
