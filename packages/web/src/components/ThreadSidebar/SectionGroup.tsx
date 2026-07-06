import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useIMEGuard } from '@/hooks/useIMEGuard';

/** F070: governance status dot colors */
const GOV_STATUS_DOT: Record<string, { color: string; title: string }> = {
  healthy: { color: 'bg-conn-emerald-text', title: '治理正常' },
  stale: { color: 'bg-conn-amber-text', title: '治理过期' },
  missing: { color: 'bg-conn-red-text', title: '治理缺失' },
  'never-synced': { color: 'bg-conn-slate-ring', title: '未同步治理' },
};

/** Section icon SVG paths (extracted to reduce JSX noise). pin uses stroke style — see PinSectionIcon. */
const ICON_PATHS: Record<string, string> = {
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
  system: 'text-conn-blue-text',
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

  const hasContextMenu = onOpenInFinder || onRenameProject || onArchiveThreads || onToggleProjectPin;

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

  const stopButton = useCallback((e: React.MouseEvent) => e.stopPropagation(), []);

  const iconPath = icon ? ICON_PATHS[icon] : undefined;
  const iconColor = icon ? ICON_COLORS[icon] : undefined;
  const govDot = governanceStatus ? GOV_STATUS_DOT[governanceStatus] : undefined;

  return (
    <div className="relative mt-1 px-2 group/section">
      <div className="flex w-full items-center gap-1 rounded-lg px-1.5 py-1.5 transition-colors hover:bg-cafe-surface-elevated">
        {isRenaming ? (
          <div className="flex min-w-0 flex-1 items-center gap-1.5">
            <SectionChevron isCollapsed={isCollapsed} />
            {iconPath && <SectionIcon iconPath={iconPath} iconColor={iconColor} />}
            <input
              ref={inputRef}
              value={draftName}
              onChange={(e) => setDraftName(e.target.value)}
              onClick={stopButton}
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
              className="min-w-0 flex-1 rounded border border-cafe-subtle px-1 py-0 text-xs font-medium focus:border-cafe-accent focus:outline-none"
            />
          </div>
        ) : (
          <button
            type="button"
            onClick={onToggle}
            className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
            title={projectPath && projectPath !== 'default' ? projectPath : undefined}
          >
            <SectionChevron isCollapsed={isCollapsed} />
            {iconPath && <SectionIcon iconPath={iconPath} iconColor={iconColor} />}
            {isProjectPinned && <PinSectionIcon />}
            <span className="min-w-0 flex-1 truncate text-xs font-medium text-cafe-secondary">{label}</span>
          </button>
        )}

        {/* Governance dot */}
        {govDot && <span className={`w-2 h-2 rounded-full flex-shrink-0 ${govDot.color}`} title={govDot.title} />}

        {/* Count */}
        <span className="text-micro text-cafe-muted flex-shrink-0 ml-auto">{count}</span>

        {/* F095 Phase F: Quick create button */}
        {onQuickCreate && (
          <ActionButton
            onClick={(e) => {
              e.stopPropagation();
              onQuickCreate();
            }}
            title="新建对话"
            testId="quick-create-btn"
          >
            <path d="M8 2a.75.75 0 01.75.75v4.5h4.5a.75.75 0 010 1.5h-4.5v4.5a.75.75 0 01-1.5 0v-4.5h-4.5a.75.75 0 010-1.5h4.5v-4.5A.75.75 0 018 2z" />
          </ActionButton>
        )}

        {/* Context menu trigger */}
        {hasContextMenu && (
          <ActionButton
            onClick={(e) => {
              e.stopPropagation();
              setShowMenu((v) => !v);
            }}
            title="更多操作"
            testId="project-menu-btn"
          >
            <path d="M8 4a1 1 0 110-2 1 1 0 010 2zm0 5a1 1 0 110-2 1 1 0 010 2zm0 5a1 1 0 110-2 1 1 0 010 2z" />
          </ActionButton>
        )}
      </div>

      {/* F095 Phase F: Context menu dropdown */}
      {showMenu && (
        <div
          ref={menuRef}
          className="absolute right-2 top-8 z-50 bg-cafe-surface rounded-lg shadow-lg border border-cafe py-1 min-w-[160px]"
        >
          {onToggleProjectPin && (
            <MenuItem
              onClick={() => {
                onToggleProjectPin();
                setShowMenu(false);
              }}
              icon={<PinMenuIcon active={isProjectPinned} />}
            >
              {isProjectPinned ? '取消固定项目' : '固定项目到活跃区'}
            </MenuItem>
          )}
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

function SectionChevron({ isCollapsed }: { isCollapsed: boolean }) {
  return (
    <svg
      aria-hidden="true"
      className={`h-3 w-3 flex-shrink-0 text-cafe-muted transition-transform ${isCollapsed ? '' : 'rotate-90'}`}
      viewBox="0 0 12 12"
      fill="currentColor"
    >
      <path d="M4 2l4 4-4 4V2z" />
    </svg>
  );
}

function SectionIcon({ iconPath, iconColor }: { iconPath: string; iconColor?: string }) {
  return (
    <svg aria-hidden="true" className={`h-3 w-3 flex-shrink-0 ${iconColor}`} viewBox="0 0 16 16" fill="currentColor">
      <path d={iconPath} />
    </svg>
  );
}

/** Pinned-section icon — demo pushpin (sidebar-proposals.html line 205), stroke style, 24x24. */
function PinSectionIcon() {
  return (
    <svg
      aria-hidden="true"
      className="h-3 w-3 flex-shrink-0 text-cafe-accent"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M12 17v5" />
      <path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z" />
    </svg>
  );
}

/** Menu-item pushpin — accent when pinned, muted otherwise. */
function PinMenuIcon({ active }: { active?: boolean }) {
  return (
    <svg
      aria-hidden="true"
      className={`h-3 w-3 flex-shrink-0 ${active ? 'text-cafe-accent' : 'text-cafe-muted'}`}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M12 17v5" />
      <path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z" />
    </svg>
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
    <button
      type="button"
      onClick={onClick}
      onKeyDown={(e) => {
        if ((e.key === 'Enter' || e.key === ' ') && !e.repeat) {
          e.preventDefault();
          e.stopPropagation();
          onClick(e as unknown as React.MouseEvent);
        }
      }}
      className={`ml-0.5 flex-shrink-0 transition-all text-cafe-muted hover:text-cafe-secondary ${className ?? ''}`}
      title={title}
      data-testid={testId}
    >
      <svg aria-hidden="true" className="w-3 h-3" viewBox="0 0 16 16" fill="currentColor">
        {children}
      </svg>
    </button>
  );
}

/** Menu item for the project context menu dropdown. */
function MenuItem({
  onClick,
  danger,
  icon,
  children,
}: {
  onClick: () => void;
  danger?: boolean;
  icon?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex w-full items-center gap-1.5 px-3 py-1.5 text-left text-xs transition-colors ${
        danger ? 'text-conn-red-text hover:bg-conn-red-bg' : 'text-cafe-secondary hover:bg-cafe-surface-elevated'
      }`}
    >
      {icon && <span className="flex flex-shrink-0 items-center">{icon}</span>}
      {children}
    </button>
  );
}
