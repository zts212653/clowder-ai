/**
 * F113 Phase D: Cross-platform directory browser.
 * Replaces macOS-only osascript folder picker with a web-based solution.
 * Calls GET /api/projects/browse to list directories.
 */
import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '@/utils/api-client';

interface BrowseEntry {
  name: string;
  path: string;
  isDirectory: boolean;
}

interface BrowseResult {
  current: string;
  name: string;
  parent: string | null;
  homePath: string;
  entries: BrowseEntry[];
}

interface DirectoryBrowserProps {
  /** Initially browsed path — defaults to home via API */
  initialPath?: string;
  /** Path of the currently active project (highlighted in listing) */
  activeProjectPath?: string;
  /** Called when user confirms a directory selection */
  onSelect: (path: string) => void;
  /** Called when user cancels */
  onCancel: () => void;
}

/**
 * Parse an absolute path into breadcrumb segments.
 * When path is under homePath: Home > relative segments (each clickable).
 * When path is outside homePath (e.g. /tmp, /Volumes): show the full path
 * segments from the allowed root, using the parent field for "go up".
 * Handles both / and \ separators for cross-platform support.
 */
function pathToSegments(absPath: string, homePath: string): { label: string; path: string }[] {
  const sep = absPath.includes('\\') ? '\\' : '/';

  // Case 1: path is at or under home — use "Home" as root label
  if (absPath === homePath || absPath.startsWith(homePath + sep)) {
    const segments: { label: string; path: string }[] = [{ label: 'Home', path: '' }];
    if (absPath === homePath) return segments;

    const relative = absPath.slice(homePath.length + 1);
    if (!relative) return segments;

    const parts = relative.split(/[/\\]/).filter(Boolean);
    let accumulated = homePath;
    for (const part of parts) {
      accumulated += sep + part;
      segments.push({ label: part, path: accumulated });
    }
    return segments;
  }

  // Case 2: path is outside home — all segments are clickable.
  // We can't know the full allowlist on the frontend. If the user clicks
  // a non-allowed ancestor, the backend returns 403 and the error is shown
  // gracefully. This is better than hiding valid ancestors like /tmp which
  // IS in the default allowlist (project-path.ts:22-35).
  const parts = absPath.split(/[/\\]/).filter(Boolean);
  const segments: { label: string; path: string }[] = [];

  let accumulated = absPath.startsWith('/') ? '' : parts[0];
  const startIdx = absPath.startsWith('/') ? 0 : 1;
  for (let i = startIdx; i < parts.length; i++) {
    accumulated += sep + parts[i];
    segments.push({ label: parts[i], path: accumulated });
  }

  return segments;
}

