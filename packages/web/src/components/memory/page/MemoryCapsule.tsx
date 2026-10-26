import type { ProfileMemoryOwnerBrowse } from '@cat-cafe/shared';
import { splitUserCapsule } from '@cat-cafe/shared/profile-contract';
import { useEffect, useId, useRef, useState } from 'react';
import { capsulePrimary, capsuleSecondary, MemoryCapsuleEditor } from './MemoryCapsuleEditor';
import { CapsulePendingLabel, MemoryCapsuleProposals, pendingCapsuleProposals } from './MemoryCapsuleProposals';
import { MemoryForgetControl, MemoryOwnerFeedback, MemoryOwnerSource } from './MemoryOwnerControls';
import { MemoryReadState } from './MemoryReadState';
import {
  isProfileBrowse,
  isProfileEntry,
  type ProfileMemoryBrowseRead,
  type ProfileMemoryRead,
} from './owner-memory-read';
import { useMemoryOwnerAction } from './use-memory-owner-action';
import { formatMemoryDate, useMemoryRead } from './use-memory-read';

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
    <article className="rounded-xl border border-cafe-subtle bg-[var(--console-card-bg)] p-4">
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={select}
          aria-pressed={selected}
          className="shell-focusable text-left text-base font-medium"
        >
          开场简介
        </button>
        <span className="rounded-full bg-cafe-surface-sunken px-2 py-0.5 text-xs">新对话开场</span>
      </div>
      {pending?.[0] && <CapsulePendingLabel proposal={pending[0]} />}
      <p className="mt-2 line-clamp-3 break-words text-compact text-cafe-muted">
        {entry ? splitUserCapsule(entry.content).body : setup ? '还没有填写' : '暂时读不到开场简介'}
      </p>
    </article>
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
        aria-label="关于开场简介"
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
}: {
  entry?: ProfileMemoryRead;
  close: () => void;
  reload: () => void;
}) {
  const panel = useRef<HTMLElement>(null);
  useEffect(() => {
    panel.current?.scrollIntoView?.({ block: 'start' });
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
  const action = useMemoryOwnerAction(`${path}/actions`, 'capsule', (receipt) => {
    setEditing(false);
    setMessage(receipt.action === 'hard_forget' ? '已遗忘这段。' : '已保存 · 从下一个新对话开始生效');
    // Pinned details refresh after the owner list supplies the new revision.
    if (!entry) read.retry();
    reload();
  });
  const proposalIds = proposals?.map((proposal) => proposal.proposalId).join(',') ?? '';
  useEffect(() => {
    const refresh = (event: Event) => {
      const id = (event as CustomEvent<{ proposalId?: string }>).detail?.proposalId;
      if (id && proposalIds.split(',').includes(id)) {
        read.retry();
        reload();
      }
    };
    window.addEventListener('cat-cafe:proposal-updated', refresh);
    return () => window.removeEventListener('cat-cafe:proposal-updated', refresh);
  }, [proposalIds, read.retry, reload]);
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
        <h2 className="text-xs text-cafe-muted">画像详情</h2>
        <button
          type="button"
          className="shell-focusable text-compact text-cafe-accent underline"
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
        <h3 className="text-display-sm">{editing ? '编辑开场简介' : '开场简介'}</h3>
        <CapsuleHelp />
      </div>
      <MemoryReadState
        loading={read.loading}
        error={read.error || (!read.loading && !revision)}
        empty={false}
        noun="开场简介"
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
                <p className="whitespace-pre-wrap break-words text-sm leading-relaxed">
                  {splitUserCapsule(content).body}
                </p>
              ) : (
                <>
                  <p className="text-sm">猫在新对话开场时会读到这段。现在还是空的。</p>
                  <button type="button" className={capsulePrimary} onClick={startEditing}>
                    添加开场简介
                  </button>
                  <p className="text-compact text-cafe-muted">也可以在对话里请猫起草，起草的版本会在这里等你确认。</p>
                </>
              ))}
            {!!proposals?.length && revision && (
              <MemoryCapsuleProposals proposals={proposals} current={content} revision={revision} />
            )}
            {current && (
              <MemoryOwnerSource endpoint={`${path}/source?revision=${encodeURIComponent(current.revision)}`} />
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
                  <MemoryForgetControl revision={current.revision} noun="开场简介" action={action} retainedAudit />
                )}
                <button type="button" className={capsuleSecondary} disabled={action.blocked} onClick={startEditing}>
                  {current ? '编辑' : '自己填写'}
                </button>
              </div>
            )}
          </>
        )
      )}
    </aside>
  );
}
