import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useIMEGuard } from '@/hooks/useIMEGuard';

/** F070: governance status dot colors */
const GOV_STATUS_DOT: Record<string, { color: string; title: string }> = {
  healthy: { color: 'bg-conn-emerald-bg', title: '治理正常' },
  stale: { color: 'bg-conn-amber-bg', title: '治理过期' },
  missing: { color: 'bg-conn-red-bg', title: '治理缺失' },
  'never-synced': { color: 'bg-cafe-surface-sunken', title: '未同步治理' },
};

/** Section icon SVG paths (extracted to reduce JSX noise) */
const ICON_PATHS: Record<string, string> = {
  pin: 'M4.456 2.013a.75.75 0 011.06-.034l6.5 6a.75.75 0 01-.034 1.06l-1.99 1.838.637 3.22a.75.75 0 01-1.196.693L6.5 12.526l-2.933 2.264a.75.75 0 01-1.196-.693l.637-3.22-1.99-1.838a.75.75 0 01-.034-1.06l5.472-5.966z',
  star: 'M8 1.5l2.09 4.26 4.71.68-3.41 3.32.8 4.69L8 12.26l-4.19 2.19.8-4.69L1.2 6.44l4.71-.68L8 1.5z',
  clock:
    'M8 1a7 7 0 110 14A7 7 0 018 1zm0 1.5a5.5 5.5 0 100 11 5.5 5.5 0 000-11zM8 4a.75.75 0 01.75.75v2.69l1.78 1.78a.75.75 0 01-1.06 1.06l-2-2A.75.75 0 017.25 8V4.75A.75.75 0 018 4z',
  archive:
    'M1.75 2A1.75 1.75 0 000 3.75v1.5C0 5.99.84 6.73 1.91 6.95L2 7v5.25c0 .97.78 1.75 1.75 1.75h8.5A1.75 1.75 0 0014 12.25V7l.09-.05A1.75 1.75 0 0016 5.25v-1.5A1.75 1.75 0 0014.25 2H1.75zM1.5 3.75a.25.25 0 01.25-.25h12.5a.25.25 0 01.25.25v1.5a.25.25 0 01-.25.25H1.75a.25.25 0 01-.25-.25v-1.5zM3.5 7h9v5.25a.25.25 0 01-.25.25h-8.5a.25.25 0 01-.25-.25V7z',
  system:
    'M8 1a.75.75 0 01.75.75V3.1a5.01 5.01 0 012.72 1.57l1.17-.68a.75.75 0 01.75 1.3l-1.17.67A5.01 5.01 0 0113 8c0 .72-.15 1.4-.43 2.02l1.17.68a.75.75 0 01-.75 1.3l-1.17-.68A5.01 5.01 0 019 12.9v1.35a.75.75 0 01-1.5 0V12.9a5.01 5.01 0 01-2.72-1.57l-1.17.68a.75.75 0 01-.75-1.3l1.17-.68A5.01 5.01 0 013.5 8c0-.72.15-1.4.43-2.02l-1.17-.68a.75.75 0 01.75-1.3l1.17.68A5.01 5.01 0 017.25 3.1V1.75A.75.75 0 018 1zM5 8a3 3 0 106 0 3 3 0 00-6 0z',
};

const ICON_COLORS: Record<string, string> = {
  pin: 'text-cafe-accent',
  star: 'text-conn-amber-text',
  clock: 'text-cafe-muted',
  archive: 'text-cafe-muted',
  system: 'text-[var(--color-cafe-accent)]',
};

interface SectionGroupProps {
  label: string;
  icon?: 'pin' | 'star' | 'clock' | 'archive' | 'system';
  count: number;
  isCollapsed: boolean;
  onToggle: () => void;
  projectPath?: string;
  governanceStatus?: string;
  onToggleProjectPin?: () => void;
  isProjectPinned?: boolean;
  // F095 Phase F: project actions
  onQuickCreate?: () => void;
  onOpenInFinder?: () => void;
  onRenameProject?: (name: string) => void;
  onArchiveThreads?: () => void;
  children: React.ReactNode;
}

