import type { AudioStatus, ComponentHealth } from './audio-transcript-contract';

function tone(state: ComponentHealth['state'] | NonNullable<AudioStatus['inputs']>[number]['state']) {
  if (state === 'ready' || state === 'running') return 'text-conn-emerald-text';
  if (state === 'degraded' || state === 'starting') return 'text-conn-amber-text';
  if (state === 'error' || state === 'failed') return 'text-conn-red-text';
  return 'text-cafe-text-muted';
}

function HealthItem({ label, health, active }: { label: string; health?: ComponentHealth; active: boolean }) {
  if (!health) return null;
  const stateLabel = active ? health.state : `last ${health.state}`;
  const stateTone = !active && health.state === 'ready' ? 'text-cafe-text-muted' : tone(health.state);
  return (
    <span className={stateTone} title={health.reason ?? health.model}>
      {label}: {stateLabel}
    </span>
  );
}

export function AudioHealthStrip({ status }: { status: AudioStatus }) {
  const hasDetails = status.health || status.inputs?.length;
  if (!hasDetails) return null;
  return (
    <div className="border-b border-cafe-border bg-cafe-surface-secondary px-3 py-1.5 text-micro">
      <div className="flex flex-wrap gap-x-3 gap-y-1">
        <HealthItem label="ASR" health={status.health?.asr} active={status.running} />
        <HealthItem label="Speakers" health={status.health?.speaker_separation} active={status.running} />
        {status.cluster_diagnostics && (
          <span
            className={
              status.cluster_diagnostics.provisional || status.cluster_diagnostics.replacements
                ? 'text-conn-amber-text'
                : 'text-conn-emerald-text'
            }
            title={`birth ≥${status.cluster_diagnostics.birth_threshold}; assignment ≥${status.cluster_diagnostics.assignment_threshold}; ${status.cluster_diagnostics.confirmations_required} confirmations`}
          >
            Clusters: {status.cluster_diagnostics.confirmed} confirmed
            {status.cluster_diagnostics.provisional ? ` · ${status.cluster_diagnostics.provisional} learning` : ''}
            {status.cluster_diagnostics.replacements ? ` · ${status.cluster_diagnostics.replacements} recovered` : ''}
          </span>
        )}
        {status.inputs?.map((input) => {
          const inputState =
            !status.running && (input.state === 'running' || input.state === 'starting') ? 'stopped' : input.state;
          return (
            <span key={input.id} className={tone(inputState)} title={input.reason ?? undefined}>
              {input.label ?? input.id}: {inputState ?? 'unknown'}
              {input.deduplicated_chunks ? ` · ${input.deduplicated_chunks} echoes removed` : ''}
            </span>
          );
        })}
      </div>
      {status.health?.asr?.reason && status.health.asr.state !== 'ready' && (
        <p className="mt-1 text-conn-red-text">ASR: {status.health.asr.reason}</p>
      )}
      {status.health?.speaker_separation?.reason && status.health.speaker_separation.state !== 'ready' && (
        <p className="mt-1 text-conn-red-text">Speaker separation: {status.health.speaker_separation.reason}</p>
      )}
      {status.inputs
        ?.filter((input) => input.reason)
        .map((input) => (
          <p key={`${input.id}-reason`} className="mt-1 text-conn-red-text">
            {input.label ?? input.id}: {input.reason}
          </p>
        ))}
    </div>
  );
}