export function DirectoryBrowser({ initialPath, activeProjectPath, onSelect, onCancel }: DirectoryBrowserProps) {
  const [browseResult, setBrowseResult] = useState<BrowseResult | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [pathInput, setPathInput] = useState('');

  const fetchDirectory = useCallback(async (path?: string, fallbackOnForbidden = false) => {
    setIsLoading(true);
    setError(null);
    try {
      const url = path ? `/api/projects/browse?path=${encodeURIComponent(path)}` : '/api/projects/browse';
      const res = await apiFetch(url);
      if (!res.ok) {
        // On initial load only: if initialPath is forbidden (403), visibly fall
        // back to homedir so the user gets a browsable directory. Non-403 errors
        // (400 readdir failure, 500) always surface — no silent swallowing.
        if (fallbackOnForbidden && path && res.status === 403) {
          setInfo('配置路径不可用，已切换到主目录');
          // await so outer finally doesn't clear isLoading before fallback finishes
          await fetchDirectory(undefined, false);
          return;
        }
        const data = await res.json();
        setError(data.error || 'Failed to browse directory');
        // Keep previous browseResult — don't destroy current listing on error.
        return;
      }
      const data: BrowseResult = await res.json();
      setBrowseResult(data);
      setPathInput(data.current);
    } catch {
      setError('Unable to connect to server');
    } finally {
      setIsLoading(false);
    }
  }, []);

  // Initial load — try initialPath, fallback to homedir on 403 (with visible info)
  useEffect(() => {
    fetchDirectory(initialPath, !!initialPath);
  }, [fetchDirectory, initialPath]);

  const handlePathSubmit = useCallback(() => {
    const trimmed = pathInput.trim();
    if (trimmed) fetchDirectory(trimmed);
  }, [pathInput, fetchDirectory]);

  const segments = browseResult ? pathToSegments(browseResult.current, browseResult.homePath) : [];

  return (
    <div className="flex flex-col h-full">
      {/* ── Breadcrumb ── */}
      <div className="flex items-center gap-1 px-5 h-10 bg-cafe-white border-b border-[#f0e6de] flex-shrink-0 overflow-x-auto">
        {segments.map((seg, i) => (
          <span key={seg.path || `_${i}`} className="flex items-center gap-1 flex-shrink-0">
            {i > 0 && (
              <svg aria-hidden="true" className="w-3 h-3 text-[#d4c0b3]" viewBox="0 0 20 20" fill="currentColor">
                <path
                  fillRule="evenodd"
                  d="M7.21 14.77a.75.75 0 01.02-1.06L11.168 10 7.23 6.29a.75.75 0 111.04-1.08l4.5 4.25a.75.75 0 010 1.08l-4.5 4.25a.75.75 0 01-1.06-.02z"
                  clipRule="evenodd"
                />
              </svg>
            )}
            {i === segments.length - 1 ? (
              <span className="text-xs font-semibold text-cafe-black">{seg.label}</span>
            ) : (
              <button
                type="button"
                onClick={() => fetchDirectory(seg.path || undefined)}
                className="text-xs font-medium text-owner-primary hover:underline"
              >
                {i === 0 && seg.label === 'Home' ? (
                  <span className="flex items-center gap-1">
                    <HomeIcon />
                    {seg.label}
                  </span>
                ) : (
                  seg.label
                )}
              </button>
            )}
          </span>
        ))}
      </div>

      {/* ── Directory listing ── */}
      <div className="flex-1 overflow-y-auto px-3 py-2 space-y-0.5 min-h-[180px]">
        {isLoading && (
          <div className="flex items-center justify-center py-8">
            <span className="text-xs text-gray-400 animate-pulse">Loading...</span>
          </div>
        )}

        {info && (
          <div className="px-3 py-1.5 mb-1">
            <p className="text-[10px] text-owner-primary">{info}</p>
          </div>
        )}

        {error && (
          <div className="px-3 py-1.5 mb-1">
            <p className="text-xs text-red-500">{error}</p>
          </div>
        )}

        {!isLoading && browseResult && browseResult.entries.length === 0 && (
          <div className="flex items-center justify-center py-8">
            <span className="text-xs text-gray-400">No subdirectories</span>
          </div>
        )}

        {!isLoading &&
          browseResult?.entries.map((entry) => {
            const isActive = activeProjectPath === entry.path;
            return (
              <button
                key={entry.path}
                type="button"
                onClick={() => fetchDirectory(entry.path)}
                className={`w-full text-left px-3 py-2.5 text-sm rounded-lg transition-colors flex items-center gap-2.5 ${
                  isActive ? 'bg-owner-bg' : 'hover:bg-owner-bg/50'
                }`}
                title={entry.path}
              >
                <FolderIcon className={isActive ? 'text-owner-primary' : 'text-[#c4a882]'} />
                <span className="font-medium text-cafe-black truncate flex-1">{entry.name}</span>
                {isActive && <span className="text-[10px] text-owner-primary flex-shrink-0">当前项目</span>}
                <svg
                  aria-hidden="true"
                  className="w-3.5 h-3.5 text-[#d4c0b3] flex-shrink-0"
                  viewBox="0 0 20 20"
                  fill="currentColor"
                >
                  <path
                    fillRule="evenodd"
                    d="M7.21 14.77a.75.75 0 01.02-1.06L11.168 10 7.23 6.29a.75.75 0 111.04-1.08l4.5 4.25a.75.75 0 010 1.08l-4.5 4.25a.75.75 0 01-1.06-.02z"
                    clipRule="evenodd"
                  />
                </svg>
              </button>
            );
          })}
      </div>

      {/* ── Path input ── */}
      <div className="px-5 py-3 border-t border-[#f0e6de] space-y-2 flex-shrink-0">
        <div className="flex gap-2">
          <TerminalIcon />
          <input
            type="text"
            value={pathInput}
            onChange={(e) => setPathInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.nativeEvent.isComposing) handlePathSubmit();
            }}
            placeholder="Enter path..."
            className="flex-1 text-xs px-3 py-2 rounded-lg border border-[#e8d9cf] bg-cafe-white focus:outline-none focus:ring-1 focus:ring-owner-primary"
          />
          {pathInput.trim() && (
            <button
              type="button"
              onClick={handlePathSubmit}
              className="px-2.5 py-2 rounded-lg border border-[#e8d9cf] bg-cafe-white text-gray-600 hover:bg-owner-bg transition-colors"
              aria-label="Go to path"
            >
              <svg aria-hidden="true" className="w-3.5 h-3.5" viewBox="0 0 20 20" fill="currentColor">
                <path
                  fillRule="evenodd"
                  d="M10.293 3.293a1 1 0 011.414 0l6 6a1 1 0 010 1.414l-6 6a1 1 0 01-1.414-1.414L14.586 11H3a1 1 0 110-2h11.586l-4.293-4.293a1 1 0 010-1.414z"
                  clipRule="evenodd"
                />
              </svg>
            </button>
          )}
        </div>

        {/* ── Action bar ── */}
        <div className="flex items-center gap-2 pt-1">
          {browseResult && (
            <span className="text-[11px] text-gray-500 truncate flex-1" title={browseResult.current}>
              {browseResult.current}
            </span>
          )}
          <button
            type="button"
            onClick={onCancel}
            className="px-4 py-2 rounded-lg border border-[#e8d9cf] text-gray-600 text-xs font-medium transition-colors hover:bg-gray-50"
          >
            取消
          </button>
          <button
            type="button"
            onClick={() => browseResult && onSelect(browseResult.current)}
            disabled={!browseResult}
            className="px-5 py-2 rounded-lg bg-owner-primary hover:bg-owner-dark text-white text-sm font-medium transition-colors disabled:opacity-40"
          >
            选择此目录
          </button>
        </div>
      </div>
    </div>
  );
}

