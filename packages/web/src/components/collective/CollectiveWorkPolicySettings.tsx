'use client';

import { CollectiveToggleSwitch } from './CollectiveToggleSwitch';
import { CollectiveWorkPolicyRules } from './CollectiveWorkPolicyRules';
import { policyControl } from './collective-work-policy-control';
import type { ParticipationView } from './use-collective-participation';
import type { CollectiveWorkPolicyState } from './use-collective-work-policy';

export function CollectiveWorkPolicySettings({
  state,
  view,
  channelId,
  enabled,
}: {
  state: CollectiveWorkPolicyState;
  view: ParticipationView;
  channelId: string;
  enabled: boolean;
}) {
  const { status, busy } = state;
  const manual = status?.policy?.decisionMode === 'manual';
  const disabled = !enabled || busy;
  const active = policyIsActive(status);
  return (
    <section aria-label="已允许的工作" className="space-y-4" data-testid="collective-work-policy-settings">
      <CollectiveWorkPolicyRules state={state} view={view} channelId={channelId} disabled={disabled} />
      <div className="flex items-center justify-between gap-3 border-t border-[var(--console-border-soft)] pt-4">
        <span>
          <strong className="block text-sm font-medium">接工作前先问我</strong>
          <span className="mt-1 block text-xs text-cafe-muted">只管没有单独设置的授权；已设为由猫自己决定的照旧</span>
        </span>
        <CollectiveToggleSwitch
          label="接工作前先问我"
          checked={manual}
          disabled={disabled || !status}
          onChange={(next) => void state.change({ kind: 'set_mode', decisionMode: next ? 'manual' : 'automatic' })}
        />
      </div>
      <PolicySyncState state={state} active={active} enabled={enabled} />
    </section>
  );
}

function policyIsActive(status: CollectiveWorkPolicyState['status']) {
  if (!status?.policy || status.localAdoption?.revision !== status.policy.revision) return false;
  if (status.localAdoption.pendingRevocations.length) return false;
  return status.localAdoption.grants.every((grant) => grant.state !== 'changed');
}

function PolicySyncState({
  state,
  active,
  enabled,
}: {
  readonly state: CollectiveWorkPolicyState;
  readonly active: boolean;
  readonly enabled: boolean;
}) {
  let phase: string | undefined;
  if (state.busy) phase = state.phase;
  else if (state.status?.policy) phase = active ? '已生效' : '正在同步到这台 Café…';
  const showSync = !state.busy && Boolean(state.status?.policy) && !active;
  return (
    <div aria-live="polite" className="text-xs leading-5 text-cafe-secondary">
      {phase && <p>{phase}</p>}
      {showSync && (
        <button type="button" className={policyControl} disabled={!enabled} onClick={() => void state.adopt()}>
          同步当前授权
        </button>
      )}
      {state.error && (
        <p role="alert">
          {state.error}{' '}
          <button type="button" className="underline" onClick={() => void state.read()}>
            重新读取
          </button>
        </p>
      )}
    </div>
  );
}
