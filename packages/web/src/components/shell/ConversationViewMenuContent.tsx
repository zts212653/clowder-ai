import type { ConversationViewPreference } from '@cat-cafe/shared';
import type { RefObject } from 'react';
import type { ConversationViewPreferenceController } from '@/hooks/useConversationViewPreference';
import { conversationViewCopy } from './conversation-view.shell-copy';
import { ShellCatAvatar } from './ShellCatAvatar';
import { ShellGlyph } from './ShellIcons';

const SHOWN_AVATARS = 3;
type ConversationViewWords = typeof conversationViewCopy.zh;

export function ConversationViewTrigger({
  triggerRef,
  open,
  onToggle,
  visibleView,
  visibleName,
  participants,
  runningCatIds,
  words,
}: {
  triggerRef: RefObject<HTMLButtonElement>;
  open: boolean;
  onToggle: () => void;
  visibleView: ConversationViewPreference;
  visibleName: string;
  participants: readonly string[];
  runningCatIds: ReadonlySet<string>;
  words: ConversationViewWords;
}) {
  const avatarIds = visibleView.mode === 'cat' ? [visibleView.catId] : participants.slice(0, SHOWN_AVATARS);
  return (
    <button
      ref={triggerRef}
      type="button"
      aria-haspopup="menu"
      aria-expanded={open}
      aria-label={`${words.currentView}：${visibleName}`}
      data-testid="conversation-view-menu-toggle"
      onClick={onToggle}
      className="shell-rail-item shell-focusable inline-flex h-8 max-w-[12rem] items-center gap-1.5 rounded-lg px-2 text-xs"
      style={{ color: 'var(--shell-body)' }}
    >
      <span className="hidden flex-none items-center sm:flex" aria-hidden="true">
        {avatarIds.map((catId, index) => (
          <span
            key={catId}
            className="relative inline-flex rounded-full"
            style={{ marginLeft: index === 0 ? 0 : -5, boxShadow: '0 0 0 2px var(--shell-work)' }}
          >
            <ShellCatAvatar catId={catId} size={20} />
            {runningCatIds.has(catId) ? <RunningDot overlay /> : null}
          </span>
        ))}
      </span>
      <span className="min-w-0 truncate font-medium" data-conversation-view-current={visibleView.mode}>
        {visibleName}
      </span>
      <ShellGlyph name="chevronDown" className="h-3 w-3 flex-none" />
    </button>
  );
}

export function ConversationViewOptions({
  participants,
  runningCatIds,
  availableCatIds,
  visibleView,
  controller,
  resolveName,
  select,
  words,
}: {
  participants: readonly string[];
  runningCatIds: ReadonlySet<string>;
  availableCatIds: ReadonlySet<string>;
  visibleView: ConversationViewPreference;
  controller: ConversationViewPreferenceController;
  resolveName: (catId: string) => string;
  select: (view: ConversationViewPreference) => Promise<void>;
  words: ConversationViewWords;
}) {
  const busy = controller.loading || controller.saving;
  return (
    <div
      role="menu"
      aria-label={words.menuLabel}
      data-testid="conversation-view-menu"
      className="fixed left-3 right-3 top-[3.25rem] z-[60] max-h-[calc(100dvh-4rem)] w-auto overflow-y-auto overscroll-contain rounded-xl p-1.5 sm:absolute sm:left-auto sm:right-0 sm:top-9 sm:w-[min(18rem,calc(100vw-1.5rem))]"
      style={{
        background: 'var(--shell-paper)',
        border: '1px solid var(--shell-hairline-strong)',
        boxShadow: '0 4px 10px rgb(20 20 19 / 0.1)',
      }}
    >
      <GroupViewItem selected={visibleView.mode === 'group'} busy={busy} select={select} label={words.group} />
      <div className="my-1 h-px" style={{ background: 'var(--shell-hairline)' }} />
      {participants.map((catId) => (
        <CatViewItem
          key={catId}
          catId={catId}
          name={resolveName(catId)}
          available={availableCatIds.has(catId)}
          running={runningCatIds.has(catId)}
          selected={visibleView.mode === 'cat' && visibleView.catId === catId}
          busy={busy}
          select={select}
          words={words}
        />
      ))}
      <ConversationViewStatus controller={controller} words={words} />
    </div>
  );
}

function GroupViewItem({
  selected,
  busy,
  select,
  label,
}: {
  selected: boolean;
  busy: boolean;
  select: (view: ConversationViewPreference) => Promise<void>;
  label: string;
}) {
  return (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={selected}
      data-conversation-view="group"
      disabled={busy}
      onClick={() => void select({ mode: 'group' })}
      className="shell-nav-row shell-focusable flex min-h-9 w-full items-center gap-2 rounded-lg px-2 text-left text-sm disabled:cursor-wait disabled:opacity-60"
      data-selected={selected ? 'true' : 'false'}
      style={{ background: selected ? 'var(--shell-selected)' : 'transparent', color: 'var(--shell-ink)' }}
    >
      <span className="flex h-5 w-5 items-center justify-center" style={{ color: 'var(--shell-muted)' }}>
        <ShellGlyph name="users" className="h-4 w-4" />
      </span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {selected ? <ShellGlyph name="check" className="h-3.5 w-3.5 flex-none" /> : null}
    </button>
  );
}

function CatViewItem({
  catId,
  name,
  available,
  running,
  selected,
  busy,
  select,
  words,
}: {
  catId: string;
  name: string;
  available: boolean;
  running: boolean;
  selected: boolean;
  busy: boolean;
  select: (view: ConversationViewPreference) => Promise<void>;
  words: ConversationViewWords;
}) {
  return (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={selected}
      data-conversation-cat={catId}
      disabled={busy || !available}
      onClick={() => void select({ mode: 'cat', catId })}
      data-selected={selected ? 'true' : 'false'}
      className="shell-nav-row shell-focusable flex min-h-11 w-full items-center gap-2 rounded-lg px-2 text-left disabled:cursor-not-allowed disabled:opacity-60"
      style={{ background: selected ? 'var(--shell-selected)' : 'transparent' }}
    >
      <ShellCatAvatar catId={catId} size={22} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm" style={{ color: 'var(--shell-body)' }}>
          {name}
        </span>
        <span className="block truncate text-micro" style={{ color: 'var(--shell-muted)' }}>
          {running ? `${words.working} · ` : ''}
          {available ? words.sentAndSaid : words.noRecordedActivity}
        </span>
      </span>
      {running ? <RunningDot /> : null}
      {selected ? <ShellGlyph name="check" className="h-3.5 w-3.5 flex-none" /> : null}
    </button>
  );
}

function RunningDot({ overlay = false }: { overlay?: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={
        overlay
          ? 'absolute bottom-0 right-0 h-1.5 w-1.5 rounded-full bg-conn-green-text ring-1 ring-[var(--shell-work)]'
          : 'h-1.5 w-1.5 flex-none rounded-full bg-conn-green-text'
      }
    />
  );
}

function ConversationViewStatus({
  controller,
  words,
}: {
  controller: ConversationViewPreferenceController;
  words: ConversationViewWords;
}) {
  if (!controller.loading && !controller.error) return null;
  const text = controller.loading ? words.loading : controller.error === 'save' ? words.saveFailed : words.loadFailed;
  return (
    <p
      className="px-2 pb-1 pt-1.5 text-micro"
      style={{ color: controller.error === 'save' ? 'var(--conn-red-text)' : 'var(--shell-muted)' }}
      role={controller.error ? 'status' : undefined}
    >
      {text}
    </p>
  );
}
