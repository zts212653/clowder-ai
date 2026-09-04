'use client';

import { useState } from 'react';
import { apiFetch } from '@/utils/api-client';
import {
  type EvolutionChangeLineage,
  type EvolutionProgramProjection,
  isOwnerRef,
  isProjection,
  type OwnerRef,
} from './evolution-program-projection';

type MetabolismDecision = 'keep' | 'tune' | 'rollback' | 'sunset' | 'no_change';
type ChangeAction = { kind: 'sync' } | { kind: 'decide'; decision: MetabolismDecision };
type ChangeResponseBody = {
  outcome?: string;
  projection?: unknown;
  blockerRef?: unknown;
  blockerReason?: unknown;
  detail?: string;
};

const decisionLabels: Record<MetabolismDecision, string> = {
  keep: 'Keep',
  tune: 'Tune',
  rollback: 'Rollback',
  sunset: 'Sunset',
  no_change: 'No change',
};

function actionIdentity(action: ChangeAction): string {
  return action.kind === 'decide' ? `decide-${action.decision}` : action.kind;
}

function changeClientMessageId(programId: string, action: ChangeAction, sequence: number): string {
  return `workbench:change:${actionIdentity(action)}:${programId}:sequence:${sequence}`;
}

function blockedNotice(body: ChangeResponseBody): string {
  if (body.blockerRef !== undefined && !isOwnerRef(body.blockerRef)) {
    throw new Error('Change owner returned an invalid blocker reference');
  }
  if (isOwnerRef(body.blockerRef)) return `Owner 拒绝执行：${body.blockerRef.ownerStateRef}`;
  const reason = typeof body.blockerReason === 'string' ? body.blockerReason.trim() : '';
  return `Owner 拒绝执行：${reason || 'owner_blocked'}`;
}

async function readChangeResponse(response: Response): Promise<{
  projection: EvolutionProgramProjection;
  notice: string;
}> {
  const body = (await response.json()) as ChangeResponseBody;
  const isConflict = response.status === 409 && body.outcome === 'conflict';
  if ((!response.ok && !isConflict) || !isProjection(body.projection)) {
    throw new Error(body.detail ?? `Change owner request failed (${response.status})`);
  }
  if (body.outcome === 'blocked') {
    return { projection: body.projection, notice: blockedNotice(body) };
  }
  if (isConflict) {
    return { projection: body.projection, notice: 'Program 已同步到最新 sequence，请按当前状态继续。' };
  }
  if (body.outcome === 'waiting') {
    return {
      projection: body.projection,
      notice: 'Owner 仍在处理；没有创建 Approval、Task 或 mutation 的本地副本。',
    };
  }
  return { projection: body.projection, notice: 'Canonical change lineage 已更新。' };
}

function RefValue({ label, value }: { label: string; value?: OwnerRef }) {
  if (!value) return null;
  return (
    <div className="grid gap-1 border-b border-cafe-subtle py-2 last:border-0 sm:grid-cols-[8rem_1fr]">
      <dt className="text-xs font-medium text-cafe-muted">{label}</dt>
      <dd className="break-all font-mono text-xs text-cafe-secondary">
        {value.ownerStateRef}
        {value.version ? ` · ${value.version}` : ''}
      </dd>
    </div>
  );
}

function ChangeRefs({ change }: { change: EvolutionChangeLineage }) {
  return (
    <dl className="mt-2">
      <RefValue label="Case" value={change.caseRef} />
      <RefValue label="Proposal" value={change.proposalRef} />
      <RefValue label="Owner authorization" value={change.ownerAuthorizationRef} />
      <RefValue label="Exact target" value={change.targetVersionRef} />
      <RefValue label="Approval" value={change.approvalRef} />
      <RefValue label="Decision" value={change.approvalDecisionRef} />
      <RefValue label="Intervention receipt" value={change.interventionReceiptRef} />
      <RefValue label="Asset version" value={change.assetVersionRef} />
      <RefValue label="Loaded runtime" value={change.loadedRuntimeRef} />
      <RefValue label="Fresh outcome" value={change.outcomeReceiptRef} />
      <RefValue label="Freshness proof" value={change.freshnessProofRef} />
    </dl>
  );
}

function canDecideChange(projection: EvolutionProgramProjection, current?: EvolutionChangeLineage): boolean {
  return (
    projection.program.lifecycle === 'active' &&
    projection.program.stage === 'deciding' &&
    current?.status === 'outcome' &&
    current.interventionReceiptRef !== undefined &&
    current.assetVersionRef !== undefined &&
    current.outcomeReceiptRef !== undefined &&
    (current.interventionKind === 'no_change' || current.loadedRuntimeRef !== undefined) &&
    current.freshnessProofRef !== undefined
  );
}

