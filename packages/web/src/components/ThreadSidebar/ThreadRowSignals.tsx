'use client';

import { useCatData } from '@/hooks/useCatData';
import type { SidebarPresence } from '@/stores/sidebarProjectionStore';
import { knownCatName, ShellCatAvatar } from '../shell/ShellCatAvatar';
import { ShellGlyph } from '../shell/ShellIcons';

interface RowSignalInput {
  presence: SidebarPresence;
  unreadCount: number;
  hasUserMention: boolean;
  hasDraft: boolean;
}

/** True when a v2 row has anything to say on its second line. */
export function hasThreadRowSignals(input: RowSignalInput): boolean {
  return input.presence.status !== 'idle' || input.unreadCount > 0 || input.hasUserMention || input.hasDraft;
}

function workingLabel(cats: readonly string[], knownName: string | null, activeSince?: number): string {
  const base = !knownName
    ? '猫猫正在工作'
    : cats.length > 1
      ? `${knownName} 等 ${cats.length} 只猫正在工作`
      : `${knownName} 正在工作`;
  // The row's time column is "last active"; how long the current run has lasted is its own fact.
  return activeSince === undefined
    ? base
    : `${base} · ${Math.max(0, Math.floor((Date.now() - activeSince) / 60_000))}分`;
}

/** The single presence state. Words carry the meaning; colour is only a redundant cue. */
function PresenceState({ presence }: { presence: SidebarPresence }) {
  const { getCatById } = useCatData();
  const cats = [...new Set(presence.cats ?? [])];
  const firstId = cats[0];
  // An unknown cat id is never printed or used as alt text: no known name means the row says "Clowder AI".
  const knownName = firstId ? knownCatName(firstId, getCatById) : null;

  if (presence.status === 'error') {
    return (
      <span className="inline-flex items-center gap-1.5" data-testid="thread-row-error">
        <span
          aria-hidden="true"
          className="h-2 w-2 flex-none rounded-full"
          style={{ background: 'var(--semantic-critical)' }}
        />
        <span style={{ color: 'var(--shell-body)' }}>出错</span>
      </span>
    );
  }
  if (presence.status === 'working') {
    return (
      <span className="inline-flex min-w-0 items-center gap-1.5" data-testid="thread-row-working">
        {firstId ? <ShellCatAvatar catId={firstId} size={14} /> : null}
        <span className="truncate">{workingLabel(cats, knownName, presence.activeSince)}</span>
      </span>
    );
  }
  if (presence.status === 'done') {
    return (
      <span className="inline-flex items-center gap-1" data-testid="thread-row-done">
        <ShellGlyph name="checkSquare" className="h-3 w-3" />
        <span>已回复</span>
      </span>
    );
  }
  return null;
}

const PILL = 'rounded-full px-1.5 py-px text-label font-semibold leading-4';

/** @你 and unread are independent of the presence state on the left. */
function SignalPills({ unreadCount, hasUserMention }: { unreadCount: number; hasUserMention: boolean }) {
  if (!hasUserMention && unreadCount === 0) return null;
  const unreadText = unreadCount > 99 ? '99+' : String(unreadCount);
  return (
    <div className="flex flex-none items-center gap-1">
      {hasUserMention && (
        <span
          className={PILL}
          style={{ background: 'var(--shell-primary-soft)', color: 'var(--shell-primary-text)' }}
          data-testid="thread-row-mention"
        >
          @你
        </span>
      )}
      {unreadCount > 0 && (
        <span
          className={PILL}
          style={{ background: 'var(--shell-selected)', color: 'var(--shell-ink)' }}
          data-testid="thread-row-unread"
        >
          {unreadText}
          <span className="sr-only"> 条未读</span>
        </span>
      )}
    </div>
  );
}

/**
 * Café 1.6 conversation row — second line (DESIGN.md "对话列表").
 * Left: ONE presence state (出错 / 某猫正在工作 / 已回复 — they cannot co-occur) + optional 草稿.
 * Right: @你 and unread. It never writes "正在回复": presence only proves work is going on.
 */
export function ThreadRowSignals(props: RowSignalInput) {
  if (!hasThreadRowSignals(props)) return null;
  const { presence, unreadCount, hasUserMention, hasDraft } = props;
  return (
    <div className="mt-1 flex min-w-0 items-center gap-2 text-xs" data-testid="thread-row-signals">
      <div className="flex min-w-0 flex-1 items-center gap-1.5" style={{ color: 'var(--shell-muted)' }}>
        <PresenceState presence={presence} />
        {hasDraft && (
          <>
            {presence.status !== 'idle' && <span aria-hidden="true">·</span>}
            <span data-testid="thread-row-draft">草稿</span>
          </>
        )}
      </div>
      <SignalPills unreadCount={unreadCount} hasUserMention={hasUserMention} />
    </div>
  );
}
