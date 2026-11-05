'use client';
import { useEffect, useState } from 'react';
import { apiFetch } from '@/utils/api-client';
import { useShellCopy } from '../shell/shell-copy';
import { useShellLanguage } from '../shell/shell-language';
import { sessionImportCopy } from './session-import.shell-copy';
import { sessionActivity, sessionActivityDetail, sessionProjectName } from './session-import-presentation';

export interface RecentSession {
  sessionId: string;
  firstPrompt: string;
  projectPath: string;
  lastActivityAt: number;
  turnCount: number | null;
  alreadyBound: boolean;
  boundThread?: { id: string; title: string | null };
}

export function RecentSessionList({
  catId,
  selectedId,
  disabled,
  showExecHint = false,
  checkedSession,
  onPasteId,
  onSelect,
  onNavigate,
}: {
  catId: string;
  selectedId: string;
  disabled: boolean;
  showExecHint?: boolean;
  checkedSession?: { sessionId: string; lastActivityAt: number } | null;
  onPasteId: () => void;
  onSelect: (session: RecentSession) => void;
  onNavigate: (threadId: string) => void;
}) {
  const copy = useShellCopy(sessionImportCopy);
  const language = useShellLanguage();
  const [rows, setRows] = useState<RecentSession[]>([]);
  const [status, setStatus] = useState<'loading' | 'ready' | 'failed' | 'denied'>('loading');
  const [revision, refresh] = useState(0);
  const [limited, setLimited] = useState(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the explicit Refresh action intentionally repeats this read.
  useEffect(() => {
    const controller = new AbortController();
    setRows([]);
    setLimited(false);
    setStatus('loading');
    void apiFetch(`/api/local-sessions/${encodeURIComponent(catId)}?limit=20`, { signal: controller.signal })
      .then(async (response) => {
        if (response.status === 403) {
          if (!controller.signal.aborted) setStatus('denied');
          return;
        }
        if (!response.ok) throw new Error('Session index unavailable');
        const body = await response.json();
        if (!Array.isArray(body.sessions)) throw new Error('Session index unavailable');
        if (!controller.signal.aborted) {
          setRows(body.sessions);
          setLimited(Boolean(body.limited));
          setStatus('ready');
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) setStatus('failed');
      });
    return () => controller.abort();
  }, [catId, revision]);
  return (
    <section aria-label={copy.recent} className="space-y-2 text-sm">
      <div className="flex items-center justify-between gap-2">
        <h3 className="font-medium">{copy.recent}</h3>
        <button
          type="button"
          className="shell-focusable underline disabled:opacity-50"
          disabled={disabled || status === 'loading'}
          onClick={() => refresh((v) => v + 1)}
        >
          {copy.refreshList}
        </button>
      </div>
      <p role="status" className="text-xs text-[var(--shell-muted)]">
        {status === 'loading'
          ? copy.loadingList
          : status === 'denied'
            ? copy.ownerRequired
            : status === 'failed'
              ? copy.failedList
              : rows.length === 0
                ? copy.emptyList
                : ''}
      </p>
      {rows.length > 0 && (
        <ul className="rounded-xl border border-[var(--shell-hairline)] p-1">
          {rows.map((row) => {
            const boundTitle = row.boundThread?.title?.trim() || copy.untitledThread;
            const label = row.firstPrompt || (row.boundThread ? boundTitle : copy.unnamed);
            const activity =
              checkedSession?.sessionId === row.sessionId ? checkedSession.lastActivityAt : row.lastActivityAt;
            return (
              <li key={row.sessionId}>
                <label
                  className={`flex items-start gap-3 rounded-lg p-3 ${row.sessionId === selectedId ? 'bg-[var(--shell-frame)]' : 'hover:bg-[var(--shell-frame)]'} ${disabled || row.alreadyBound ? 'cursor-default' : 'cursor-pointer'} focus-within:outline focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-[var(--shell-primary)]`}
                >
                  <input
                    type="radio"
                    name="session-import-selection"
                    aria-label={label}
                    checked={row.sessionId === selectedId}
                    disabled={disabled || row.alreadyBound}
                    className="mt-1 h-4 w-4 shrink-0 accent-[var(--shell-primary)]"
                    onChange={() => onSelect(row)}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium" title={label}>
                      {label}
                    </span>
                    <span
                      className="mt-1 flex min-w-0 items-center gap-1 text-xs text-[var(--shell-muted)]"
                      title={`${row.projectPath} · ${sessionActivityDetail(activity, language, copy.unknownTime)}`}
                    >
                      <span className="min-w-0 truncate">{sessionProjectName(row.projectPath)}</span>
                      <span className="shrink-0">
                        · {sessionActivity(activity, language, copy.unknownTime)}
                        {row.turnCount != null && ` · ${row.turnCount} ${copy.turns}`}
                      </span>
                    </span>
                  </span>
                </label>
                {row.alreadyBound &&
                  (row.boundThread ? (
                    <button
                      type="button"
                      className="shell-focusable mb-2 ml-10 text-left text-xs underline"
                      disabled={disabled}
                      onClick={() => {
                        if (row.boundThread) onNavigate(row.boundThread.id);
                      }}
                    >
                      {label === boundTitle
                        ? copy.boundSameThread
                        : `${copy.boundPrefix}${boundTitle}${copy.boundSuffix}`}{' '}
                      · {copy.open}
                    </button>
                  ) : (
                    <p className="mb-2 ml-10 text-xs text-[var(--shell-muted)]">{copy.bound}</p>
                  ))}
              </li>
            );
          })}
        </ul>
      )}
      {status !== 'denied' && (
        <p className="text-xs leading-relaxed text-[var(--shell-muted)]">
          {status === 'ready' && limited && `${copy.limitedList} `}
          {status === 'ready' && rows.some((row) => row.turnCount == null) && `${copy.indexRoundsNote} `}
          <button
            type="button"
            className="shell-focusable underline underline-offset-2"
            disabled={disabled}
            onClick={onPasteId}
          >
            {copy.pasteToggle}
          </button>
          {status === 'ready' && showExecHint && <span className="block">{copy.execById}</span>}
        </p>
      )}
    </section>
  );
}
