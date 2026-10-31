'use client';

import type { ReactNode } from 'react';
import { useEvalDetailCopy } from './eval-workspace/eval-detail.shell-copy';
import type { EvalHubFrictionProjection } from './HubEvalTypes';

export function HubEvalFrictionSections({
  friction,
  openWorkspaceFile,
}: {
  friction: EvalHubFrictionProjection | undefined;
  openWorkspaceFile: (path: string) => void;
}) {
  const detail = useEvalDetailCopy();
  if (!friction || friction.projectionStatus !== 'available') {
    return (
      <div className="mt-4 rounded-lg border border-dashed border-cafe bg-cafe-surface px-3 py-3 text-sm text-cafe-secondary">
        {detail.frictionUnavailable}
      </div>
    );
  }

  const hasAnyProjection = friction.actionableCandidates.length > 0 || friction.referenceOnly.length > 0;
  return (
    <div className="mt-4 space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-xs font-medium text-cafe-muted">{detail.rollup}</div>
        {friction.source?.rawReportPath && (
          <JumpButton onClick={() => openWorkspaceFile(friction.source?.rawReportPath ?? '')}>
            {detail.rawReport}
          </JumpButton>
        )}
      </div>

      {!hasAnyProjection && (
        <div className="rounded-lg border border-dashed border-cafe bg-cafe-surface px-3 py-3 text-sm text-cafe-secondary">
          {detail.rollupEmpty}
        </div>
      )}

      {friction.actionableCandidates.length > 0 && (
        <div className="space-y-2">
          <div className="text-sm font-semibold text-cafe">{detail.suggestedRepairs}</div>
          <p className="text-xs text-cafe-muted">{detail.draftHint}</p>
          {friction.actionableCandidates.map((candidate) => (
            <div key={candidate.clusterId} className="rounded-lg border border-cafe bg-cafe-surface px-3 py-3">
              <div className="flex flex-wrap items-center gap-2">
                <div className="text-sm font-semibold text-cafe">{candidate.followupDraft.title}</div>
                <MetaPill>{candidate.severity}</MetaPill>
                <MetaPill>{candidate.count} signals</MetaPill>
              </div>
              <p className="mt-1 text-sm text-cafe-secondary">{candidate.followupDraft.summary}</p>
              <p className="mt-2 text-xs text-cafe-muted">
                {detail.channels}: {candidate.channels.join(', ')} · {detail.sensors}:{' '}
                {candidate.sensorForms.join(', ')}
              </p>
              <p className="mt-1 text-xs text-cafe-muted">
                draft evidence: {candidate.followupDraft.evidenceRefs.length} · reference-only evidence:{' '}
                {candidate.referenceOnlyEvidenceRefs.length}
              </p>
            </div>
          ))}
        </div>
      )}

      {friction.referenceOnly.length > 0 && (
        <div className="space-y-2">
          <div className="text-sm font-semibold text-cafe">{detail.referenceOnly}</div>
          <p className="text-xs text-cafe-muted">{detail.referenceHint}</p>
          {friction.referenceOnly.map((cluster) => (
            <div key={cluster.clusterId} className="rounded-lg border border-cafe bg-cafe-surface px-3 py-3">
              <div className="flex flex-wrap items-center gap-2">
                <div className="text-sm font-semibold text-cafe">{cluster.representative}</div>
                <MetaPill>{cluster.severity}</MetaPill>
                <MetaPill>{cluster.count} signals</MetaPill>
              </div>
              <p className="mt-2 text-xs text-cafe-muted">
                {detail.channels}: {cluster.channels.join(', ')} · {detail.sensors}: {cluster.sensorForms.join(', ')} ·
                evidence: {cluster.evidenceRefs.length}
              </p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function JumpButton({ children, onClick }: { children: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded-md border border-cafe px-3 py-1.5 text-xs font-medium text-cafe-secondary hover:text-cafe"
    >
      {children}
    </button>
  );
}

function MetaPill({ children }: { children: ReactNode }) {
  return (
    <span className="rounded-full bg-cafe-bg px-2 py-0.5 text-micro font-medium uppercase tracking-wide text-cafe-muted">
      {children}
    </span>
  );
}
