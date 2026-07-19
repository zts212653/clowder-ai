'use client';

// biome-ignore lint/correctness/noUnusedImports: React needed for JSX in vitest environment
import React, { useCallback, useEffect, useState } from 'react';
import { useCatData } from '@/hooks/useCatData';
import { useCatTechnicalLabelResolver } from '@/hooks/useCatNameResolver';
import { resolveCatDisplayName } from '@/lib/cat-display-name';
import { apiFetch } from '@/utils/api-client';
import {
  formatBindingLabel,
  formatLifecycleBadge,
  formatRuntimeLabel,
  formatSealReason,
  shortRuntimeId,
} from '../runtime-sessions/external-runtime-session-format';
import type { ExternalRuntimeSessionListItem } from '../runtime-sessions/external-runtime-session-types';

type ViewMode = 'chat' | 'handoff' | 'raw';

interface ChatMessage {
  role: string;
  content: string;
  timestamp: number;
  invocationId?: string;
}

interface HandoffSummary {
  invocationId: string;
  eventCount: number;
  toolCalls: string[];
  errors: number;
  durationMs: number;
  keyMessages: string[];
}

interface RawEvent {
  eventNo: number;
  v: number;
  t: number;
  catId: string;
  event: Record<string, unknown>;
}

interface DigestNoiseSummary {
  kind: string;
  count: number;
  sample: string;
  invocationIds: string[];
  firstAt: number;
  lastAt: number;
  outcome: 'recovered' | 'terminal' | string;
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

export interface SessionEventsViewerProps {
  sessionId: string;
  catId?: string;
  onClose: () => void;
}

const PAGE_SIZE = 30;

function fmtDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec}s`;
  return `${Math.floor(sec / 60)}m${sec % 60}s`;
}

const ROLE_STYLES: Record<string, string> = {
  user: 'text-[var(--color-cafe-accent)]',
  system: 'bg-cafe-surface-elevated text-cafe-secondary',
};
/* Slash opacity on CSS-var colors silently fails; use color-mix() via inline style. */
const ROLE_INLINE_STYLES: Record<string, React.CSSProperties> = {
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

    async function fetchRuntimeMetadata() {
      try {
        const metadataRes = await apiFetch(`/api/external-runtime-sessions/${sessionId}`);
        if (!metadataRes || metadataRes.status === 404 || !metadataRes.ok) return;
        const metadata = await metadataRes.json();
        if (!isExternalRuntimeSessionListItem(metadata)) return;
        if (!alive) return;
        setRuntimeSession(metadata);

        try {
          const digestRes = await apiFetch(`/api/sessions/${sessionId}/digest`);
          if (!digestRes?.ok) return;
          const digest = (await digestRes.json()) as { diagnostics?: { noise?: DigestNoiseSummary[] } };
          if (alive) setDigestNoise(Array.isArray(digest.diagnostics?.noise) ? digest.diagnostics.noise : []);
        } catch {
          if (alive) setDigestNoise([]);
        }
      } catch {
        if (alive) {
          setRuntimeSession(null);
          setDigestNoise([]);
        }
      }
    }

    void fetchRuntimeMetadata();
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

        {!error && view === 'chat' && (
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

        {!error && view === 'handoff' && (
          <div className="space-y-1.5">
            {(data as HandoffSummary[]).map((inv) => (
              <div
                key={inv.invocationId}
                className="rounded border border-[var(--console-border-soft)] px-2 py-1.5 text-xs"
              >
                <div className="flex items-center gap-1.5 min-w-0">
                  <span className="truncate min-w-0 font-mono text-cafe-secondary" title={inv.invocationId}>
                    {inv.invocationId}
                  </span>
                  <span className="shrink-0 text-cafe-muted">{fmtDuration(inv.durationMs)}</span>
                  {inv.errors > 0 && <span className="shrink-0 text-conn-red-text">{inv.errors} err</span>}
                </div>
                <div className="flex flex-wrap gap-1 mt-1">
                  {(inv.toolCalls ?? []).map((t, index) => (
                    <span
                      key={`${t}-${index}`}
                      className="bg-cafe-surface-elevated text-cafe-secondary px-1 py-0.5 rounded text-micro"
                    >
                      {t}
                    </span>
                  ))}
                </div>
                {(inv.keyMessages ?? []).length > 0 && (
                  <p className="text-cafe-secondary mt-1 truncate">{(inv.keyMessages ?? [])[0]}</p>
                )}
              </div>
            ))}
          </div>
        )}

        {!error && view === 'raw' && (
          <div className="space-y-1">
            {(data as RawEvent[]).map((evt) => (
              <div
                key={evt.eventNo}
                className="text-micro font-mono bg-cafe-surface-elevated rounded px-1.5 py-1 truncate"
                title={JSON.stringify(evt.event)}
              >
                <span className="text-cafe-muted">#{evt.eventNo}</span>{' '}
                <span className="text-cafe-secondary">{JSON.stringify(evt.event)}</span>
              </div>
            ))}
          </div>
        )}
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

function RuntimeMetadataHeader({
  session,
  noise,
}: {
  session: ExternalRuntimeSessionListItem;
  noise: DigestNoiseSummary[];
}) {
  const resolveCatName = useCatTechnicalLabelResolver();
  const badge = formatLifecycleBadge(session.lifecycle);
  const latestIdentity = session.identityHistory?.at(-1);
  const model = latestIdentity?.model ?? session.model ?? 'model unknown';
  const identityLabel = `${resolveCatName(latestIdentity?.catId ?? session.catId)} · ${model}`;

  return (
    <div className="space-y-2 bg-[var(--console-shell-bg)] px-3 py-2 console-divider-b">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <span className="text-xs font-semibold text-cafe-secondary">{formatRuntimeLabel(session.runtime)}</span>
        <span className={`rounded-md px-1.5 py-0.5 text-micro font-semibold ${badge.className}`}>{badge.label}</span>
        {session.lifecycle.sealReason && (
          <span className="text-micro text-cafe-muted">{formatSealReason(session.lifecycle.sealReason)}</span>
        )}
      </div>
      <div className="grid min-w-0 gap-x-3 gap-y-1 text-micro text-cafe-muted sm:grid-cols-2">
        <span className="min-w-0 truncate font-mono">Cascade {shortRuntimeId(session.runtimeSessionId)}</span>
        {session.runtimeConversationId && (
          <span className="min-w-0 truncate font-mono">Conversation {session.runtimeConversationId}</span>
        )}
        <span className="min-w-0 truncate">{identityLabel}</span>
        <span className="min-w-0 truncate">{formatBindingLabel(session.binding)}</span>
      </div>
      <div className="flex flex-wrap gap-2 text-micro">
        <a className="text-conn-blue-text hover:text-conn-blue-hover" href={session.drilldown.sessionRecord}>
          record
        </a>
        <a className="text-conn-blue-text hover:text-conn-blue-hover" href={session.drilldown.events}>
          events
        </a>
        <a className="text-conn-blue-text hover:text-conn-blue-hover" href={session.drilldown.digest}>
          digest
        </a>
      </div>
      {noise.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {noise.map((entry) => (
            <span
              key={`${entry.kind}-${entry.firstAt}-${entry.lastAt}`}
              className="rounded-md bg-cafe-surface-elevated px-1.5 py-0.5 text-micro text-cafe-secondary"
              title={entry.sample}
            >
              {entry.kind} × {entry.count} · {entry.outcome}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
