'use client';

import type { ActiveExecutionProjection } from '@cat-cafe/shared';
import { useEffect, useState } from 'react';
import { apiFetch } from '@/utils/api-client';
import { ExecutionCancelButton } from '../ExecutionCancelButton';
import { useShellCopy } from '../shell/shell-copy';
import { ManagedCommandLine } from './ManagedCommandLine';
import { managedJobCopy } from './managed-job.shell-copy';

const ACTIVE = new Set(['queued', 'running', 'cancelling']);
type JobState = keyof typeof managedJobCopy.zh.state;
interface JobDetail {
  state: JobState;
  command: string;
  createdAt: number;
  cancelable: boolean;
  tail?: string;
  exitCode?: number;
  durationMs?: number;
  transitions: { revision: number; at: number; state: string }[];
  recovery: RecoveryDetail[];
  recoveryPending: boolean;
}
type RecoveryDisposition = 'parked' | 'interrupted' | 'needs_attention';
interface RecoveryDetail {
  owner: 'wait' | 'job';
  disposition: RecoveryDisposition;
  reasonCode: string;
  recheck: boolean;
}
const object = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

function readRecovery(value: unknown, owner: RecoveryDetail['owner']): RecoveryDetail | null {
  const fact = object(value);
  const recheck = object(fact?.recheck);
  if (
    !fact ||
    !['parked', 'interrupted', 'needs_attention'].includes(String(fact.disposition)) ||
    typeof fact.reasonCode !== 'string'
  )
    return null;
  return {
    owner,
    disposition: fact.disposition as RecoveryDisposition,
    reasonCode: fact.reasonCode,
    recheck: recheck?.kind === 'observe_original_wait' || recheck?.kind === 'observe_original_job',
  };
}

function recoveryPending(value: unknown): boolean {
  const fact = object(value);
  if (!fact || fact.disposition) return false;
  const wakeIntent = object(fact.wakeIntent);
  return typeof fact.nextAttemptAt === 'number' || object(fact.claim) !== null || wakeIntent?.status === 'pending';
}

function readDetail(body: unknown, taskId: string, jobId: string): JobDetail | null {
  const envelope = object(body);
  const job = object(envelope?.job);
  const result = object(job?.result);
  if (
    envelope?.taskId !== taskId ||
    job?.jobId !== jobId ||
    job.originTaskId !== taskId ||
    typeof job.state !== 'string' ||
    !Object.hasOwn(managedJobCopy.zh.state, job.state) ||
    typeof job.command !== 'string' ||
    typeof job.createdAt !== 'number'
  )
    return null;
  return {
    state: job.state as JobState,
    command: job.command,
    createdAt: job.createdAt,
    cancelable: envelope.cancelable === true,
    ...(typeof job.tail === 'string' ? { tail: job.tail } : {}),
    ...(typeof result?.exitCode === 'number' ? { exitCode: result.exitCode } : {}),
    ...(typeof result?.durationMs === 'number' ? { durationMs: result.durationMs } : {}),
    transitions: Array.isArray(job.transitions)
      ? job.transitions.flatMap((entry: unknown) => {
          const row = object(entry);
          return row && typeof row.revision === 'number' && typeof row.at === 'number' && typeof row.state === 'string'
            ? [{ revision: row.revision, at: row.at, state: row.state }]
            : [];
        })
      : [],
    recovery: [readRecovery(envelope?.recovery, 'wait'), readRecovery(job.recovery, 'job')].filter(
      (item): item is RecoveryDetail => item !== null,
    ),
    recoveryPending: recoveryPending(envelope?.recovery) || recoveryPending(job.recovery),
  };
}

