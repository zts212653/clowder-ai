'use client';

import { openInvocationTrajectory } from '@/components/workspace/trajectory/trajectory-navigation';

interface OwnerRef {
  ownerFeatureId: string;
  ownerStateRef: string;
  version?: string;
}

export interface EvolutionObservationView {
  status: 'connected' | 'insufficient';
  trajectory?: {
    ref: OwnerRef;
    invocationId: string;
    threadId: string;
  };
  connectedEyes: Array<{
    sourceKind: string;
    ownerSurfaceRef: OwnerRef;
    joinKey: string;
    namedConsumerRef: OwnerRef;
    instrumentationRef: OwnerRef;
    ownerHref: string;
  }>;
  evidenceProofRefs?: Record<string, OwnerRef>;
  trigger?: {
    registrationRef: OwnerRef;
    channels: readonly string[];
  };
  nextEvaluationAt?: string;
  gaps: Array<{
    code: string;
    message: string;
    ownerFeatureId: string;
    ownerStateRef?: string;
  }>;
}

function ObservationRef({ label, value }: { label: string; value: OwnerRef }) {
  return (
    <div className="grid gap-1 border-b border-cafe-subtle py-2 last:border-0 sm:grid-cols-[10rem_1fr]">
      <dt className="text-xs font-medium text-cafe-muted">{label}</dt>
      <dd className="break-all font-mono text-xs text-cafe-secondary">{value.ownerStateRef}</dd>
    </div>
  );
}

export function EvolutionObservationPanel({ observation }: { observation: EvolutionObservationView }) {
  return (
    <section className="rounded-xl border border-cafe-subtle bg-cafe-surface p-4" aria-label="Observe and Gather">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-sm font-semibold text-cafe">已接眼睛</h3>
        <span className="text-xs text-cafe-muted">
          {observation.status === 'connected' ? 'owner refs connected' : 'insufficient'}
        </span>
      </div>

      {observation.trajectory && (
        <button
          type="button"
          className="mt-3 w-full rounded-lg border border-cafe-subtle p-3 text-left hover:bg-cafe-hover"
          onClick={() =>
            openInvocationTrajectory({
              invocationId: observation.trajectory?.invocationId ?? '',
              threadId: observation.trajectory?.threadId ?? '',
            })
          }
        >
          <span className="block text-xs text-cafe-muted">F299 trajectory</span>
          <span className="mt-1 block break-all font-mono text-xs text-cafe-secondary">
            {observation.trajectory.ref.ownerStateRef}
          </span>
        </button>
      )}

      <div className="mt-3 space-y-2">
        {observation.connectedEyes.map((eye) => (
          <article
            key={`${eye.sourceKind}:${eye.ownerSurfaceRef.ownerStateRef}`}
            className="rounded-lg bg-cafe-hover p-3"
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-xs font-medium text-cafe">{eye.sourceKind}</span>
              {eye.ownerHref && (
                <a className="text-xs text-cafe-secondary underline" href={eye.ownerHref}>
                  owner 下钻
                </a>
              )}
            </div>
            <p className="mt-1 break-all font-mono text-xs text-cafe-muted">
              {eye.ownerSurfaceRef.ownerStateRef} · {eye.joinKey}
            </p>
            <p className="mt-1 break-all font-mono text-xs text-cafe-muted">
              consumer {eye.namedConsumerRef.ownerStateRef}
            </p>
          </article>
        ))}
      </div>

      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <div className="rounded-lg border border-cafe-subtle p-3">
          <p className="text-xs font-medium text-cafe">下次评估</p>
          <time className="mt-1 block font-mono text-xs text-cafe-muted" dateTime={observation.nextEvaluationAt}>
            {observation.nextEvaluationAt ?? 'F192 registration unavailable'}
          </time>
          {observation.trigger && (
            <p className="mt-1 text-xs text-cafe-muted">{observation.trigger.channels.join(' · ')}</p>
          )}
        </div>
        <div className="rounded-lg border border-cafe-subtle p-3">
          <p className="text-xs font-medium text-cafe">证据缺口</p>
          {observation.gaps.length === 0 ? (
            <p className="mt-1 text-xs text-cafe-muted">当前没有 observation gap。</p>
          ) : (
            <ul className="mt-1 space-y-1">
              {observation.gaps.map((item) => (
                <li key={`${item.code}:${item.ownerStateRef ?? ''}`} className="text-xs text-cafe-muted">
                  <span className="font-mono">{item.code}</span> · {item.message}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      {observation.evidenceProofRefs && (
        <dl className="mt-4">
          {Object.entries(observation.evidenceProofRefs).map(([role, ref]) => (
            <ObservationRef key={role} label={role} value={ref} />
          ))}
        </dl>
      )}
    </section>
  );
}
