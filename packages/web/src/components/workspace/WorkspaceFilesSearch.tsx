'use client';

import { useMemo, useState } from 'react';
import { useIMEGuard } from '@/hooks/useIMEGuard';
import { type SearchResult, useWorkspaceSearch } from '@/hooks/useWorkspaceSearch';
import { FileIcon } from './FileIcons';

type SearchMode = 'all' | 'filename' | 'content';
type OpenSearchResult = (path: string, line: number) => void;

function nextMode(mode: SearchMode): SearchMode {
  if (mode === 'all') return 'filename';
  return mode === 'filename' ? 'content' : 'all';
}

function searchPlaceholder(mode: SearchMode): string {
  if (mode === 'content') return '搜索代码内容…';
  return mode === 'filename' ? '搜索文件名或路径…' : '搜索当前工作区…';
}

function SearchIcon() {
  return (
    <svg
      className="h-3.5 w-3.5 flex-shrink-0 text-cafe-interactive/40"
      viewBox="0 0 16 16"
      fill="currentColor"
      aria-hidden="true"
    >
      <path
        fillRule="evenodd"
        d="M9.965 11.026a5 5 0 1 1 1.06-1.06l2.755 2.754a.75.75 0 1 1-1.06 1.06l-2.755-2.754ZM10.5 7a3.5 3.5 0 1 1-7 0 3.5 3.5 0 0 1 7 0Z"
        clipRule="evenodd"
      />
    </svg>
  );
}

function SearchResultItem({
  result,
  query,
  onOpen,
}: {
  result: SearchResult;
  query: string;
  onOpen: OpenSearchResult;
}) {
  const fileName = result.path.split('/').pop() ?? result.path;
  const directory = result.path.slice(0, result.path.length - fileName.length);
  const highlighted = useMemo(() => {
    if (!query || !result.content) return result.content;
    const index = result.content.toLowerCase().indexOf(query.toLowerCase());
    if (index < 0) return result.content;
    return (
      <>
        {result.content.slice(0, index)}
        <mark className="rounded bg-cafe-surface-sunken px-0.5 text-cafe-interactive">
          {result.content.slice(index, index + query.length)}
        </mark>
        {result.content.slice(index + query.length)}
      </>
    );
  }, [query, result.content]);

  return (
    <button
      type="button"
      className="group w-full px-3 py-1.5 text-left transition-colors hover:bg-cafe-surface/60"
      data-search-result-path={result.path}
      data-search-result-line={result.line}
      onClick={() => onOpen(result.path, result.line)}
    >
      <div className="flex items-center gap-1.5">
        <FileIcon name={fileName} />
        <span className="truncate text-xs font-medium text-cafe-black">{fileName}</span>
        {result.line > 0 && <span className="font-mono text-micro text-cafe-interactive/50">:{result.line}</span>}
      </div>
      {directory && <div className="ml-5 truncate text-micro text-cafe-muted">{directory}</div>}
      {result.content && (
        <div className="ml-5 mt-0.5 truncate font-mono text-micro text-cafe-secondary">{highlighted}</div>
      )}
    </button>
  );
}

function SearchGroup({
  label,
  results,
  query,
  onOpen,
}: {
  label: string;
  results: SearchResult[];
  query: string;
  onOpen: OpenSearchResult;
}) {
  if (results.length === 0) return null;
  return (
    <>
      <div className="sticky top-0 bg-cafe-white/95 px-3 py-1.5 text-micro font-semibold uppercase tracking-wider text-cafe-interactive/50 backdrop-blur-sm">
        {label} ({results.length})
      </div>
      {results.map((result, index) => (
        <SearchResultItem
          key={`${result.path}:${result.line}:${index}`}
          result={result}
          query={query}
          onOpen={onOpen}
        />
      ))}
    </>
  );
}

