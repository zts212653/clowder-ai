'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch } from '@/utils/api-client';
import { ExpandableText } from '../ExpandableText';

export interface EvidenceSearchParams {
  q: string;
  mode?: 'lexical' | 'semantic' | 'hybrid';
  scope?: 'docs' | 'memory' | 'threads' | 'sessions' | 'all';
  depth?: 'summary' | 'raw';
  dimension?: 'project' | 'global' | 'all';
  limit?: number;
}

/** AC-K2: passage shape matches backend evidence-helpers.ts EvidenceResult.passages */
interface PassageItem {
  passageId: string;
  content: string;
  speaker?: string;
  createdAt?: string;
  context?: Array<{
    passageId: string;
    content: string;
    speaker?: string;
    createdAt?: string;
  }>;
}

interface SearchResultItem {
  title: string;
  anchor: string;
  snippet: string;
  confidence: string;
  sourceType: string;
  source?: 'project' | 'global';
  passages?: PassageItem[];
}

interface SearchResponse {
  results: SearchResultItem[];
  degraded: boolean;
  degradeReason?: string;
  /** AC-K1: actual mode used when depth=raw forces lexical */
  effectiveMode?: 'lexical' | 'semantic' | 'hybrid';
}

export const DEPTH_OPTIONS = [
  { value: 'summary', label: '摘要' },
  { value: 'raw', label: '原文' },
] as const;

export const SOURCE_TYPE_COLORS: Record<string, string> = {
  decision: 'bg-conn-amber-bg text-conn-amber-text',
  phase: 'bg-[var(--color-cafe-accent)]/10 text-[var(--color-cafe-accent)]',
  feature: 'bg-[var(--console-pill-bg)] text-cafe',
  lesson: 'bg-conn-emerald-bg text-conn-emerald-text',
  research: 'bg-conn-sky-bg text-conn-sky-text',
  knowledge: 'bg-[var(--console-pill-bg)] text-cafe-secondary',
  discussion: 'bg-[var(--console-card-soft-bg)] text-cafe',
  commit: 'bg-[var(--console-card-soft-bg)] text-cafe-secondary',
};

export const SOURCE_TYPE_LABELS: Record<string, string> = {
  decision: '决策',
  phase: '阶段',
  feature: '功能',
  lesson: '教训',
  research: '调研',
  knowledge: '知识',
  discussion: '讨论',
  commit: '提交',
};

/**
 * Pure: extract q param from URL search string for drill-down.
 */
export function parseInitialQuery(search: string): string {
  if (!search) return '';
  return new URLSearchParams(search).get('q') ?? '';
}

/**
 * Pure: build search URL from params.
 */
export function buildSearchUrl(params: EvidenceSearchParams): string {
  const sp = new URLSearchParams();
  sp.set('q', params.q);
  // AC-K1: depth=raw forces lexical — passage-level vectors not yet available
  const effectiveMode = params.depth === 'raw' ? 'lexical' : params.mode;
  if (effectiveMode) sp.set('mode', effectiveMode);
  if (params.scope) sp.set('scope', params.scope);
  if (params.depth) sp.set('depth', params.depth);
  if (params.dimension) sp.set('dimension', params.dimension);
  if (params.limit) sp.set('limit', String(params.limit));
  return `/api/evidence/search?${sp.toString()}`;
}

/**
 * Pure: parse API response into display items.
 */
export function parseSearchResults(response: SearchResponse): SearchResultItem[] {
  // AC-K1: only discard results for actual errors, not graceful degradation (raw_lexical_only)
  if (response.degraded && response.degradeReason === 'evidence_store_error') return [];
  return response.results;
}

interface EvidenceSearchProps {
  readonly initialQuery?: string;
}

