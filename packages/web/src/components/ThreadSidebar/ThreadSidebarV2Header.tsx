'use client';

import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { useChatStore } from '@/stores/chatStore';
import { AppTooltip } from '../AppTooltip';
import { BootcampIcon } from '../icons/BootcampIcon';
import { MemoryBookStarIcon, ShellGlyph, type ShellGlyphName, WorksIcon } from '../shell/ShellIcons';
import { resolveShellNavTarget, type ShellDestination } from '../shell/shell-navigation';

interface ThreadSidebarV2HeaderProps {
  creationPhase: 'idle' | 'submitting' | 'reconciling';
  onNewThread: () => void;
  onCollapse?: () => void;
  searchQuery: string;
  onSearchQueryChange: (value: string) => void;
  bindWarning?: string | null;
  uncategorizedCount: number;
  onOrganizeWithCat: () => void;
  onOpenOrganizer: () => void;
  onOpenBootcamp: () => void;
  unreadCount: number;
  isMarkingAllRead: boolean;
  onMarkAllRead: () => void;
  /** The Café destination that is the current page, if any (today: 记忆). */
  activeDestination?: ShellDestination | null;
}

const CAFE_TITLE = '我的 Café';

function NavRow({
  icon,
  label,
  note,
  onClick,
  disabled = false,
  current = false,
  testId,
  guideId,
}: {
  icon: React.ReactNode;
  label: string;
  note?: string;
  onClick: () => void;
  disabled?: boolean;
  /** This row is the page the user is on: announced as the current page and drawn as selected. */
  current?: boolean;
  testId: string;
  guideId?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-current={current ? 'page' : undefined}
      data-selected={current ? 'true' : undefined}
      data-testid={testId}
      data-guide-id={guideId}
      className="shell-nav-row shell-focusable flex h-8 w-full items-center gap-2.5 rounded-lg px-2 text-left text-sm disabled:opacity-50"
      style={{
        background: current ? 'var(--shell-selected)' : undefined,
        color: current ? 'var(--shell-ink)' : 'var(--shell-body)',
        fontWeight: current ? 500 : undefined,
      }}
    >
      <span className="flex-none" style={{ color: 'var(--shell-muted)' }}>
        {icon}
      </span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {note ? (
        <span className="flex-none text-xs" style={{ color: 'var(--shell-muted)' }}>
          {note}
        </span>
      ) : null}
    </button>
  );
}

function IconButton({
  label,
  onClick,
  pressed,
  testId,
  children,
}: {
  label: string;
  onClick: () => void;
  pressed?: boolean;
  testId: string;
  children: React.ReactNode;
}) {
  return (
    <AppTooltip label={label} side="bottom">
      <button
        type="button"
        onClick={onClick}
        aria-label={label}
        aria-pressed={pressed}
        data-testid={testId}
        className="shell-rail-item shell-focusable flex h-[30px] w-[30px] flex-none items-center justify-center rounded-lg"
        style={{ color: 'var(--shell-muted)' }}
      >
        {children}
      </button>
    </AppTooltip>
  );
}

/**
 * Café 1.6 sidebar head: title + search + the few recovery actions that used to crowd the header, then the
 * three rows this world owns (新对话 / 全部作品 / 记忆). Every control the old header had is still reachable —
 * the organiser/bootcamp/mark-all-read actions moved into the "…" menu, not away.
 */
