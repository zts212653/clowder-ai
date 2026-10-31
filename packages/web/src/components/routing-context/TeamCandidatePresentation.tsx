import type { RoutingContextSnapshotV1 } from '@cat-cafe/shared';
import type { TeamAvailabilityReading, TeamAvailabilityTone, TeamCapabilityReading } from './team-member-projection';

type Candidate = RoutingContextSnapshotV1['candidates'][number];

const TONE_CLASS: Record<TeamAvailabilityTone, string> = {
  ok: 'border-conn-green-ring bg-conn-green-bg text-conn-green-text',
  attention: 'border-conn-amber-ring bg-conn-amber-bg text-conn-amber-text',
  blocked: 'border-conn-red-ring bg-conn-red-bg text-conn-red-text',
  unknown: 'border-cafe-subtle bg-cafe-surface-sunken text-cafe-secondary',
};

/** Compact honest state chip. Carries the raw availability for downstream assertions. */
export function AvailabilityBadge({ reading }: { reading: TeamAvailabilityReading }) {
  return (
    <span
      className={`inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 text-micro font-semibold ${TONE_CLASS[reading.tone]}`}
      data-routing-availability={reading.availability}
    >
      {reading.label}
    </span>
  );
}

/**
 * Progressive disclosure for the technical basis (F293 AC-UX2). Stable ids, dossier
 * revisions, reason codes and source refs stay reachable but never lead the reading.
 */
export function TeamEvidenceFold({
  candidate,
  capability,
}: {
  candidate: Candidate;
  capability: TeamCapabilityReading;
}) {
  const revision = capability.state === 'applied' ? capability.revision : null;
  return (
    <details
      className="mt-4 border-t border-cafe-subtle pt-3 text-micro text-cafe-secondary"
      data-testid="team-detail-evidence"
    >
      <summary className="cursor-pointer font-semibold text-cafe-secondary">查看依据与技术详情</summary>
      <div className="mt-2 space-y-3 rounded-lg bg-cafe-surface-sunken p-3">
        <p>
          成员标识：<code className="break-all font-mono">{candidate.binding.catId}</code> ·{' '}
          <code className="break-all font-mono">{candidate.binding.providerId}</code>
        </p>
        {revision ? (
          <div>
            <p className="font-semibold text-cafe-black">画像版本</p>
            <p className="mt-1 break-all font-mono text-cafe-muted">
              {revision.modelId} · {revision.dossierRevision}
            </p>
            <ul className="mt-1 space-y-1">
              {revision.relevantSignals.map((signal) => (
                <li key={`${signal.kind}:${signal.summary}`} className="break-all">
                  {signal.summary}
                  <span className="ml-1 font-mono text-cafe-muted">{signal.evidenceRefs.join(' · ')}</span>
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <p>还没有已应用的画像版本，因此没有可展开的画像依据。</p>
        )}
        {candidate.reasons.length > 0 && (
          <div>
            <p className="font-semibold text-cafe-black">状态依据</p>
            {candidate.reasons.map((reason) => (
              <div key={`${reason.code}:${reason.summary}`} className="mt-1">
                <p>{reason.summary}</p>
                <p className="break-all font-mono text-cafe-muted">
                  {reason.code} · {reason.sourceRefs.join(' · ')}
                </p>
              </div>
            ))}
          </div>
        )}
      </div>
    </details>
  );
}
