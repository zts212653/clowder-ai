import { memo, type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { useCatData } from '@/hooks/useCatData';
import { useIMEGuard } from '@/hooks/useIMEGuard';
import { resolveCatDisplayName } from '@/lib/cat-display-name';
import { catColorVar } from '@/lib/cat-slug';
import { useLabelStore } from '@/stores/label-store';
import type { SidebarPresence, SidebarSystemKind } from '@/stores/sidebarProjectionStore';
// F174 D2b-2 (rev): per-cat callback-auth dot was rejected (co-creator alpha 反馈
// "莫名其妙的颜色" — 16px participant avatars lacked any affordance). Status now
// surfaces system-level via <CallbackAuthHealthIndicator /> in ChatContainerHeader,
// and per-cat (with "AFFECTED CATS" affordance) inside HubCallbackAuthPanel.
import { CatAvatar } from '../CatAvatar';
import { ExportButton } from '../ExportButton';
import { HubIcon } from '../icons/HubIcon';
import { PawIcon } from '../icons/PawIcon';
import { ThreadCatStatus } from '../ThreadCatStatus';
import { useSidebarDraftDecoration } from './sidebar-draft-decoration';
import { ThreadSettingsPanel } from './ThreadSettingsPanel';
import { formatRelativeTime, formatSidebarStatusTime } from './thread-utils';

export interface ThreadItemProps {
  id: string;
  title: string | null;
  participants: readonly string[];
  lastActiveAt: number;
  isActive: boolean;
  onSelect: (id: string) => void;
  onDelete?: (id: string) => void;
  onRename?: (id: string, title: string) => void | Promise<void>;
  onTogglePin?: (id: string, pinned: boolean) => void | Promise<void>;
  onToggleFavorite?: (id: string, favorited: boolean) => void | Promise<void>;
  onUpdatePreferredCats?: (id: string, cats: string[]) => void | Promise<void>;
  onUpdateLabels?: (id: string, labels: string[]) => void | Promise<void>;
  /** F252 Phase E: open Meow Theater replay for this thread */
  onReplay?: (id: string) => void;
  isPinned?: boolean;
  isFavorited?: boolean;
  presence: SidebarPresence;
  unreadCount: number;
  hasUserMention: boolean;
  projectPath?: string;
  indented?: boolean;
  preferredCats?: readonly string[];
  threadLabels?: readonly string[];
  isHubThread?: boolean;
  systemKind?: SidebarSystemKind | null;
}

function ThreadItemComponent({
  id,
  title,
  participants,
  lastActiveAt,
  isActive,
  onSelect,
  onDelete,
  onRename,
  onTogglePin,
  onToggleFavorite,
  onUpdatePreferredCats,
  onUpdateLabels,
  isPinned,
  isFavorited,
  presence,
  unreadCount,
  hasUserMention,
  projectPath,
  indented,
  preferredCats,
  threadLabels,
  isHubThread,
  systemKind,
  onReplay,
}: ThreadItemProps) {
  const hasDraftDecoration = useSidebarDraftDecoration(id);
  const { getCatById } = useCatData();
  const canDelete = id !== 'default' && onDelete;
  const canRename = id !== 'default' && onRename;
  const canPin = id !== 'default' && onTogglePin;
  const canFavorite = id !== 'default' && onToggleFavorite;
  const [isEditing, setIsEditing] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isMoreOpen, setIsMoreOpen] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [draftTitle, setDraftTitle] = useState(title ?? '');
  const inputRef = useRef<HTMLInputElement>(null);
  const moreButtonRef = useRef<HTMLButtonElement>(null);
  const moreMenuRef = useRef<HTMLDivElement>(null);
  const ime = useIMEGuard();
  const [, refreshWorkingClock] = useState(0);

  useEffect(() => {
    if (presence.status !== 'working' || presence.activeSince === undefined) return;
    const timer = window.setInterval(() => refreshWorkingClock((tick) => tick + 1), 60_000);
    return () => window.clearInterval(timer);
  }, [presence.status, presence.activeSince]);

  useEffect(() => {
    if (!isEditing) setDraftTitle(title ?? '');
  }, [title, isEditing]);

  useEffect(() => {
    if (!isEditing) return;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [isEditing]);

  useEffect(() => {
    if (isEditing) setIsMoreOpen(false);
  }, [isEditing]);

  useEffect(() => {
    if (!isMoreOpen) return;
    const handleMouseDown = (e: MouseEvent) => {
      const target = e.target as Node | null;
      if (!target) return;
      if (moreButtonRef.current?.contains(target) || moreMenuRef.current?.contains(target)) return;
      setIsMoreOpen(false);
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setIsMoreOpen(false);
    };
    document.addEventListener('mousedown', handleMouseDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handleMouseDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [isMoreOpen]);

  const submitRename = useCallback(async () => {
    if (!onRename) return;
    const next = draftTitle.trim();
    if (!next) {
      setDraftTitle(title ?? '');
      setIsEditing(false);
      return;
    }
    if (next === (title ?? '')) {
      setIsEditing(false);
      return;
    }

    setIsSaving(true);
    try {
      await onRename(id, next);
      setIsEditing(false);
    } finally {
      setIsSaving(false);
    }
  }, [onRename, draftTitle, title, id]);

  // Build hover tooltip: full title + participants + time (clowder-ai#29)
  const displayTitle = title ?? (id === 'default' ? '大厅' : '未命名对话');
  const hasDraft = !isActive && hasDraftDecoration;
  const participantNames = participants.map((catId) => resolveCatDisplayName(catId, getCatById)).join(', ');
  const tooltipLines = [displayTitle];
  if (participantNames) tooltipLines.push(`参与: ${participantNames}`);
  if (projectPath && projectPath !== 'default') tooltipLines.push(`路径: ${projectPath}`);
  tooltipLines.push(formatRelativeTime(lastActiveAt, false));
  const tooltip = tooltipLines.join('\n');
  const hasMoreActions = id !== 'default' && !isEditing;
  const compactStatusTime = formatSidebarStatusTime(presence, lastActiveAt);

  const startRename = useCallback(() => {
    setIsMoreOpen(false);
    setIsSettingsOpen(false);
    setIsEditing(true);
  }, []);

  const startThreadSettings = useCallback(() => {
    setIsMoreOpen(false);
    setIsSettingsOpen(true);
  }, []);

  const startReplay = useCallback(() => {
    setIsMoreOpen(false);
    onReplay?.(id);
  }, [id, onReplay]);

  const toggleFavorite = useCallback(() => {
    if (!onToggleFavorite) return;
    setIsMoreOpen(false);
    void onToggleFavorite(id, !isFavorited);
  }, [id, isFavorited, onToggleFavorite]);

  const deleteThread = useCallback(() => {
    if (!onDelete) return;
    setIsMoreOpen(false);
    onDelete(id);
  }, [id, onDelete]);

  return (
    <div
      data-thread-id={id}
      aria-current={isActive ? 'page' : undefined}
      className={`group relative mx-2 rounded-xl ${indented ? 'pl-5 pr-3' : 'px-3'} py-2.5 transition-colors cursor-pointer ${
        isActive ? 'bg-[var(--console-active-bg)]' : 'hover:bg-[var(--console-hover-bg)]'
      }`}
      onClick={(event) => {
        if (
          event.target instanceof Element &&
          event.target.closest('[data-thread-settings-panel="true"], [role="menu"]')
        ) {
          return;
        }
        onSelect(id);
      }}
    >
      {/* Title row */}
      <div className="mb-1.5 flex items-start justify-between gap-1">
        {isEditing ? (
          <input
            ref={inputRef}
            value={draftTitle}
            onChange={(e) => setDraftTitle(e.target.value)}
            onClick={(e) => e.stopPropagation()}
            onCompositionStart={ime.onCompositionStart}
            onCompositionEnd={ime.onCompositionEnd}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !ime.isComposing()) {
                e.preventDefault();
                void submitRename();
              }
              if (e.key === 'Escape') {
                e.preventDefault();
                setDraftTitle(title ?? '');
                setIsEditing(false);
              }
            }}
            onBlur={() => {
              void submitRename();
            }}
            disabled={isSaving}
            maxLength={200}
            className="text-sm px-1.5 py-0.5 rounded border border-cafe-subtle focus:outline-none focus:border-cafe-accent w-full mr-2 disabled:opacity-70"
          />
        ) : (
          <span className="flex min-w-0 flex-1 items-center gap-1">
            {canPin && (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  void onTogglePin(id, !isPinned);
                }}
                className={`inline-flex flex-shrink-0 p-0.5 rounded transition-all hover:bg-[var(--console-hover-bg)] hover:text-cafe-interactive ${
                  isPinned
                    ? 'text-cafe-accent'
                    : 'opacity-0 group-hover:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100 text-cafe-muted hover:text-cafe-accent'
                }`}
                aria-label={isPinned ? `取消置顶 ${displayTitle}` : `置顶 ${displayTitle}`}
                title={isPinned ? '取消置顶' : '置顶'}
                data-testid="thread-pin-button"
              >
                <PinIcon />
              </button>
            )}
            {isPinned && !canPin && (
              <span className="inline-flex flex-shrink-0 text-cafe-accent" role="img" aria-label="已置顶">
                <PinIcon />
              </span>
            )}
            {isFavorited && (
              <span
                className="inline-flex flex-shrink-0 text-conn-amber-text"
                role="img"
                aria-label="已收藏"
                data-testid="thread-favorite-mark"
              >
                <StarIcon filled />
              </span>
            )}
            {isHubThread && <HubIcon className="w-3.5 h-3.5 inline-block mr-1 text-cafe-accent align-text-bottom" />}
            {systemKind === 'cat_bedroom' && (
              <span
                className="inline-flex shrink-0 items-center rounded-full border border-cafe-subtle bg-cafe-surface-elevated px-1.5 py-0.5 text-micro leading-none text-cafe-accent"
                title="猫的私人卧室"
                data-testid="thread-system-kind"
              >
                猫卧室
              </span>
            )}
            <span
              title={tooltip}
              className={`min-w-0 flex-1 line-clamp-2 text-sm leading-normal ${isActive ? 'font-medium text-cafe-black' : 'text-cafe-secondary'}`}
            >
              {title ?? (id === 'default' ? '大厅' : '未命名对话')}
            </span>
          </span>
        )}
        <div className="flex items-center gap-0.5 flex-shrink-0 mt-0.5">
          {hasMoreActions && (
            <div className="relative">
              <button
                type="button"
                ref={moreButtonRef}
                onClick={(e) => {
                  e.stopPropagation();
                  setIsSettingsOpen(false);
                  setIsMoreOpen((open) => !open);
                }}
                className={`p-0.5 rounded transition-all ${
                  isMoreOpen
                    ? 'text-cafe-secondary bg-cafe-surface-elevated'
                    : 'text-cafe-muted hover:text-cafe-secondary'
                }`}
                title="更多操作"
                aria-haspopup="menu"
                aria-expanded={isMoreOpen}
              >
                <MoreVerticalIcon />
              </button>
              {isMoreOpen && (
                <div
                  ref={moreMenuRef}
                  role="menu"
                  aria-label="对话操作"
                  className="absolute right-0 top-5 z-50 min-w-[144px] rounded-lg border border-cafe bg-cafe-surface py-1 shadow-lg"
                >
                  <ThreadActionMenuItem icon={<SettingsIcon />} onClick={startThreadSettings}>
                    对话设置
                  </ThreadActionMenuItem>
                  {canRename && (
                    <ThreadActionMenuItem icon={<RenameIcon />} onClick={startRename}>
                      重命名对话
                    </ThreadActionMenuItem>
                  )}
                  <ExportButton threadId={id} variant="thread-menu" onSelect={() => setIsMoreOpen(false)} />
                  {onReplay && (
                    <ThreadActionMenuItem icon={<ReplayIcon />} onClick={startReplay}>
                      回放剧场
                    </ThreadActionMenuItem>
                  )}
                  {canFavorite && (
                    <ThreadActionMenuItem icon={<StarIcon filled={isFavorited} />} onClick={toggleFavorite}>
                      {isFavorited ? '取消收藏' : '收藏'}
                    </ThreadActionMenuItem>
                  )}
                  {canDelete && (
                    <>
                      <div className="my-1 h-px bg-cafe-subtle" />
                      <ThreadActionMenuItem icon={<DeleteIcon />} onClick={deleteThread} danger>
                        删除对话
                      </ThreadActionMenuItem>
                    </>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
      {/* Bottom row: avatars + status + compact time */}
      <div className="flex min-w-0 items-center justify-between">
        <div className="flex min-w-0 items-center gap-1">
          {/* ring-2 paints 2px beyond each avatar box; keep that paint inside the horizontal clip boundary. */}
          <div
            data-testid="thread-participant-metadata"
            className="flex min-w-0 items-center gap-1 overflow-x-clip overflow-y-visible px-0.5"
          >
            {participants.length > 0 ? (
              participants.map((catId) => <CatAvatar key={catId} catId={catId} size={16} />)
            ) : id !== 'default' ? (
              <>
                <PawIcon className="text-xs" />
                <span className="text-micro text-cafe-muted">还没有猫猫加入</span>
              </>
            ) : null}
            {preferredCats && preferredCats.length > 0 && (
              <div
                className="ml-1 flex items-center gap-0.5"
                title={`默认: ${preferredCats.map((id) => resolveCatDisplayName(id, getCatById)).join(', ')}`}
              >
                <svg
                  aria-hidden="true"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  className="h-2.5 w-2.5 shrink-0 text-cafe-muted"
                >
                  <path d="M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM12 18a6 6 0 1 0 0-12 6 6 0 0 0 0 12zM12 14a2 2 0 1 0 0-4 2 2 0 0 0 0 4z" />
                </svg>
                {preferredCats.map((catId) => (
                  <span
                    key={catId}
                    className="inline-block h-1.5 w-1.5 rounded-full"
                    style={{ backgroundColor: catColorVar(catId, 'primary') }}
                  />
                ))}
              </div>
            )}
            <LabelDots labels={threadLabels ? [...threadLabels] : undefined} />
          </div>
          <ThreadCatStatus presence={presence} unreadCount={unreadCount} hasUserMention={hasUserMention} />
        </div>
        <div className="flex items-center gap-1.5 flex-shrink-0">
          {hasDraft && <span className="text-micro font-medium text-conn-red-text">[草稿]</span>}
          <span className="text-micro text-cafe-muted">{compactStatusTime}</span>
        </div>
      </div>
      <ThreadSettingsPanel
        open={isSettingsOpen}
        threadId={id}
        threadTitle={displayTitle}
        currentCats={[...(preferredCats ?? [])]}
        currentLabels={[...(threadLabels ?? [])]}
        onSavePreferredCats={onUpdatePreferredCats}
        onSaveLabels={onUpdateLabels}
        onClose={() => setIsSettingsOpen(false)}
        returnFocusRef={moreButtonRef}
      />
    </div>
  );
}

export const ThreadItem = memo(ThreadItemComponent);

// ─── Small icon components ───

function PinIcon() {
  // demo sidebar-proposals.html line 205 — pushpin (stroke style, 24x24)
  return (
    <svg
      className="w-3 h-3"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 17v5" />
      <path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z" />
    </svg>
  );
}

function DeleteIcon() {
  return (
    <svg className="w-3 h-3" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path
        fillRule="evenodd"
        d="M5 3.25V4H2.75a.75.75 0 000 1.5h.3l.815 8.15A1.5 1.5 0 005.357 15h5.285a1.5 1.5 0 001.493-1.35l.815-8.15h.3a.75.75 0 000-1.5H11v-.75A2.25 2.25 0 008.75 1h-1.5A2.25 2.25 0 005 3.25zm2.25-.75a.75.75 0 00-.75.75V4h3v-.75a.75.75 0 00-.75-.75h-1.5z"
        clipRule="evenodd"
      />
    </svg>
  );
}

function MoreVerticalIcon() {
  return (
    <svg className="w-3 h-3" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M8 4a1 1 0 110-2 1 1 0 010 2zm0 5a1 1 0 110-2 1 1 0 010 2zm0 5a1 1 0 110-2 1 1 0 010 2z" />
    </svg>
  );
}

function SettingsIcon() {
  return (
    <svg
      className="w-3 h-3"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="8" cy="8" r="2.25" />
      <path d="M6.8 1.8h2.4l.45 1.5c.35.14.68.33.98.56l1.52-.37 1.2 2.08-1.06 1.12c.03.2.05.42.05.63s-.02.42-.05.63l1.06 1.12-1.2 2.08-1.52-.37c-.3.23-.63.42-.98.56l-.45 1.5H6.8l-.45-1.5a4.7 4.7 0 0 1-.98-.56l-1.52.37-1.2-2.08 1.06-1.12a4.5 4.5 0 0 1 0-1.26L2.65 5.57l1.2-2.08 1.52.37c.3-.23.63-.42.98-.56l.45-1.5Z" />
    </svg>
  );
}

function RenameIcon() {
  return (
    <svg className="w-3 h-3" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M11.013 1.427a1.75 1.75 0 112.474 2.474l-7.2 7.2a2 2 0 01-.84.49l-2.22.634a.75.75 0 01-.926-.926l.634-2.22a2 2 0 01.49-.84l7.588-7.588zm1.414 1.06a.25.25 0 00-.353 0L11.2 3.36l1.44 1.44.874-.874a.25.25 0 000-.353l-1.086-1.086zM11.58 5.86l-1.44-1.44-6.072 6.072a.5.5 0 00-.123.21l-.303 1.06 1.06-.303a.5.5 0 00.21-.123l6.668-6.668z" />
      <path d="M2.25 13A.75.75 0 013 12.25v-.5a.75.75 0 011.5 0v.5c0 .138.112.25.25.25h8a.75.75 0 010 1.5h-8A1.75 1.75 0 012.25 13z" />
    </svg>
  );
}

/** F252 Phase E: play/replay icon for Meow Theater */
function ReplayIcon() {
  return (
    <svg className="w-3 h-3" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M4 2.5a.5.5 0 01.8-.4l8 6a.5.5 0 010 .8l-8 6a.5.5 0 01-.8-.4v-12z" />
    </svg>
  );
}

function LabelIcon() {
  return (
    <svg className="w-3 h-3" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path
        fillRule="evenodd"
        d="M2.5 1A1.5 1.5 0 001 2.5v4.586a1.5 1.5 0 00.44 1.06l6.414 6.414a1.5 1.5 0 002.122 0l4.586-4.586a1.5 1.5 0 000-2.122L8.148 1.44A1.5 1.5 0 007.086 1H2.5zM5 4a1 1 0 11-2 0 1 1 0 012 0z"
        clipRule="evenodd"
      />
    </svg>
  );
}

function StarIcon({ filled }: { filled?: boolean }) {
  return (
    <svg
      className="w-3 h-3"
      viewBox="0 0 16 16"
      fill={filled ? 'currentColor' : 'none'}
      stroke="currentColor"
      strokeWidth="1.2"
      aria-hidden="true"
    >
      <path d="M8 1.5l2.09 4.26 4.71.68-3.41 3.32.8 4.69L8 12.26l-4.19 2.19.8-4.69L1.2 6.44l4.71-.68L8 1.5z" />
    </svg>
  );
}

function ThreadActionMenuItem({
  icon,
  onClick,
  danger,
  children,
}: {
  icon: ReactNode;
  onClick: () => void;
  danger?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs transition-colors ${
        danger ? 'text-conn-red-text hover:bg-conn-red-bg' : 'text-cafe-secondary hover:bg-cafe-surface-elevated'
      }`}
    >
      <span className="inline-flex h-3 w-3 flex-shrink-0 items-center justify-center text-cafe-muted">{icon}</span>
      <span>{children}</span>
    </button>
  );
}

function LabelDots({ labels }: { labels?: string[] }) {
  const { labels: allLabels } = useLabelStore();
  if (!labels || labels.length === 0) return null;
  const resolved = labels
    .map((id) => allLabels.find((l) => l.id === id))
    .filter((l): l is NonNullable<typeof l> => l !== undefined);
  if (resolved.length === 0) return null;
  const shown = resolved.slice(0, 3);
  const overflow = resolved.length - shown.length;
  return (
    <div
      className="ml-1 inline-flex h-4 items-center gap-1 rounded-full bg-[var(--console-card-soft-bg)] px-1.5 text-cafe-muted"
      title={resolved.map((l) => l.name).join(', ')}
      data-testid="thread-label-dots"
    >
      <LabelIcon />
      {shown.map((l) => (
        <span
          key={l.id}
          className="inline-block h-1.5 w-1.5 flex-shrink-0 rounded-full"
          style={{ backgroundColor: l.color }}
        />
      ))}
      {overflow > 0 && <span className="text-micro text-cafe-muted">+{overflow}</span>}
    </div>
  );
}
