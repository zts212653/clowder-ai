'use client';

import type { SuggestionOpenTarget, SuggestionView } from '@cat-cafe/shared';
import { type ReactNode, useState } from 'react';
import { AppTooltip } from '@/components/AppTooltip';
import { useWorkCardOpen } from '@/components/artifacts/useWorkCardOpen';
import { useCatData } from '@/hooks/useCatData';
import { resolveAvatarUrl } from '@/lib/avatar-url';
import { useChatStore } from '@/stores/chatStore';
import { useShellCopy } from '../shell/shell-copy';
import { suggestionCopy } from './suggestion-copy';
import { decideSuggestion, rowForMessage, type SuggestionDecision, useSuggestionStore } from './suggestion-store';

const EyeIcon = () => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2.4"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M2 12s3.6-6 10-6 10 6 10 6-3.6 6-10 6S2 12 2 12Z" />
    <circle cx="12" cy="12" r="2.6" fill="currentColor" stroke="none" />
  </svg>
);

const CloseIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
    <path d="M6 6l12 12M18 6L6 18" strokeLinecap="round" />
  </svg>
);

/** Who is speaking on the row: the cat's avatar; the watcher carries the eye badge (F335 4a 标识). */
export function SuggestionAvatar({ catId, watcher }: { catId: string; watcher: boolean }) {
  const { getCatById } = useCatData();
  const src = resolveAvatarUrl(getCatById(catId)?.avatar || '/avatars/default.png');
  return (
    <span className="w-av" data-watcher={watcher ? 'true' : undefined}>
      {/* biome-ignore lint/performance/noImgElement: 16px member avatar, same source as CatAvatar */}
      <img src={src} width={16} height={16} alt="" />
      {watcher ? (
        <span className="eye">
          <EyeIcon />
        </span>
      ) : null}
    </span>
  );
}

function useOpenTarget(target: SuggestionOpenTarget | undefined, messageId: string) {
  const work = target?.kind === 'work' ? target : undefined;
  const opening = useWorkCardOpen(
    work ? { contentRef: work.contentRef, ownerRevision: work.ownerRevision } : undefined,
    work?.title ?? '',
    messageId,
  );
  const setWorkspaceMode = useChatStore((state) => state.setWorkspaceMode);
  if (!target) return undefined;
  return () => {
    if (target.kind === 'work') void opening.open('work-mode');
    else setWorkspaceMode(target.mode);
  };
}

/**
 * F335 交付二：回话下面那一排。一条消息最多一行：提议（一点就用、× 忽略）、点了之后的原地回执（可撤销），
 * 或猫直接挂的回执（「已暂停至 02:10 · 恢复」）。不弹窗、不进 Needs Me。
 */
export function SuggestionRow({
  threadId,
  messageId,
  align = 'start',
}: {
  threadId: string;
  messageId: string;
  align?: 'start' | 'end';
}) {
  const row = useSuggestionStore((state) => rowForMessage(state.byThread[threadId], messageId));
  if (!row || (row.state === 'ignored' && !row.watcherSupplement)) return null;
  return <SuggestionRowBody row={row} align={align} />;
}

function SuggestionRowBody({ row, align }: { row: SuggestionView; align: 'start' | 'end' }) {
  const copy = useShellCopy(suggestionCopy);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const open = useOpenTarget(row.receipt?.open, row.messageId);
  const inert = busy || row.state === 'applying' || row.state === 'undoing';
  const decide = async (decision: SuggestionDecision) => {
    setBusy(true);
    setError(null);
    const result = await decideSuggestion(row, decision).catch((reason: unknown) => ({
      ok: false as const,
      error: reason instanceof Error ? reason.message : String(reason),
    }));
    setBusy(false);
    if (!result.ok) setError(result.error);
  };
  const avatar = <SuggestionAvatar catId={row.catId} watcher={row.byline === 'watcher'} />;
  const supplement = row.watcherSupplement ? (
    <>
      <SuggestionAvatar catId={row.watcherSupplement.catId} watcher />
      <span>{row.watcherSupplement.text}</span>
    </>
  ) : null;
  const place = align === 'end' ? ' w-row-end' : '';
  const failure = error ? (
    <span className="w-row-error" role="alert">
      {copy.failed}：{error}
    </span>
  ) : null;

  if (row.state === 'ignored')
    return (
      <div className={`w-rcpt${place}`} data-testid="suggestion-row">
        {supplement}
      </div>
    );
  if (row.state === 'open' || row.state === 'applying') {
    return (
      <div className={`w-sugg${place}`} data-testid="suggestion-row" data-state={row.state} aria-busy={inert}>
        {avatar}
        <button type="button" className="pill" disabled={inert} onClick={() => void decide('apply')}>
          {row.label}
        </button>
        <AppTooltip label={copy.dismiss} side="bottom">
          <button
            type="button"
            className="x"
            aria-label={copy.dismiss}
            disabled={inert}
            onClick={() => void decide('dismiss')}
          >
            <CloseIcon />
          </button>
        </AppTooltip>
        {supplement}
        {failure}
      </div>
    );
  }

  return (
    <ReceiptRow
      row={row}
      className={`w-rcpt${place}`}
      avatar={avatar}
      open={open}
      inert={inert}
      failure={failure}
      supplement={supplement}
      onUndo={() => void decide('undo')}
    />
  );
}

function receiptText(row: SuggestionView, copy: { dismissed: string; resumed: string; undone: string }): string {
  if (row.state === 'dismissed') return copy.dismissed;
  if (row.state !== 'undone') return row.receipt?.text ?? row.label;
  return row.undo === 'resume' ? copy.resumed : copy.undone;
}

/** 原地回执：做完的「已添加 7 条批注 › · 撤销」、「已忽略 · 撤销」、猫直接挂的「已暂停至 02:10 · 恢复」。 */
function ReceiptRow({
  row,
  className,
  avatar,
  open,
  inert,
  failure,
  supplement,
  onUndo,
}: {
  row: SuggestionView;
  className: string;
  avatar: ReactNode;
  open: (() => void) | undefined;
  inert: boolean;
  failure: ReactNode;
  supplement: ReactNode;
  onUndo: () => void;
}) {
  const copy = useShellCopy(suggestionCopy);
  const resume = row.undo === 'resume';
  const settled = row.state === 'dismissed' || row.state === 'undone';
  const text = receiptText(row, copy);
  const canUndo = row.state === 'dismissed' || ((row.state === 'applied' || row.state === 'undoing') && row.undo);
  // The undo is the row's only action when there is nothing to open (「已暂停至 02:10 · 恢复」).
  const emphasiseUndo = !open && row.state !== 'dismissed';
  return (
    <div className={className} data-testid="suggestion-row" data-state={row.state} aria-busy={inert}>
      {avatar}
      {row.state === 'applied' && !row.receiptOnly ? <span className="ok" aria-hidden="true" /> : null}
      {open && !settled ? (
        <button type="button" className="link" onClick={open}>
          {text} ›
        </button>
      ) : (
        <span>{text}</span>
      )}
      {canUndo ? (
        <button type="button" className={`ghost${emphasiseUndo ? ' primary' : ''}`} disabled={inert} onClick={onUndo}>
          {resume && row.state !== 'dismissed' ? copy.resume : copy.undo}
        </button>
      ) : null}
      {supplement}
      {failure}
    </div>
  );
}
