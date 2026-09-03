'use client';

import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '@/utils/api-client';
import { EvolutionAttributionPanel } from './EvolutionAttributionPanel';
import { EvolutionObservationPanel } from './EvolutionObservationPanel';
import { type EvolutionProgramProjection, isProjection, type OwnerRef } from './evolution-program-projection';

function lifecycleClientMessageId(programId: string, action: 'pause' | 'resume', sequence: number): string {
  return `workbench:${action}:${programId}:sequence:${sequence}`;
}

function RefRow({ label, value }: { label: string; value: OwnerRef }) {
  return (
    <div className="grid gap-1 border-b border-cafe-subtle py-2 last:border-0 sm:grid-cols-[9rem_1fr]">
      <dt className="text-xs font-medium text-cafe-muted">{label}</dt>
      <dd className="break-all font-mono text-xs text-cafe-secondary">{value.ownerStateRef}</dd>
    </div>
  );
}

export function EvolutionProgramList({ onOpenProgram }: { onOpenProgram: (programId: string) => void }) {
  const [programs, setPrograms] = useState<EvolutionProgramProjection[]>([]);
  const [loading, setLoading] = useState(true);
  const [unavailable, setUnavailable] = useState(false);

  const load = useCallback(async () => {
    try {
      const response = await apiFetch('/api/capability-evolution/programs');
      if (!response.ok) throw new Error(`Program list failed (${response.status})`);
      const body = (await response.json()) as { programs?: unknown };
      if (!Array.isArray(body.programs)) throw new Error('Program list response is invalid');
      setPrograms(body.programs.filter(isProjection));
      setUnavailable(false);
    } catch {
      setUnavailable(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const loadWhenVisible = () => {
      if (document.visibilityState === 'visible') void load();
    };
    void load();
    const poll = window.setInterval(loadWhenVisible, 2_000);
    window.addEventListener('focus', loadWhenVisible);
    document.addEventListener('visibilitychange', loadWhenVisible);
    return () => {
      window.clearInterval(poll);
      window.removeEventListener('focus', loadWhenVisible);
      document.removeEventListener('visibilitychange', loadWhenVisible);
    };
  }, [load]);

  return (
    <section className="mx-auto w-full max-w-4xl px-5 pt-4" aria-label="Evolution Programs">
      <div className="rounded-xl border border-cafe-subtle bg-cafe-surface p-4">
        <div className="flex items-baseline justify-between gap-3">
          <h2 className="text-sm font-semibold text-cafe">Evolution Programs</h2>
          <span className="text-xs text-cafe-muted">建制与可见</span>
        </div>
        {loading ? (
          <p className="mt-3 text-xs text-cafe-muted">正在读取 canonical Programs…</p>
        ) : unavailable && programs.length === 0 ? (
          <p className="mt-3 text-xs text-cafe-muted">Program owner 暂时不可用；Workbench 没有创建本地副本。</p>
        ) : programs.length === 0 ? (
          <p className="mt-3 text-xs text-cafe-muted">说“我们来进化 X”，这里会出现 durable Program。</p>
        ) : (
          <div className="mt-3 grid gap-2 sm:grid-cols-2">
            {programs.map((projection) => (
              <button
                key={projection.program.programId}
                type="button"
                className="rounded-lg border border-cafe-subtle p-3 text-left hover:bg-cafe-hover"
                onClick={() => onOpenProgram(projection.program.programId)}
              >
                <span className="block truncate text-sm font-medium text-cafe">
                  {projection.program.objectRef.ownerStateRef}
                </span>
                <span className="mt-1 block text-xs text-cafe-muted">
                  {projection.program.lifecycle} · {projection.program.stage} · {projection.blockers.length} 个阻塞
                </span>
              </button>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

export function EvolutionProgramSurface({ programId }: { programId: string }) {
  const [projection, setProjection] = useState<EvolutionProgramProjection | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ code: 'program_state_synchronized'; message: string } | null>(null);
  const [pending, setPending] = useState(false);

  const load = useCallback(async () => {
    try {
      const response = await apiFetch(`/api/capability-evolution/programs/${encodeURIComponent(programId)}`);
      if (!response.ok) throw new Error(`Program read failed (${response.status})`);
      const body: unknown = await response.json();
      if (!isProjection(body)) throw new Error('Program projection is invalid');
      setProjection(body);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [programId]);

  useEffect(() => {
    void load();
  }, [load]);

  const lifecycleCommand = async (action: 'pause' | 'resume') => {
    if (!projection || pending) return;
    setPending(true);
    const clientMessageId = lifecycleClientMessageId(programId, action, projection.program.sequence);
    setNotice(null);
    const stateRef = `evolution-lifecycle-choice:${programId}:${clientMessageId}`;
    const commandAction =
      action === 'pause'
        ? { type: 'pause', reasonRef: { ownerFeatureId: 'F311', ownerStateRef: stateRef } }
        : { type: 'resume', resumeRef: { ownerFeatureId: 'F311', ownerStateRef: stateRef } };
    try {
      const response = await apiFetch(`/api/capability-evolution/programs/${encodeURIComponent(programId)}/commands`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          expectedSequence: projection.program.sequence,
          clientMessageId,
          action: commandAction,
        }),
      });
      const body = (await response.json()) as { projection?: unknown; detail?: string };
      if (response.status === 409 && isProjection(body.projection)) {
        setProjection(body.projection);
        setError(null);
        setNotice({
          code: 'program_state_synchronized',
          message:
            'Program \u5df2\u88ab\u5176\u4ed6\u64cd\u4f5c\u8005\u66f4\u65b0\uff0c\u5df2\u540c\u6b65\u5230\u6700\u65b0\u72b6\u6001\u3002',
        });
        return;
      }
      if (!response.ok || !isProjection(body.projection)) {
        throw new Error(body.detail ?? `Program command failed (${response.status})`);
      }
      setProjection(body.projection);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPending(false);
    }
  };

  if (!projection) {
    return <div className="p-5 text-xs text-cafe-muted">{error ?? '正在读取 canonical Program…'}</div>;
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-5" data-testid="evolution-program-surface">
      <div className="mx-auto max-w-3xl space-y-4">
        <section className="rounded-xl border border-cafe-subtle bg-cafe-surface p-4">
          <p className="text-xs font-medium text-cafe-muted">{projection.program.objectRef.ownerFeatureId}</p>
          <h2 className="mt-1 break-all text-base font-semibold text-cafe">
            {projection.program.objectRef.ownerStateRef}
          </h2>
          <div className="mt-3 flex flex-wrap gap-2 text-xs">
            <span className="rounded-full bg-cafe-hover px-3 py-1 text-cafe-secondary">
              {projection.program.lifecycle}
            </span>
            <span className="rounded-full bg-cafe-hover px-3 py-1 text-cafe-secondary">{projection.program.stage}</span>
            <span className="rounded-full bg-cafe-hover px-3 py-1 text-cafe-secondary">
              sequence {projection.program.sequence}
            </span>
          </div>
          <div className="mt-4 flex gap-2">
            {projection.program.lifecycle === 'active' && (
              <button
                type="button"
                disabled={pending}
                onClick={() => void lifecycleCommand('pause')}
                className="rounded-lg border border-cafe-subtle px-3 py-2 text-xs text-cafe-secondary"
              >
                暂停 Program
              </button>
            )}
            {projection.program.lifecycle === 'paused' && (
              <button
                type="button"
                disabled={pending}
                onClick={() => void lifecycleCommand('resume')}
                className="rounded-lg border border-cafe-subtle px-3 py-2 text-xs text-cafe-secondary"
              >
                恢复 Program
              </button>
            )}
          </div>
        </section>

        <EvolutionObservationPanel observation={projection.observation} />

        {/* Tolerate a projection from a runtime that predates Phase 3: no attribution is honest, undefined is not. */}
        <EvolutionAttributionPanel explanation={projection.attribution ?? null} />

        <section className="rounded-xl border border-cafe-subtle bg-cafe-surface p-4">
          <h3 className="text-sm font-semibold text-cafe">建制 refs</h3>
          <dl className="mt-2">
            <RefRow label="Object" value={projection.program.objectRef} />
            <RefRow label="Claim" value={projection.program.claimRef} />
            <RefRow label="Goal draft" value={projection.drafts.goal} />
            <RefRow label="Measurement draft" value={projection.drafts.measurement} />
            <RefRow label="Economic draft" value={projection.drafts.economic} />
            {Object.entries(projection.drafts.roles).map(([role, ref]) => (
              <RefRow key={role} label={`${role} draft`} value={ref} />
            ))}
          </dl>
        </section>

        <section className="rounded-xl border border-cafe-subtle bg-cafe-surface p-4">
          <h3 className="text-sm font-semibold text-cafe">阻塞与下一步</h3>
          {projection.blockers.length === 0 ? (
            <p className="mt-2 text-xs text-cafe-muted">当前没有 typed blocker。</p>
          ) : (
            <ul className="mt-2 space-y-2">
              {projection.blockers.map((blocker) => (
                <li key={blocker.code} className="rounded-lg bg-cafe-hover p-3">
                  <p className="font-mono text-xs text-cafe-secondary">{blocker.code}</p>
                  <p className="mt-1 text-xs leading-5 text-cafe-muted">{blocker.message}</p>
                </li>
              ))}
            </ul>
          )}
          <p className="mt-3 text-sm font-medium text-cafe">{projection.nextAction.label}</p>
          {notice && (
            <p role="status" data-notice-code={notice.code} className="mt-2 text-xs text-cafe-muted">
              {notice.message}
            </p>
          )}
          {error && <p className="mt-2 text-xs text-cafe-muted">{error}</p>}
        </section>
      </div>
    </div>
  );
}
