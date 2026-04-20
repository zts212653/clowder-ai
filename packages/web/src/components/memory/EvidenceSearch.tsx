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
  decision: 'bg-amber-100 text-amber-800',
  phase: 'bg-blue-100 text-blue-800',
  feature: 'bg-purple-100 text-purple-800',
  lesson: 'bg-green-100 text-green-800',
  research: 'bg-cyan-100 text-cyan-800',
  knowledge: 'bg-pink-100 text-pink-800',
  discussion: 'bg-gray-100 text-gray-700',
  commit: 'bg-gray-100 text-gray-600',
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
      {/* Search bar */}
      <div className="flex gap-2">
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
          placeholder="搜索项目知识..."
          className="flex-1 rounded-lg border border-cafe bg-white px-3 py-2 text-sm text-cafe-black placeholder:text-cafe-secondary focus:border-cocreator-primary focus:outline-none"
          data-testid="evidence-search-input"
        />
        <button
          type="button"
          onClick={handleSearch}
          disabled={isSearching || !query.trim()}
          className="rounded-lg bg-cocreator-primary px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-cocreator-dark disabled:opacity-40"
          data-testid="evidence-search-button"
        >
          {isSearching ? '...' : '搜索'}
        </button>
      </div>

      {/* Mode / Scope selectors */}
      <div className="flex gap-3 text-xs">
        <label className="flex items-center gap-1 text-cafe-secondary">
          检索模式:
          <select
            value={depth === 'raw' ? 'lexical' : mode}
            onChange={(e) => setMode(e.target.value as EvidenceSearchParams['mode'])}
            disabled={depth === 'raw'}
            className="rounded border border-cafe bg-white px-1.5 py-0.5 text-xs disabled:opacity-50"
          >
            <option value="hybrid">混合</option>
            <option value="lexical">精确</option>
            <option value="semantic">语义</option>
          </select>
          {depth === 'raw' && <span className="text-[10px] text-amber-600">消息级仅支持精确匹配</span>}
        </label>
        <label className="flex items-center gap-1 text-cafe-secondary">
          范围:
          <select
            value={scope ?? 'all'}
            onChange={(e) =>
              setScope(e.target.value === 'all' ? undefined : (e.target.value as EvidenceSearchParams['scope']))
            }
            className="rounded border border-cafe bg-white px-1.5 py-0.5 text-xs"
          >
            <option value="all">全部</option>
            <option value="docs">文档</option>
            <option value="memory">记忆</option>
            <option value="threads">对话</option>
            <option value="sessions">会话</option>
          </select>
        </label>
        <label className="flex items-center gap-1 text-cafe-secondary">
          深度:
          <select
            value={depth ?? 'summary'}
            onChange={(e) =>
              setDepth(e.target.value === 'summary' ? undefined : (e.target.value as EvidenceSearchParams['depth']))
            }
            className="rounded border border-cafe bg-white px-1.5 py-0.5 text-xs"
          >
            {DEPTH_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-1 text-cafe-secondary">
          维度:
          <select
            value={dimension ?? 'all'}
            onChange={(e) =>
              setDimension(e.target.value === 'all' ? undefined : (e.target.value as EvidenceSearchParams['dimension']))
            }
            className="rounded border border-cafe bg-white px-1.5 py-0.5 text-xs"
            data-testid="evidence-dimension-select"
          >
            <option value="all">全部</option>
            <option value="project">项目</option>
            <option value="global">全局</option>
          </select>
        </label>
      </div>

      {/* Error */}
      {error && <p className="text-sm text-red-600">{error}</p>}

      {/* Results */}
      <div className="space-y-2">
        {results.map((item) => (
          <div key={item.anchor} className="rounded-lg border border-cafe bg-white p-3">
            <div className="flex items-center gap-2 min-w-0">
              <span
                className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${SOURCE_TYPE_COLORS[item.sourceType] ?? SOURCE_TYPE_COLORS.commit}`}
              >
                {SOURCE_TYPE_LABELS[item.sourceType] ?? item.sourceType}
              </span>
              {item.source && (
                <span
                  className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${item.source === 'project' ? 'bg-indigo-100 text-indigo-800' : 'bg-teal-100 text-teal-800'}`}
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
              <div className="mt-2 space-y-1 border-l-2 border-cocreator-light pl-2">
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
                      <div className="ml-3 mt-0.5 space-y-0.5 border-l border-cafe/30 pl-2">
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