export function ThreadSidebarV2Header({
  creationPhase,
  onNewThread,
  onCollapse,
  searchQuery,
  onSearchQueryChange,
  bindWarning,
  uncategorizedCount,
  onOrganizeWithCat,
  onOpenOrganizer,
  onOpenBootcamp,
  unreadCount,
  isMarkingAllRead,
  onMarkAllRead,
  activeDestination = null,
}: ThreadSidebarV2HeaderProps) {
  const pathname = usePathname() ?? '/';
  const router = useRouter();
  const setWorkspaceMode = useChatStore((s) => s.setWorkspaceMode);
  const [searchOpen, setSearchOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const showSearch = searchOpen || searchQuery.length > 0;
  const isCreating = creationPhase !== 'idle';

  useEffect(() => {
    if (searchOpen) searchRef.current?.focus();
  }, [searchOpen]);

  useEffect(() => {
    if (!menuOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setMenuOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMenuOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [menuOpen]);

  const closeSearch = () => {
    onSearchQueryChange('');
    setSearchOpen(false);
  };

  const menuItems: Array<{
    id: string;
    label: string;
    icon: ShellGlyphName | 'bootcamp';
    onSelect: () => void;
    testId?: string;
    guideId?: string;
  }> = [];
  if (uncategorizedCount > 0) {
    menuItems.push(
      {
        id: 'organize-cat',
        label: `猫猫帮你分类（${uncategorizedCount} 未分类）`,
        icon: 'sparkles',
        onSelect: onOrganizeWithCat,
      },
      {
        id: 'organize-manual',
        label: `手动批量分类（${uncategorizedCount} 未分类）`,
        icon: 'grid',
        onSelect: onOpenOrganizer,
      },
    );
  }
  menuItems.push({
    id: 'bootcamp',
    label: '猫猫训练营',
    icon: 'bootcamp',
    onSelect: onOpenBootcamp,
    testId: 'sidebar-bootcamp',
    guideId: 'sidebar.bootcamp',
  });
  if (unreadCount > 0) {
    menuItems.push({
      id: 'mark-all-read',
      label: isMarkingAllRead ? '正在标为已读…' : `全部标为已读（${unreadCount}）`,
      icon: 'checkSquare',
      onSelect: onMarkAllRead,
      testId: 'mark-all-read-btn',
    });
  }

  return (
    <div data-testid="sidebar-v2-header">
      <div className="flex h-[52px] flex-none items-center gap-0.5 pl-[18px] pr-2.5">
        <h2 className="m-0 min-w-0 flex-1 truncate text-sm font-semibold" style={{ color: 'var(--shell-ink)' }}>
          {CAFE_TITLE}
        </h2>
        <IconButton
          label="搜索对话"
          pressed={showSearch}
          testId="sidebar-search-toggle"
          onClick={() => (showSearch ? closeSearch() : setSearchOpen(true))}
        >
          <ShellGlyph name="search" />
        </IconButton>
        <div ref={menuRef} className="relative">
          <IconButton
            label="更多"
            pressed={menuOpen}
            testId="sidebar-more-menu"
            onClick={() => setMenuOpen((wasOpen) => !wasOpen)}
          >
            <ShellGlyph name="more" />
          </IconButton>
          {menuOpen && (
            <div
              role="menu"
              aria-label="对话栏更多操作"
              className="absolute right-0 top-[34px] z-[60] w-[240px] rounded-xl p-1.5"
              style={{
                background: 'var(--shell-paper)',
                border: '1px solid var(--shell-hairline-strong)',
                boxShadow: '0 4px 10px rgb(20 20 19 / 0.1)',
              }}
            >
              {menuItems.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  role="menuitem"
                  data-testid={item.testId}
                  data-guide-id={item.guideId}
                  disabled={item.id === 'mark-all-read' && isMarkingAllRead}
                  onClick={() => {
                    setMenuOpen(false);
                    item.onSelect();
                  }}
                  className="shell-nav-row shell-focusable flex h-8 w-full items-center gap-2 rounded-lg px-2 text-left text-sm"
                  style={{ color: 'var(--shell-body)' }}
                >
                  <span className="flex-none" style={{ color: 'var(--shell-muted)' }}>
                    {item.icon === 'bootcamp' ? <BootcampIcon className="h-4 w-4" /> : <ShellGlyph name={item.icon} />}
                  </span>
                  <span className="min-w-0 flex-1 truncate">{item.label}</span>
                </button>
              ))}
            </div>
          )}
        </div>
        {onCollapse ? (
          <IconButton label="收起侧栏" testId="sidebar-collapse" onClick={onCollapse}>
            <ShellGlyph name="panelLeft" />
          </IconButton>
        ) : null}
      </div>

      {bindWarning && (
        <div
          className="mx-2.5 mb-2 rounded-lg px-2.5 py-1.5 text-xs"
          style={{
            background: 'var(--shell-paper)',
            color: 'var(--shell-body)',
            border: '1px solid var(--shell-hairline)',
          }}
        >
          {bindWarning}
        </div>
      )}

      {showSearch && (
        <div className="px-3 pb-2">
          <input
            ref={searchRef}
            value={searchQuery}
            onChange={(event) => onSearchQueryChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') closeSearch();
            }}
            placeholder="搜索对话、项目或 ID…"
            aria-label="搜索对话"
            data-testid="sidebar-search-input"
            className="shell-focusable h-8 w-full rounded-lg px-2.5 text-sm"
            style={{
              background: 'var(--shell-paper)',
              border: '1px solid var(--shell-hairline-strong)',
              color: 'var(--shell-ink)',
            }}
          />
        </div>
      )}

      <nav aria-label="Café" className="flex flex-col px-2.5 pb-2.5 pt-0.5">
        <NavRow
          icon={<ShellGlyph name="newchat" />}
          label="新对话"
          note={creationPhase === 'reconciling' ? '请求超时，核对中…' : isCreating ? '…' : undefined}
          onClick={onNewThread}
          disabled={isCreating}
          testId="sidebar-new-thread"
          guideId="sidebar.new-thread"
        />
        <NavRow
          icon={<WorksIcon />}
          label="全部作品"
          onClick={() => setWorkspaceMode('artifacts')}
          testId="sidebar-all-works"
        />
        <NavRow
          icon={<MemoryBookStarIcon />}
          label="记忆"
          onClick={() => router.push(resolveShellNavTarget('/memory', pathname))}
          current={activeDestination === 'memory'}
          testId="sidebar-memory"
        />
      </nav>
    </div>
  );
}
