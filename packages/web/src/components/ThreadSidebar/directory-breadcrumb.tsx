/**
 * F113 DirectoryBreadcrumb: the breadcrumb row + new-folder button.
 * Extracted from DirectoryBrowser.tsx (R3 review P2#4: split root-navigation slice).
 */
import { HomeIcon, PcIcon } from './directory-browser-icons';
import type { BreadcrumbSegment } from './directory-segments';

interface DirectoryBreadcrumbProps {
  segments: BreadcrumbSegment[];
  showThisPcEntry: boolean;
  view: 'directory' | 'drives';
  onEnterDrivesView: () => void;
  onNavigateTo: (path: string | undefined) => void;
  onStartCreateDir: () => void;
}

export function DirectoryBreadcrumb({
  segments,
  showThisPcEntry,
  view,
  onEnterDrivesView,
  onNavigateTo,
  onStartCreateDir,
}: DirectoryBreadcrumbProps) {
  return (
    <div className="flex items-center gap-1 px-5 h-10 bg-cafe-white console-divider-b flex-shrink-0 overflow-x-auto">
      {showThisPcEntry && (
        <span className="flex items-center gap-1 flex-shrink-0">
          {view === 'drives' ? (
            <span className="text-xs font-semibold text-cafe-black flex items-center gap-1">
              <PcIcon />
              此电脑
            </span>
          ) : (
            <button
              type="button"
              onClick={onEnterDrivesView}
              className="text-xs font-medium text-cafe-accent hover:underline flex items-center gap-1"
            >
              <PcIcon />
              此电脑
            </button>
          )}
        </span>
      )}
      {view !== 'drives' &&
        segments.map((seg, i) => {
          // VS Code-style breadcrumb: drive root shows "D:" (no trailing
          // separator, no friendly label), subdirectories show their name.
          const isLast = i === segments.length - 1;
          const label = seg.label;
          const showSeparator = showThisPcEntry || i > 0;
          return (
            <span key={seg.path || `_${i}`} className="flex items-center gap-1 flex-shrink-0">
              {showSeparator && (
                <svg aria-hidden="true" className="w-3 h-3 text-cafe-muted" viewBox="0 0 20 20" fill="currentColor">
                  <path
                    fillRule="evenodd"
                    d="M7.21 14.77a.75.75 0 01.02-1.06L11.168 10 7.23 6.29a.75.75 0 111.04-1.08l4.5 4.25a.75.75 0 010 1.08l-4.5 4.25a.75.75 0 01-1.06-.02z"
                    clipRule="evenodd"
                  />
                </svg>
              )}
              {isLast ? (
                <span className="text-xs font-semibold text-cafe-black">{label}</span>
              ) : (
                <button
                  type="button"
                  onClick={() => onNavigateTo(seg.path || undefined)}
                  className="text-xs font-medium text-cafe-accent hover:underline"
                >
                  {i === 0 && seg.label === 'Home' ? (
                    <span className="flex items-center gap-1">
                      <HomeIcon />
                      {seg.label}
                    </span>
                  ) : (
                    label
                  )}
                </button>
              )}
            </span>
          );
        })}
      {/* [+] New folder button - hidden in drives view (no current dir, codex review P2) */}
      {view !== 'drives' && (
        <button
          type="button"
          onClick={onStartCreateDir}
          className="ml-auto flex-shrink-0 px-2 py-1 flex items-center gap-1 rounded-md border border-cafe-accent/30 bg-cafe-surface/50 text-cafe-accent hover:bg-cafe-surface hover:border-cafe-accent/50 transition-colors text-xs font-medium"
          title="新建文件夹"
        >
          <svg aria-hidden="true" className="w-3.5 h-3.5" viewBox="0 0 20 20" fill="currentColor">
            <path d="M10 5a1 1 0 011 1v3h3a1 1 0 110 2h-3v3a1 1 0 11-2 0v-3H6a1 1 0 110-2h3V6a1 1 0 011-1z" />
          </svg>
          新建
        </button>
      )}
    </div>
  );
}