function HomeIcon() {
  return (
    <svg aria-hidden="true" className="w-3.5 h-3.5" viewBox="0 0 20 20" fill="currentColor">
      <path d="M10.707 2.293a1 1 0 00-1.414 0l-7 7a1 1 0 001.414 1.414L4 10.414V17a1 1 0 001 1h2a1 1 0 001-1v-2a1 1 0 011-1h2a1 1 0 011 1v2a1 1 0 001 1h2a1 1 0 001-1v-6.586l.293.293a1 1 0 001.414-1.414l-7-7z" />
    </svg>
  );
}

function FolderIcon({ className }: { className?: string }) {
  return (
    <svg
      aria-hidden="true"
      className={`w-4 h-4 flex-shrink-0 ${className ?? ''}`}
      viewBox="0 0 16 16"
      fill="currentColor"
    >
      <path d="M1 3.5A1.5 1.5 0 012.5 2h3.879a1.5 1.5 0 011.06.44l1.122 1.12A1.5 1.5 0 009.62 4H13.5A1.5 1.5 0 0115 5.5v7a1.5 1.5 0 01-1.5 1.5h-11A1.5 1.5 0 011 12.5v-9z" />
    </svg>
  );
}

function TerminalIcon() {
  return (
    <svg aria-hidden="true" className="w-3.5 h-3.5 text-gray-400 mt-2.5" viewBox="0 0 20 20" fill="currentColor">
      <path
        fillRule="evenodd"
        d="M2 4.25A2.25 2.25 0 014.25 2h11.5A2.25 2.25 0 0118 4.25v11.5A2.25 2.25 0 0115.75 18H4.25A2.25 2.25 0 012 15.75V4.25zM7.664 6.23a.75.75 0 00-1.078 1.04l2.705 2.805-2.705 2.805a.75.75 0 001.078 1.04l3.25-3.37a.75.75 0 000-1.04l-3.25-3.28zM11 13a.75.75 0 000 1.5h3a.75.75 0 000-1.5h-3z"
        clipRule="evenodd"
      />
    </svg>
  );
}
