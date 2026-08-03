'use client';

import type { CSSProperties } from 'react';
import { useCallback, useEffect, useState } from 'react';
import { useCatData } from '@/hooks/useCatData';
import { resolveCatDisplayName } from '@/lib/cat-display-name';
import { apiFetch } from '@/utils/api-client';
import type { ExternalRuntimeSessionListItem } from '../runtime-sessions/external-runtime-session-types';
import { HandoffEventRows, type HandoffSummary, type RawEvent, RawEventRows } from './SessionEventRows';
import { type DigestNoiseSummary, RuntimeMetadataHeader } from './SessionRuntimeMetadataHeader';

type ViewMode = 'chat' | 'handoff' | 'raw';

interface ChatMessage {
  role: string;
  content: string;
  timestamp: number;
  invocationId?: string;
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isExternalRuntimeSessionListItem(value: unknown): value is ExternalRuntimeSessionListItem {
  if (!isObjectRecord(value)) return false;

  const lifecycle = value.lifecycle;
  const binding = value.binding;
  const drilldown = value.drilldown;

  return (
    typeof value.sessionId === 'string' &&
    typeof value.threadId === 'string' &&
    typeof value.runtime === 'string' &&
    typeof value.runtimeSessionId === 'string' &&
    typeof value.catId === 'string' &&
    typeof value.lastObservedAt === 'number' &&
    isObjectRecord(lifecycle) &&
    typeof lifecycle.state === 'string' &&
    isObjectRecord(binding) &&
    typeof binding.mode === 'string' &&
    isObjectRecord(drilldown) &&
    typeof drilldown.sessionRecord === 'string' &&
    typeof drilldown.events === 'string' &&
    typeof drilldown.digest === 'string'
  );
}

async function loadExternalRuntimeSession(sessionId: string): Promise<ExternalRuntimeSessionListItem | null> {
  try {
    const response = await apiFetch(`/api/external-runtime-sessions/${sessionId}`);
    if (!response || response.status === 404 || !response.ok) return null;
    const metadata = await response.json();
    return isExternalRuntimeSessionListItem(metadata) ? metadata : null;
  } catch {
    return null;
  }
}

async function loadDigestNoise(sessionId: string): Promise<DigestNoiseSummary[]> {
  try {
    const response = await apiFetch(`/api/sessions/${sessionId}/digest`);
    if (!response?.ok) return [];
    const digest = (await response.json()) as { diagnostics?: { noise?: DigestNoiseSummary[] } };
    return Array.isArray(digest.diagnostics?.noise) ? digest.diagnostics.noise : [];
  } catch {
    return [];
  }
}

export interface SessionEventsViewerProps {
  sessionId: string;
  catId?: string;
  onClose: () => void;
}

const PAGE_SIZE = 30;

const ROLE_STYLES: Record<string, string> = {
  user: 'text-[var(--color-cafe-accent)]',
  system: 'bg-cafe-surface-elevated text-cafe-secondary',
};
/* Slash opacity on CSS-var colors silently fails; use color-mix() via inline style. */
const ROLE_INLINE_STYLES: Record<string, CSSProperties> = {
  user: { backgroundColor: 'color-mix(in oklch, var(--color-cafe-accent) 10%, transparent)' },
};

const ASSISTANT_STYLE_BY_CAT: Record<string, string> = {
  opus: 'bg-opus-light text-opus-dark',
  codex: 'bg-codex-light text-codex-dark',
  gemini: 'bg-gemini-light text-gemini-dark',
  kimi: 'bg-kimi-light text-kimi-dark',
  gpt52: 'bg-conn-emerald-bg text-conn-emerald-text',
  'opus-45': 'bg-conn-purple-bg text-[var(--color-opus-primary)]',
  sonnet: 'bg-conn-purple-bg text-[var(--color-opus-primary)]',
};

function assistantRoleStyle(catId?: string): string {
  if (!catId) return 'bg-cafe-surface-elevated text-cafe-secondary';
  return ASSISTANT_STYLE_BY_CAT[catId] ?? 'bg-cafe-surface-elevated text-cafe-secondary';
}

export function SessionEventsViewer({ sessionId, catId, onClose }: SessionEventsViewerProps) {
  const { getCatById } = useCatData();
  const [view, setView] = useState<ViewMode>('chat');
  const [dataView, setDataView] = useState<ViewMode>('chat');
  const [data, setData] = useState<ChatMessage[] | HandoffSummary[] | RawEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [cursor, setCursor] = useState(0);
  const [nextCursor, setNextCursor] = useState<number | null>(null);
  const [total, setTotal] = useState(0);
  const [cursorHistory, setCursorHistory] = useState<number[]>([]);
  const [runtimeSession, setRuntimeSession] = useState<ExternalRuntimeSessionListItem | null>(null);
  const [digestNoise, setDigestNoise] = useState<DigestNoiseSummary[]>([]);

  const fetchEvents = useCallback(
    async (v: ViewMode, c: number) => {
      setLoading(true);
      setError(false);
      try {
        const res = await apiFetch(`/api/sessions/${sessionId}/events?view=${v}&cursor=${c}&limit=${PAGE_SIZE}`);
        if (!res.ok) {
          setError(true);
          return;
        }
        const json = await res.json();
        setTotal(json.total ?? 0);
        setNextCursor(json.nextCursor?.eventNo ?? null);

        if (v === 'chat') setData(json.messages ?? []);
        else if (v === 'handoff') setData(json.invocations ?? []);
        else setData(json.events ?? []);
        setDataView(v);
      } catch {
        setError(true);
      } finally {
        setLoading(false);
      }
    },
    [sessionId],
  );

  // Stale-while-revalidate: keep old data visible during view switch.
  // fetchEvents() replaces data on success; cursor/history reset here
  // because the new view always starts at page 0.
  useEffect(() => {
    setCursor(0);
    setCursorHistory([]);
    fetchEvents(view, 0);
  }, [view, fetchEvents]);

  useEffect(() => {
    let alive = true;
    setRuntimeSession(null);
    setDigestNoise([]);

    void (async () => {
      const metadata = await loadExternalRuntimeSession(sessionId);
      if (!alive || !metadata) return;
      setRuntimeSession(metadata);
      const noise = await loadDigestNoise(sessionId);
      if (alive) setDigestNoise(noise);
    })();
    return () => {
      alive = false;
    };
  }, [sessionId]);

  const goNext = () => {
    if (nextCursor == null) return;
    setCursorHistory((h) => [...h, cursor]);
    setCursor(nextCursor);
    fetchEvents(view, nextCursor);
  };

  const goPrev = () => {
    if (cursorHistory.length === 0) return;
    const prev = cursorHistory[cursorHistory.length - 1];
    setCursorHistory((h) => h.slice(0, -1));
    setCursor(prev);
    fetchEvents(view, prev);
  };

  const assistantStyle = assistantRoleStyle(catId);
  const assistantLabel = catId ? resolveCatDisplayName(catId, getCatById) : 'assistant';

  return (
    <div className="rounded-lg border border-[var(--console-border-soft)] bg-cafe-surface">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-[var(--console-border-soft)]">
        <span className="text-xs font-semibold text-cafe-secondary">Session 事件</span>
        <button
          type="button"
          data-testid="session-viewer-close"
          onClick={onClose}
          className="text-cafe-muted hover:text-cafe-secondary text-sm"
        >
          ✕
        </button>
      </div>

      {runtimeSession && <RuntimeMetadataHeader session={runtimeSession} noise={digestNoise} />}

      {/* View mode tabs */}
      <div className="flex border-b border-[var(--console-border-soft)]">
        {(['chat', 'handoff', 'raw'] as const).map((m) => (
          <button
            type="button"
            key={m}
            onClick={() => setView(m)}
            className={`flex-1 py-1.5 text-micro font-semibold uppercase tracking-wider transition-colors
              ${view === m ? 'text-[var(--color-cafe-accent)] border-b-2 border-[var(--color-cafe-accent)]' : 'text-cafe-muted hover:text-cafe-secondary'}`}
          >
            {m === 'chat' ? 'Chat' : m === 'handoff' ? 'Handoff' : 'Raw'}
          </button>
        ))}
      </div>

      {/* Content — stale-while-revalidate: show old data with loading indicator */}
      <div className="max-h-72 overflow-y-auto p-2">
        {loading && data.length > 0 && (
          <div className="text-micro text-cafe-muted text-center py-1 animate-pulse">Refreshing...</div>
        )}
        {loading && data.length === 0 && <div className="text-xs text-cafe-muted py-2">加载中...</div>}
        {error && <div className="text-xs text-conn-red-text py-2">加载失败</div>}

        {!error && dataView === 'chat' && (
          <div className="space-y-1.5">
            {(data as ChatMessage[]).map((msg, i) => (
              <div
                key={`${msg.role}-${msg.timestamp}-${i}`}
                className={`rounded px-2 py-1.5 text-xs ${
                  msg.role === 'assistant'
                    ? assistantStyle
                    : (ROLE_STYLES[msg.role] ?? 'bg-cafe-surface-elevated text-cafe-secondary')
                }`}
                style={ROLE_INLINE_STYLES[msg.role]}
              >
                <span className="font-medium">{msg.role === 'assistant' ? assistantLabel : msg.role}</span>
                <p className="mt-0.5 whitespace-pre-wrap break-words">{msg.content}</p>
              </div>
            ))}
          </div>
        )}

        {!error && dataView === 'handoff' && <HandoffEventRows invocations={data as HandoffSummary[]} />}

        {!error && dataView === 'raw' && <RawEventRows events={data as RawEvent[]} />}
      </div>

      {/* Pagination */}
      <div className="flex items-center justify-between px-3 py-1.5 border-t border-[var(--console-border-soft)] text-micro text-cafe-muted">
        <span>{total} 条事件</span>
        <div className="flex gap-2">
          {cursorHistory.length > 0 && (
            <button type="button" onClick={goPrev} className="text-[var(--color-cafe-accent)] hover:opacity-80">
              上一页
            </button>
          )}
          {nextCursor != null && (
            <button type="button" onClick={goNext} className="text-[var(--color-cafe-accent)] hover:opacity-80">
              下一页
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