function SearchResultsPanel({
  results,
  query,
  branch,
  onOpen,
}: {
  results: SearchResult[];
  query: string;
  branch?: string;
  onOpen: OpenSearchResult;
}) {
  if (results.length === 0) {
    return (
      <div className="px-3 py-3 text-xs text-cafe-interactive/70">
        <div className="font-medium text-cafe-black">
          未在 {branch ?? '当前工作区'} 中找到“{query.trim()}”
        </div>
        <div className="mt-1 text-micro text-cafe-interactive/55">可切换 All / File / Aa 搜索范围后重试。</div>
      </div>
    );
  }
  const filenameResults = results.filter((result) => result.matchType === 'filename');
  const contentResults = results.filter((result) => result.matchType === 'content');
  if (filenameResults.length > 0 || contentResults.length > 0) {
    return (
      <>
        <SearchGroup label="文件名匹配" results={filenameResults} query={query} onOpen={onOpen} />
        <SearchGroup label="内容匹配" results={contentResults} query={query} onOpen={onOpen} />
      </>
    );
  }
  return results.map((result, index) => (
    <SearchResultItem key={`${result.path}:${result.line}:${index}`} result={result} query={query} onOpen={onOpen} />
  ));
}

export function WorkspaceFilesSearch({
  worktreeId,
  branch,
  onOpen,
}: {
  worktreeId: string;
  branch?: string;
  onOpen: OpenSearchResult;
}) {
  const [query, setQuery] = useState('');
  const [mode, setMode] = useState<SearchMode>('all');
  const [didSearch, setDidSearch] = useState(false);
  const { results, loading, error, search, reset } = useWorkspaceSearch(worktreeId);
  const ime = useIMEGuard();
  const showResults = (didSearch || results.length > 0) && !loading && !error;

  return (
    <div className="flex-shrink-0">
      <form
        data-testid="f307-files-search-form"
        className="border-b border-cafe-subtle/40 px-3 py-2"
        onSubmit={(event) => {
          event.preventDefault();
          const trimmed = query.trim();
          if (!trimmed) {
            setDidSearch(false);
            reset();
            return;
          }
          setDidSearch(true);
          void search(trimmed, mode);
        }}
      >
        <div className="flex items-center gap-1.5 rounded-lg border border-cafe-subtle bg-cafe-surface/80 px-2.5 py-1.5 transition-all focus-within:border-cafe-accent focus-within:ring-1 focus-within:ring-cafe-accent/20">
          <SearchIcon />
          <input
            data-testid="f307-files-search-input"
            type="search"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setDidSearch(false);
              if (!event.target.value.trim()) reset();
            }}
            onCompositionStart={ime.onCompositionStart}
            onCompositionEnd={ime.onCompositionEnd}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && ime.isComposing()) event.preventDefault();
            }}
            placeholder={searchPlaceholder(mode)}
            aria-label={branch ? `搜索 ${branch} 分支文件` : '搜索当前工作区文件'}
            className="min-w-0 flex-1 bg-transparent text-xs text-cafe-black outline-none placeholder:text-cafe-interactive/30"
          />
          <button
            type="button"
            className="rounded-md px-1.5 py-0.5 text-micro font-medium text-cafe-interactive/60 transition-colors hover:bg-cafe-surface-sunken"
            title="切换搜索范围"
            onClick={() => setMode(nextMode)}
          >
            {mode === 'all' ? 'All' : mode === 'filename' ? 'File' : 'Aa'}
          </button>
        </div>
      </form>
      {loading && (
        <div className="flex items-center gap-2 border-b border-cafe-subtle/40 px-3 py-3 text-xs text-cafe-interactive/70">
          <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-cafe-accent border-t-transparent" />
          搜索中…
        </div>
      )}
      {error && !loading && (
        <div className="border-b border-conn-red-ring bg-conn-red-bg/80 px-3 py-3 text-xs text-conn-red-text">
          暂时没能搜索当前工作区，请重试。
        </div>
      )}
      {showResults && (
        <div className="max-h-64 overflow-y-auto border-b border-cafe-subtle/40">
          <SearchResultsPanel results={results} query={query} branch={branch} onOpen={onOpen} />
        </div>
      )}
    </div>
  );
}