/** Collapsible section group for pinned / favorites / project threads. */
export function SectionGroup({
  label,
  icon,
  count,
  isCollapsed,
  onToggle,
  projectPath,
  governanceStatus,
  onToggleProjectPin,
  isProjectPinned,
  onQuickCreate,
  onOpenInFinder,
  onRenameProject,
  onArchiveThreads,
  children,
}: SectionGroupProps) {
  const [showMenu, setShowMenu] = useState(false);
  const [isRenaming, setIsRenaming] = useState(false);
  const [draftName, setDraftName] = useState(label);
  const menuRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const ime = useIMEGuard();

  const hasContextMenu = onOpenInFinder || onRenameProject || onArchiveThreads;

  // Close menu on click outside
  useEffect(() => {
    if (!showMenu) return;
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setShowMenu(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [showMenu]);

  // Focus input when entering rename mode
  useEffect(() => {
    if (isRenaming) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [isRenaming]);

  const submitRename = useCallback(() => {
    const name = draftName.trim();
    if (name && onRenameProject) {
      onRenameProject(name);
    }
    setIsRenaming(false);
  }, [draftName, onRenameProject]);

  const startRename = useCallback(() => {
    setDraftName(label);
    setIsRenaming(true);
    setShowMenu(false);
  }, [label]);

  const iconPath = icon ? ICON_PATHS[icon] : undefined;
  const iconColor = icon ? ICON_COLORS[icon] : undefined;
  const govDot = governanceStatus ? GOV_STATUS_DOT[governanceStatus] : undefined;

  return (
    <div className="mt-1 relative group/section">
      <div className="w-full flex items-center gap-1.5 px-3 py-1.5 hover:bg-cafe-surface-elevated transition-colors">
        {/* Toggle button — keyboard-focusable, Enter/Space to toggle */}
        {!isRenaming && (
          <button
            type="button"
            onClick={onToggle}
            aria-expanded={!isCollapsed}
            className="flex min-w-0 flex-1 items-center gap-1.5 text-left focus:outline-none"
            title={projectPath && projectPath !== 'default' ? projectPath : undefined}
          >
            <svg
              aria-hidden="true"
              className={`w-3 h-3 text-cafe-muted transition-transform flex-shrink-0 ${isCollapsed ? '' : 'rotate-90'}`}
              viewBox="0 0 12 12"
              fill="currentColor"
            >
              <path d="M4 2l4 4-4 4V2z" />
            </svg>

            {iconPath && (
              <svg
                aria-hidden="true"
                className={`w-3 h-3 flex-shrink-0 ${iconColor}`}
                viewBox="0 0 16 16"
                fill="currentColor"
              >
                <path d={iconPath} />
              </svg>
            )}

            <span className="text-xs font-medium text-cafe-secondary truncate">{label}</span>

            {govDot && <span className={`w-2 h-2 rounded-full flex-shrink-0 ${govDot.color}`} title={govDot.title} />}

            <span className="text-[10px] text-cafe-muted flex-shrink-0 ml-auto">{count}</span>
          </button>
        )}

        {/* Rename input — sibling of toggle button, never nested inside it */}
        {isRenaming && (
          <div className="flex min-w-0 flex-1 items-center gap-1.5">
            <svg
              aria-hidden="true"
              className={`w-3 h-3 text-cafe-muted transition-transform flex-shrink-0 ${isCollapsed ? '' : 'rotate-90'}`}
              viewBox="0 0 12 12"
              fill="currentColor"
            >
              <path d="M4 2l4 4-4 4V2z" />
            </svg>

            {iconPath && (
              <svg
                aria-hidden="true"
                className={`w-3 h-3 flex-shrink-0 ${iconColor}`}
                viewBox="0 0 16 16"
                fill="currentColor"
              >
                <path d={iconPath} />
              </svg>
            )}

            <input
              ref={inputRef}
              value={draftName}
              onChange={(e) => setDraftName(e.target.value)}
              onCompositionStart={ime.onCompositionStart}
              onCompositionEnd={ime.onCompositionEnd}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !ime.isComposing()) {
                  e.preventDefault();
                  submitRename();
                }
                if (e.key === 'Escape') {
                  e.preventDefault();
                  setIsRenaming(false);
                }
              }}
              onBlur={submitRename}
              maxLength={100}
              className="console-form-input text-xs font-medium px-1 py-0 flex-1 min-w-0"
            />
          </div>
        )}

        {/* Action buttons — siblings of the toggle, not children */}
        {onQuickCreate && (
          <ActionButton
            onClick={(e) => {
              e.stopPropagation();
              onQuickCreate();
            }}
            title="新建对话"
            testId="quick-create-btn"
            className="opacity-0 group-hover/section:opacity-100"
          >
            <path d="M8 2a.75.75 0 01.75.75v4.5h4.5a.75.75 0 010 1.5h-4.5v4.5a.75.75 0 01-1.5 0v-4.5h-4.5a.75.75 0 010-1.5h4.5v-4.5A.75.75 0 018 2z" />
          </ActionButton>
        )}

        {hasContextMenu && (
          <ActionButton
            onClick={(e) => {
              e.stopPropagation();
              setShowMenu((v) => !v);
            }}
            title="更多操作"
            testId="project-menu-btn"
            className="opacity-0 group-hover/section:opacity-100"
          >
            <path d="M8 4a1 1 0 110-2 1 1 0 010 2zm0 5a1 1 0 110-2 1 1 0 010 2zm0 5a1 1 0 110-2 1 1 0 010 2z" />
          </ActionButton>
        )}

        {onToggleProjectPin && (
          <ActionButton
            onClick={(e) => {
              e.stopPropagation();
              onToggleProjectPin();
            }}
            title={isProjectPinned ? '取消固定项目' : '固定项目到活跃区'}
            testId="project-pin-btn"
            className={isProjectPinned ? 'text-cafe-accent' : 'text-cafe-muted hover:text-cafe-muted'}
          >
            <path d={ICON_PATHS.pin} />
          </ActionButton>
        )}
      </div>

      {/* F095 Phase F: Context menu dropdown */}
      {showMenu && (
        <div
          ref={menuRef}
          className="absolute right-2 top-8 z-50 bg-cafe-surface rounded-lg shadow-lg border border-[var(--console-border-soft)] py-1 min-w-[140px]"
        >
          {onOpenInFinder && (
            <MenuItem
              onClick={() => {
                onOpenInFinder();
                setShowMenu(false);
              }}
            >
              在 Finder 中打开
            </MenuItem>
          )}
          {onRenameProject && <MenuItem onClick={startRename}>编辑名称</MenuItem>}
          {onArchiveThreads && (
            <MenuItem
              onClick={() => {
                onArchiveThreads();
                setShowMenu(false);
              }}
              danger
            >
              归档所有对话
            </MenuItem>
          )}
        </div>
      )}

      {!isCollapsed && children}
    </div>
  );
}

/** Small icon button used for pin / quick-create / menu actions. */
function ActionButton({
  onClick,
  title,
  testId,
  className,
  children,
}: {
  onClick: (e: React.MouseEvent) => void;
  title: string;
  testId: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <span
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(e) => {
        if ((e.key === 'Enter' || e.key === ' ') && !e.repeat) {
          e.preventDefault();
          e.stopPropagation();
          onClick(e as unknown as React.MouseEvent);
        }
      }}
      className={`ml-0.5 flex-shrink-0 cursor-pointer transition-all text-cafe-muted hover:text-cafe-secondary ${className ?? ''}`}
      title={title}
      data-testid={testId}
    >
      <svg aria-hidden="true" className="w-3 h-3" viewBox="0 0 16 16" fill="currentColor">
        {children}
      </svg>
    </span>
  );
}

/** Menu item for the project context menu dropdown. */
function MenuItem({ onClick, danger, children }: { onClick: () => void; danger?: boolean; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`w-full text-left px-3 py-1.5 text-xs transition-colors ${
        danger
          ? 'text-conn-red-text hover:bg-[var(--console-hover-bg)]'
          : 'text-cafe-secondary hover:bg-[var(--console-hover-bg)]'
      }`}
    >
      {children}
    </button>
  );
}