function changeSyncLabel(stage: string): string {
  if (stage === 'writing_back') return '刷新 owner 写回';
  if (stage === 'revalidating') return '刷新 fresh outcome';
  return '刷新批准状态';
}

export function EvolutionChangePanel({
  projection,
  onProjection,
}: {
  projection: EvolutionProgramProjection;
  onProjection: (projection: EvolutionProgramProjection) => void;
}) {
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const current = projection.lineage.current;

  const run = async (action: ChangeAction) => {
    if (pending) return;
    setPending(true);
    setNotice(null);
    const clientMessageId = changeClientMessageId(projection.program.programId, action, projection.program.sequence);
    try {
      const response = await apiFetch(
        `/api/capability-evolution/programs/${encodeURIComponent(projection.program.programId)}/changes`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            expectedSequence: projection.program.sequence,
            clientMessageId,
            action,
          }),
        },
      );
      const result = await readChangeResponse(response);
      onProjection(result.projection);
      setNotice(result.notice);
    } catch (cause) {
      setNotice(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPending(false);
    }
  };

  const awaitsProposal =
    projection.program.lifecycle === 'active' &&
    projection.program.stage === 'awaiting_approval' &&
    (current === undefined ||
      current.status === 'rejected' ||
      current.status === 'withdrawn' ||
      current.status === 'superseded' ||
      current.status === 'target_drift');
  const canSync =
    projection.program.lifecycle === 'active' &&
    current !== undefined &&
    (current.status === 'pending' ||
      projection.program.stage === 'writing_back' ||
      projection.program.stage === 'revalidating');
  const canDecide = canDecideChange(projection, current);
  const syncLabel = changeSyncLabel(projection.program.stage);

  return (
    <section className="rounded-xl border border-cafe-subtle bg-cafe-surface p-4" data-testid="evolution-change-panel">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-sm font-semibold text-cafe">Change &amp; Learn</h3>
        <span className="text-xs text-cafe-muted">F246 / F266 / owner canonical refs</span>
      </div>

      {current ? (
        <div className="mt-3 rounded-lg bg-cafe-hover p-3">
          <div className="flex items-center justify-between gap-3">
            <p className="text-xs font-medium text-cafe">当前 change cycle</p>
            <span className="font-mono text-xs text-cafe-secondary">{current.status}</span>
          </div>
          <ChangeRefs change={current} />
        </div>
      ) : (
        <p className="mt-3 text-xs leading-5 text-cafe-muted">
          当前 Cycle 尚未绑定 change proposal；observe / insufficient 会留在自动复查车道。
        </p>
      )}

      {projection.lineage.cycles.some((cycle) => cycle.decision !== undefined) && (
        <ol className="mt-3 space-y-2" aria-label="Change cycle history">
          {projection.lineage.cycles.map((cycle) => (
            <li key={cycle.cycle} className="rounded-lg border border-cafe-subtle px-3 py-2 text-xs">
              <span className="font-medium text-cafe">Cycle {cycle.cycle}</span>
              <span className="ml-2 font-mono text-cafe-secondary">{cycle.decision ?? 'open'}</span>
              {cycle.executionReceiptRef && (
                <span className="mt-1 block break-all font-mono text-cafe-muted">
                  {cycle.executionReceiptRef.ownerStateRef}
                </span>
              )}
              {cycle.decisionAssetVersionRef && (
                <span className="mt-1 block break-all font-mono text-cafe-muted">
                  {cycle.decisionAssetVersionRef.assetKind}:{cycle.decisionAssetVersionRef.assetId} ·{' '}
                  {cycle.decisionAssetVersionRef.version}
                </span>
              )}
            </li>
          ))}
        </ol>
      )}

      {awaitsProposal && (
        <p className="mt-3 text-xs leading-5 text-cafe-muted">
          认证猫会从 owner-backed intervention 发起{current ? ' fresh proposal' : '受治理变更'}；Workbench 不构造
          Approval、owner 身份或来源。
        </p>
      )}

      <div className="mt-3 flex flex-wrap gap-2">
        {canSync && (
          <button
            type="button"
            disabled={pending}
            onClick={() => void run({ kind: 'sync' })}
            className="rounded-lg border border-cafe-subtle px-3 py-2 text-xs text-cafe-secondary"
          >
            {syncLabel}
          </button>
        )}
        {canDecide &&
          (Object.keys(decisionLabels) as MetabolismDecision[]).map((decision) => (
            <button
              key={decision}
              type="button"
              disabled={pending}
              onClick={() => void run({ kind: 'decide', decision })}
              className="rounded-lg border border-cafe-subtle px-3 py-2 text-xs text-cafe-secondary"
            >
              {decisionLabels[decision]}
            </button>
          ))}
      </div>
      {notice && <output className="mt-3 block text-xs leading-5 text-cafe-muted">{notice}</output>}
    </section>
  );
}