export function EvidenceSearch({ initialQuery }: EvidenceSearchProps = {}) {
  const [query, setQuery] = useState(initialQuery ?? '');
  const [mode, setMode] = useState<EvidenceSearchParams['mode']>('hybrid');
  const [scope, setScope] = useState<EvidenceSearchParams['scope']>(undefined);
  const [depth, setDepth] = useState<EvidenceSearchParams['depth']>(undefined);
  const [dimension, setDimension] = useState<EvidenceSearchParams['dimension']>(undefined);
  const [results, setResults] = useState<SearchResultItem[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const autoSearchedRef = useRef<string | undefined>(undefined);
  const searchIdRef = useRef(0);

  const doSearch = useCallback(
    async (searchQuery: string) => {
      if (!searchQuery.trim()) return;
      const id = ++searchIdRef.current;
      setIsSearching(true);
      setError(null);
      try {
        const url = buildSearchUrl({ q: searchQuery.trim(), mode, scope, depth, dimension, limit: 10 });
        const res = await apiFetch(url);
        if (id !== searchIdRef.current) return;
        const data = (await res.json()) as SearchResponse;
        if (id !== searchIdRef.current) return;
        setResults(parseSearchResults(data));
      } catch {
        if (id !== searchIdRef.current) return;
        setError('Search failed');
        setResults([]);
      } finally {
        if (id === searchIdRef.current) {
          setIsSearching(false);
        }
      }
    },
    [mode, scope, depth, dimension],
  );

  const handleSearch = useCallback(() => doSearch(query), [doSearch, query]);

  // Auto-search when initialQuery changes (drill-down from RecallFeed).
  // Uses ref to avoid re-triggering for the same value when component persists
  // across Next.js App Router searchParams changes.
  useEffect(() => {
    if (initialQuery && initialQuery !== autoSearchedRef.current) {
      autoSearchedRef.current = initialQuery;
      setQuery(initialQuery);
      doSearch(initialQuery);
    }
  }, [initialQuery, doSearch]);

  return (
    <div data-testid="evidence-search" className="space-y-4">
      {/* Search + filters — unified bar matching Signal Inbox layout */}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          handleSearch();
        }}
        className="flex flex-wrap items-center gap-2"
      >
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="搜索项目知识..."
          className="console-form-input max-w-[400px]"
          data-testid="evidence-search-input"
        />
        <select
          value={depth === 'raw' ? 'lexical' : mode}
          onChange={(e) => setMode(e.target.value as EvidenceSearchParams['mode'])}
          disabled={depth === 'raw'}
          className="console-form-input"
        >
          <option value="hybrid">模式: 混合</option>
          <option value="lexical">模式: 精确</option>
          <option value="semantic">模式: 语义</option>
        </select>
        <select
          value={scope ?? 'all'}
          onChange={(e) =>
            setScope(e.target.value === 'all' ? undefined : (e.target.value as EvidenceSearchParams['scope']))
          }
          className="console-form-input"
        >
          <option value="all">范围: 全部</option>
          <option value="docs">范围: 文档</option>
          <option value="memory">范围: 记忆</option>
          <option value="threads">范围: 对话</option>
          <option value="sessions">范围: 会话</option>
        </select>
        <select
          value={depth ?? 'summary'}
          onChange={(e) =>
            setDepth(e.target.value === 'summary' ? undefined : (e.target.value as EvidenceSearchParams['depth']))
          }
          className="console-form-input"
        >
          {DEPTH_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              深度: {opt.label}
            </option>
          ))}
        </select>
        <select
          value={dimension ?? 'all'}
          onChange={(e) =>
            setDimension(e.target.value === 'all' ? undefined : (e.target.value as EvidenceSearchParams['dimension']))
          }
          className="console-form-input"
          data-testid="evidence-dimension-select"
        >
          <option value="all">维度: 全部</option>
          <option value="project">维度: 项目</option>
          <option value="global">维度: 全局</option>
        </select>
        {depth === 'raw' && <span className="text-[11px] text-conn-amber-text">消息级仅支持精确匹配</span>}
      </form>

      {/* Error */}
      {error && <p className="text-sm text-conn-red-text">{error}</p>}

      {/* Results */}
      <div className="space-y-2">
        {results.map((item) => (
          <div key={item.anchor} className="rounded-xl bg-[var(--console-card-bg)] p-3">
            <div className="flex items-center gap-2 min-w-0">
              <span
                className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${SOURCE_TYPE_COLORS[item.sourceType] ?? SOURCE_TYPE_COLORS.commit}`}
              >
                {SOURCE_TYPE_LABELS[item.sourceType] ?? item.sourceType}
              </span>
              {item.source && (
                <span
                  className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${item.source === 'project' ? 'bg-[var(--console-active-bg)] text-cafe' : 'bg-conn-emerald-bg text-conn-emerald-text'}`}
                >
                  {item.source === 'project' ? '项目' : '全局'}
                </span>
              )}
              <ExpandableText
                text={item.title}
                as="h3"
                clampClass="truncate"
                className="text-sm font-medium text-cafe-black"
              />
            </div>
            <ExpandableText
              text={item.snippet}
              as="p"
              clampClass="line-clamp-3"
              className="mt-1 text-xs text-cafe-secondary"
            />
            {item.passages && item.passages.length > 0 && (
              <div className="mt-2 space-y-1 border-l-2 border-[var(--console-border-soft)] pl-2">
                {item.passages.map((p) => (
                  <div key={p.passageId} className="text-xs text-cafe-secondary">
                    {p.speaker && <span className="font-medium text-cafe-black">{p.speaker}: </span>}
                    <span className="italic">{p.content}</span>
                    {p.createdAt && (
                      <span className="ml-1 text-[10px] text-cafe-secondary/60">
                        {new Date(p.createdAt).toLocaleString('zh-CN', {
                          month: 'short',
                          day: 'numeric',
                          hour: '2-digit',
                          minute: '2-digit',
                        })}
                      </span>
                    )}
                    {p.context && p.context.length > 0 && (
                      <div className="ml-3 mt-0.5 space-y-0.5 border-l border-[var(--console-border-soft)] pl-2">
                        {p.context.map((ctx) => (
                          <div key={ctx.passageId} className="text-[11px] text-cafe-secondary/70">
                            {ctx.speaker && <span className="font-medium">{ctx.speaker}: </span>}
                            <span>{ctx.content}</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
        {results.length === 0 && !isSearching && !error && query && (
          <p className="text-sm text-cafe-secondary">无结果</p>
        )}
      </div>
    </div>
  );
}
