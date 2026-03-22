import React from 'react';

/** F070: governance status dot colors */
const GOV_STATUS_DOT: Record<string, { color: string; title: string }> = {
  healthy: { color: 'bg-green-400', title: '治理正常' },
  stale: { color: 'bg-yellow-400', title: '治理过期' },
  missing: { color: 'bg-red-400', title: '治理缺失' },
  'never-synced': { color: 'bg-gray-300', title: '未同步治理' },
};

interface SectionGroupProps {
  label: string;
  icon?: 'pin' | 'star' | 'clock' | 'archive';
  count: number;
  isCollapsed: boolean;
  onToggle: () => void;
  projectPath?: string;
  governanceStatus?: string;
  onToggleProjectPin?: () => void;
  isProjectPinned?: boolean;
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
  children,
}: SectionGroupProps) {
  return (
    <div className="mt-1">
      <button
        type="button"
        onClick={onToggle}
        className="w-full text-left px-3 py-1.5 flex items-center gap-1.5 hover:bg-gray-50 transition-colors"
        title={projectPath && projectPath !== 'default' ? projectPath : undefined}
      >
        <svg
          aria-hidden="true"
          className={`w-3 h-3 text-gray-400 transition-transform flex-shrink-0 ${isCollapsed ? '' : 'rotate-90'}`}
          viewBox="0 0 12 12"
          fill="currentColor"
        >
          <path d="M4 2l4 4-4 4V2z" />
        </svg>
        {icon === 'pin' && (
          <svg
            aria-hidden="true"
            className="w-3 h-3 text-cocreator-primary flex-shrink-0"
            viewBox="0 0 16 16"
            fill="currentColor"
          >
            <path d="M4.456 2.013a.75.75 0 011.06-.034l6.5 6a.75.75 0 01-.034 1.06l-1.99 1.838.637 3.22a.75.75 0 01-1.196.693L6.5 12.526l-2.933 2.264a.75.75 0 01-1.196-.693l.637-3.22-1.99-1.838a.75.75 0 01-.034-1.06l5.472-5.966z" />
          </svg>
        )}
        {icon === 'star' && (
          <svg
            aria-hidden="true"
            className="w-3 h-3 text-yellow-500 flex-shrink-0"
            viewBox="0 0 16 16"
            fill="currentColor"
          >
            <path d="M8 1.5l2.09 4.26 4.71.68-3.41 3.32.8 4.69L8 12.26l-4.19 2.19.8-4.69L1.2 6.44l4.71-.68L8 1.5z" />
          </svg>
        )}
        {icon === 'clock' && (
          <svg
            aria-hidden="true"
            className="w-3 h-3 text-gray-400 flex-shrink-0"
            viewBox="0 0 16 16"
            fill="currentColor"
          >
            <path d="M8 1a7 7 0 110 14A7 7 0 018 1zm0 1.5a5.5 5.5 0 100 11 5.5 5.5 0 000-11zM8 4a.75.75 0 01.75.75v2.69l1.78 1.78a.75.75 0 01-1.06 1.06l-2-2A.75.75 0 017.25 8V4.75A.75.75 0 018 4z" />
          </svg>
        )}
        {icon === 'archive' && (
          <svg
            aria-hidden="true"
            className="w-3 h-3 text-gray-400 flex-shrink-0"
            viewBox="0 0 16 16"
            fill="currentColor"
          >
            <path d="M1.75 2A1.75 1.75 0 000 3.75v1.5C0 5.99.84 6.73 1.91 6.95L2 7v5.25c0 .97.78 1.75 1.75 1.75h8.5A1.75 1.75 0 0014 12.25V7l.09-.05A1.75 1.75 0 0016 5.25v-1.5A1.75 1.75 0 0014.25 2H1.75zM1.5 3.75a.25.25 0 01.25-.25h12.5a.25.25 0 01.25.25v1.5a.25.25 0 01-.25.25H1.75a.25.25 0 01-.25-.25v-1.5zM3.5 7h9v5.25a.25.25 0 01-.25.25h-8.5a.25.25 0 01-.25-.25V7z" />
          </svg>
        )}
        <span className="text-xs font-medium text-gray-500 truncate">{label}</span>
        {(() => {
          const dot = governanceStatus ? GOV_STATUS_DOT[governanceStatus] : undefined;
          return dot ? <span className={`w-2 h-2 rounded-full flex-shrink-0 ${dot.color}`} title={dot.title} /> : null;
        })()}
        <span className="text-[10px] text-gray-300 flex-shrink-0 ml-auto">{count}</span>
        {onToggleProjectPin && (
          <span
            role="button"
            tabIndex={0}
            onClick={(e) => {
              e.stopPropagation();
              onToggleProjectPin();
            }}
            onKeyDown={(e) => {
              if ((e.key === 'Enter' || e.key === ' ') && !e.repeat) {
                e.preventDefault();
                e.stopPropagation();
                onToggleProjectPin();
              }
            }}
            className={`ml-1 flex-shrink-0 cursor-pointer transition-colors ${isProjectPinned ? 'text-cocreator-primary' : 'text-gray-300 hover:text-gray-400'}`}
            title={isProjectPinned ? '取消固定项目' : '固定项目到活跃区'}
            data-testid="project-pin-btn"
          >
            <svg aria-hidden="true" className="w-3 h-3" viewBox="0 0 16 16" fill="currentColor">
              <path d="M4.456 2.013a.75.75 0 011.06-.034l6.5 6a.75.75 0 01-.034 1.06l-1.99 1.838.637 3.22a.75.75 0 01-1.196.693L6.5 12.526l-2.933 2.264a.75.75 0 01-1.196-.693l.637-3.22-1.99-1.838a.75.75 0 01-.034-1.06l5.472-5.966z" />
            </svg>
          </span>
        )}
      </button>
      {!isCollapsed && children}
    </div>
  );
}
