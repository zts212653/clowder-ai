'use client';

import { useEffect, useMemo, useState } from 'react';
import type { SearchResult } from '@/hooks/useWorkspace';
import { FileIcon } from './FileIcons';

const SEARCH_DEBOUNCE_MS = 250;
const MAX_VISIBLE_RESULTS = 8;

export interface LauncherWorkspaceSearch {
  enabled: boolean;
  results: SearchResult[];
  loading: boolean;
  error: string | null;
  onSearch: (query: string) => Promise<void> | void;
  onReset: () => void;
  onOpenResult: (path: string, line: number) => void;
  onViewAll: (query: string) => void;
}

function FileSearchResult({ result, onOpen }: { result: SearchResult; onOpen: (path: string, line: number) => void }) {
  const fileName = result.path.split('/').pop() ?? result.path;
  const directory = result.path.slice(0, result.path.length - fileName.length);

  return (
    <button
      type="button"
      onClick={() => onOpen(result.path, result.line)}
      data-testid="workspace-launcher-file-result"
      className="flex w-full items-start gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors hover:bg-cafe-surface"
    >
      <span className="mt-0.5 shrink-0">
        <FileIcon name={fileName} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-baseline gap-1">
          <span className="truncate text-xs font-semibold text-cafe-black">{fileName}</span>
          {result.line > 0 && <span className="shrink-0 font-mono text-micro text-cafe-muted">:{result.line}</span>}
        </span>
        {directory && <span className="block truncate text-micro text-cafe-muted">{directory}</span>}
        {result.content && (
          <span className="mt-0.5 block truncate font-mono text-micro text-cafe-secondary">{result.content}</span>
        )}
      </span>
      <span className="shrink-0 rounded-md bg-cafe-surface-sunken px-1.5 py-0.5 text-micro font-medium text-cafe-secondary">
        {result.matchType === 'filename' ? '文件名' : '内容'}
      </span>
    </button>
  );
}

export function WorkspaceLauncherSearch({
  query,
  onQueryChange,
  workspaceSearch,
}: {
  query: string;
  onQueryChange: (query: string) => void;
  workspaceSearch?: LauncherWorkspaceSearch;
}) {
  const trimmedQuery = query.trim();
  const [submittedQuery, setSubmittedQuery] = useState('');
  const searchEnabled = workspaceSearch?.enabled ?? false;
  const onReset = workspaceSearch?.onReset;
  const onSearch = workspaceSearch?.onSearch;

  useEffect(() => {
    onReset?.();
    setSubmittedQuery('');
    if (!trimmedQuery || !searchEnabled || !onSearch) return;

    const timeout = window.setTimeout(() => {
      setSubmittedQuery(trimmedQuery);
      void onSearch(trimmedQuery);
    }, SEARCH_DEBOUNCE_MS);

    return () => window.clearTimeout(timeout);
  }, [trimmedQuery, searchEnabled, onReset, onSearch]);

  const visibleResults = useMemo(
    () => workspaceSearch?.results.slice(0, MAX_VISIBLE_RESULTS) ?? [],
    [workspaceSearch?.results],
  );
  const searchSettled = submittedQuery === trimmedQuery && !workspaceSearch?.loading;
  const showWorkspaceResults = !!trimmedQuery && !!workspaceSearch?.enabled && submittedQuery === trimmedQuery;

  return (
    <>
      <label className="mb-5 flex items-center gap-2 rounded-xl border border-cafe-subtle bg-[var(--console-card-bg)] px-3.5 py-3 focus-within:border-cafe-accent/45">
        <svg
          aria-hidden="true"
          className="h-4 w-4 shrink-0 text-cafe-muted"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
        >
          <circle cx="7" cy="7" r="4.5" />
          <path d="m10.5 10.5 3 3" />
        </svg>
        <input
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          placeholder="搜索文件、任务、状态或陪伴…"
          className="min-w-0 flex-1 bg-transparent text-xs text-cafe-black outline-none placeholder:text-cafe-muted"
          data-testid="workspace-launcher-search"
        />
        {workspaceSearch?.loading && submittedQuery === trimmedQuery && (
          <output
            className="h-3.5 w-3.5 shrink-0 animate-spin rounded-full border-2 border-cafe-accent border-t-transparent"
            aria-label="正在搜索当前工作区"
          />
        )}
      </label>

      {!!trimmedQuery && workspaceSearch && !workspaceSearch.enabled && (
        <div className="mb-5 rounded-xl border border-dashed border-cafe-subtle px-3.5 py-3 text-xs text-cafe-secondary">
          当前没有可搜索的工作区；仍可在下面查找功能入口。
        </div>
      )}

      {showWorkspaceResults && (
        <section className="mb-6" aria-live="polite">
          <div className="mb-2 flex items-center justify-between gap-2">
            <h3 className="text-label font-semibold text-cafe-secondary">当前工作区</h3>
            {workspaceSearch.results.length > MAX_VISIBLE_RESULTS && (
              <button
                type="button"
                onClick={() => workspaceSearch.onViewAll(trimmedQuery)}
                className="text-micro font-semibold text-cafe-accent hover:text-cafe-accent-hover"
              >
                查看全部 {workspaceSearch.results.length} 条
              </button>
            )}
          </div>
          <div className="rounded-xl border border-cafe-subtle/75 bg-[var(--console-card-bg)] p-1.5">
            {workspaceSearch.error ? (
              <div className="px-2.5 py-3 text-xs text-conn-red-text">暂时没能搜索当前工作区，请重试。</div>
            ) : visibleResults.length > 0 ? (
              visibleResults.map((result, index) => (
                <FileSearchResult
                  key={`${result.matchType ?? 'content'}:${result.path}:${result.line}:${index}`}
                  result={result}
                  onOpen={workspaceSearch.onOpenResult}
                />
              ))
            ) : searchSettled ? (
              <div className="px-2.5 py-3 text-xs text-cafe-secondary">
                没有找到文件名或正文匹配；下面仍会保留匹配的功能入口。
              </div>
            ) : (
              <div className="px-2.5 py-3 text-xs text-cafe-secondary">正在搜索文件名和正文…</div>
            )}
          </div>
        </section>
      )}
    </>
  );
}