/** The original admission message stays the job entity; terminal notifications only refresh it. */
export function ManagedJobCard({
  taskId,
  jobId,
  threadId,
  catId,
  title,
  refreshKey,
  presentation = 'card',
}: {
  taskId: string;
  jobId: string;
  threadId?: string;
  catId?: string;
  title?: string;
  refreshKey?: string;
  presentation?: 'card' | 'inline';
}) {
  const words = useShellCopy(managedJobCopy);
  const inline = presentation === 'inline';
  const [expanded, setExpanded] = useState(false);
  const [detail, setDetail] = useState<JobDetail | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [recheckNonce, setRecheckNonce] = useState(0);
  const [rechecking, setRechecking] = useState(false);
  useEffect(() => {
    // Both values intentionally invalidate the status read without changing its request shape.
    void refreshKey;
    void recheckNonce;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();
    const refresh = async () => {
      let terminal = false;
      try {
        const response = await apiFetch(
          `/api/callbacks/hold-ball/${encodeURIComponent(taskId)}/status${expanded ? '?tailBytes=16384' : ''}`,
          { signal: controller.signal },
        );
        const next = response.ok ? readDetail(await response.json(), taskId, jobId) : null;
        if (disposed) return;
        setUnavailable(!next);
        if (next) {
          setDetail(next);
          terminal = !ACTIVE.has(next.state) && !next.recoveryPending;
        }
      } catch {
        if (!disposed) setUnavailable(true);
      }
      if (!disposed && !terminal) timer = setTimeout(() => void refresh(), 2000);
    };
    void refresh();
    return () => {
      disposed = true;
      controller.abort();
      if (timer) clearTimeout(timer);
    };
  }, [taskId, jobId, expanded, refreshKey, recheckNonce]);
  const recheck = async () => {
    setRechecking(true);
    try {
      await apiFetch(`/api/callbacks/hold-ball/${encodeURIComponent(taskId)}/recheck`, { method: 'POST' });
    } finally {
      setRechecking(false);
      setRecheckNonce((value) => value + 1);
    }
  };
  const execution: ActiveExecutionProjection | null =
    detail && threadId && catId && detail.cancelable
      ? {
          kind: 'managed_command',
          executionId: taskId,
          threadId,
          threadTitle: null,
          catId,
          startedAt: detail.createdAt,
          cancelability: { state: 'cancelable', target: { kind: 'managed_command', taskId } },
        }
      : null;
  const failed = detail && ['failed', 'timed_out', 'lost'].includes(detail.state);
  const elapsed = detail ? Math.max(0, Math.round((detail.durationMs ?? Date.now() - detail.createdAt) / 1000)) : null;
  return (
    <section data-testid="managed-job-card" data-job-id={jobId} className="min-w-0 space-y-3">
      {!inline ? (
        <div className="flex flex-wrap items-start justify-between gap-2">
          <span className="text-sm font-medium text-cafe-text">{title || words.title}</span>
          <span
            role="status"
            className={`text-xs ${unavailable ? 'text-cafe-muted' : failed ? 'text-conn-red-text' : 'text-cafe-secondary'}`}
          >
            {unavailable ? words.unavailable : detail ? words.state[detail.state] : words.loading}
          </span>
        </div>
      ) : unavailable ? (
        <output className="text-xs text-cafe-muted">{words.unavailable}</output>
      ) : !detail ? (
        <output className="text-xs text-cafe-muted">{words.loading}</output>
      ) : null}
      {unavailable ? <p className="text-xs text-cafe-muted">{words.reconnect}</p> : null}
      {detail && inline ? (
        <ManagedCommandLine command={detail.command} />
      ) : detail ? (
        <pre className="whitespace-pre-wrap break-all text-xs text-cafe-secondary">{detail.command}</pre>
      ) : null}
      <div className="flex items-center justify-between gap-3 text-xs text-cafe-muted">
        {elapsed !== null ? <span>{words.elapsed(elapsed)}</span> : <span />}
        {execution && !unavailable && !inline ? (
          <ExecutionCancelButton execution={execution} label={words.stop} pendingLabel={words.stopping} />
        ) : null}
      </div>
      {detail?.recovery.length ? (
        <div
          data-testid="managed-job-recovery"
          className="rounded border border-cafe-accent/40 bg-cafe-accent/5 p-3 text-xs"
        >
          <p className="font-medium text-cafe-secondary">{words.recoveryTitle}</p>
          <ul className="mt-1 space-y-1 text-cafe-muted">
            {detail.recovery.map((incident) => (
              <li key={`${incident.owner}:${incident.reasonCode}`}>
                {words.recoveryState[incident.disposition]} · {words.recoveryReason(incident.reasonCode)}
              </li>
            ))}
          </ul>
          {detail.recovery.some((incident) => incident.recheck) ? (
            <button
              type="button"
              disabled={rechecking}
              onClick={() => void recheck()}
              className="shell-focusable mt-2 rounded border border-cafe-border px-2 py-1 text-cafe-secondary disabled:opacity-50"
            >
              {rechecking ? words.rechecking : words.recheck}
            </button>
          ) : null}
        </div>
      ) : null}
      <details className={inline ? 'group' : undefined} onToggle={(event) => setExpanded(event.currentTarget.open)}>
        <summary className={`shell-focusable cursor-pointer text-xs text-cafe-muted${inline ? ' list-none' : ''}`}>
          {words.details}
          {inline ? (
            <span aria-hidden="true" className="ml-1 inline-block group-open:rotate-90">
              ›
            </span>
          ) : null}
        </summary>
        {expanded ? (
          <div className="mt-3 space-y-3 text-xs">
            {detail?.exitCode !== undefined ? <p>{words.exit(detail.exitCode)}</p> : null}
            <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all rounded border border-cafe-border bg-cafe-surface p-3">
              {detail?.tail || words.noOutput}
            </pre>
            {detail?.transitions.length ? (
              <ol aria-label={words.trace} className="space-y-1 text-cafe-muted">
                {detail.transitions.map((entry) => (
                  <li key={entry.revision}>
                    <time dateTime={new Date(entry.at).toISOString()}>{new Date(entry.at).toLocaleTimeString()}</time>
                    {' · '}
                    {entry.state === 'green'
                      ? words.state.succeeded
                      : Object.hasOwn(words.state, entry.state)
                        ? words.state[entry.state as JobState]
                        : entry.state}
                  </li>
                ))}
              </ol>
            ) : null}
          </div>
        ) : null}
      </details>
    </section>
  );
}
