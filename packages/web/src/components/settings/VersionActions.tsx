'use client';

/**
 * F257 Phase D — Version lifecycle action buttons.
 *
 * Provides operator actions for the lifeline view:
 *   - Activate: switch to a specific version
 *   - Enable/Disable: toggle hook override state
 *   - Rollback: revert to manifest baseline (v1)
 *
 * Uses window.prompt for audit reason (avoids modal-in-modal).
 * API calls via apiFetch; parent refreshes data on success.
 */

import type { SegmentEnablementMatrix } from '@cat-cafe/shared';
import { useState } from 'react';
import { apiFetch } from '@/utils/api-client';
import { SettingsText } from './primitives';

export interface VersionActionsProps {
  hookId: string;
  onRefresh: () => void;
  /** F257 Console 判据⑥: enablement matrix controlling CTA states and blocked reasons. */
  enablementMatrix: SegmentEnablementMatrix;
}

interface ActionButtonProps {
  label: string;
  tone: 'emerald' | 'red' | 'amber' | 'slate';
  hookId: string;
  /** Returns null when the user cancels the reason prompt — no HTTP mutation. */
  action: () => Promise<Response | null>;
  confirmMsg?: string;
  onRefresh: () => void;
  /** Whether the action is permitted by the enablement matrix. */
  allowed: boolean;
  /** Human-readable blocked reason when allowed is false. */
  blockedReason?: string | null;
}

function ActionButton({ label, tone, action, confirmMsg, onRefresh, allowed, blockedReason }: ActionButtonProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toneClasses: Record<string, string> = {
    emerald: 'bg-emerald-600 hover:bg-emerald-700 text-white',
    red: 'bg-red-600 hover:bg-red-700 text-white',
    amber: 'bg-amber-600 hover:bg-amber-700 text-white',
    slate: 'bg-slate-600 hover:bg-slate-700 text-white',
  };

  const handleClick = async () => {
    if (confirmMsg && !window.confirm(confirmMsg)) return;
    setBusy(true);
    setError(null);
    try {
      const res = await action();
      if (!res) return; // User cancelled reason prompt — no mutation
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError((body as { error?: string }).error ?? `操作失败 (${res.status})`);
        return;
      }
      onRefresh();
    } catch {
      setError('网络错误');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <button
        type="button"
        className={`rounded-lg px-3 py-1.5 text-xs font-medium transition-colors disabled:opacity-50 ${toneClasses[tone]}`}
        disabled={busy || !allowed}
        onClick={handleClick}
        title={blockedReason ?? undefined}
      >
        {busy ? '处理中...' : label}
      </button>
      {!allowed && blockedReason && (
        <SettingsText as="p" variant="xs" tone="muted" className="mt-1 max-w-[200px]">
          {blockedReason}
        </SettingsText>
      )}
      {error && (
        <SettingsText as="p" variant="xs" tone="red" className="mt-1">
          {error}
        </SettingsText>
      )}
    </div>
  );
}

/** Action: activate a specific version. */
export function ActivateVersionButton({
  hookId,
  epochVersion,
  onRefresh,
  enablementMatrix,
}: VersionActionsProps & { epochVersion: number }) {
  const runtime = enablementMatrix.runtimeOverride;
  const perm = runtime.actions.activateVersion;
  const versionAvailable = runtime.availableEpochVersions.includes(epochVersion);
  const canActivate = perm.allowed && versionAvailable;
  const blockedReason = canActivate
    ? null
    : !perm.allowed
      ? perm.reason
      : `版本 v${epochVersion} 不在可激活历史版本列表中`;
  return (
    <ActionButton
      label={`激活 v${epochVersion}`}
      tone="emerald"
      hookId={hookId}
      confirmMsg={canActivate ? `确认激活版本 v${epochVersion}？` : undefined}
      action={() => {
        const reason = window.prompt('操作原因（审计追踪）：');
        if (reason == null || reason.trim() === '') return Promise.resolve(null);
        return apiFetch(`/api/prompt-hooks/${encodeURIComponent(hookId)}/versions/activate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ epochVersion, reason }),
        });
      }}
      onRefresh={onRefresh}
      allowed={canActivate}
      blockedReason={blockedReason}
    />
  );
}

/** Action: enable or disable override. */
export function ToggleOverrideButton({
  hookId,
  currentlyEnabled,
  onRefresh,
  enablementMatrix,
}: VersionActionsProps & { currentlyEnabled: boolean }) {
  const action = currentlyEnabled ? 'disable' : 'enable';
  const perm = enablementMatrix.runtimeOverride.actions[action];
  const label = currentlyEnabled ? '禁用' : '启用';
  return (
    <ActionButton
      label={label}
      tone={currentlyEnabled ? 'red' : 'emerald'}
      hookId={hookId}
      confirmMsg={perm.allowed && currentlyEnabled ? '确认禁用此段？禁用后段内容不再注入。' : undefined}
      action={() => {
        const reason = window.prompt('操作原因（审计追踪）：');
        if (reason == null || reason.trim() === '') return Promise.resolve(null);
        return apiFetch(`/api/prompt-hooks/${encodeURIComponent(hookId)}/override`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action, reason }),
        });
      }}
      onRefresh={onRefresh}
      allowed={perm.allowed}
      blockedReason={perm.reason}
    />
  );
}

/** Action: rollback to manifest baseline (v1). */
export function RollbackButton({ hookId, onRefresh, enablementMatrix }: VersionActionsProps) {
  const perm = enablementMatrix.runtimeOverride.actions.rollback;
  return (
    <ActionButton
      label="回滚至基线"
      tone="amber"
      hookId={hookId}
      confirmMsg={perm.allowed ? '确认回滚到基线版本 (v1)？所有自定义内容将失效。' : undefined}
      action={() => {
        const reason = window.prompt('操作原因（审计追踪）：');
        if (reason == null || reason.trim() === '') return Promise.resolve(null);
        return apiFetch(`/api/prompt-hooks/${encodeURIComponent(hookId)}/override`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'rollback', reason }),
        });
      }}
      onRefresh={onRefresh}
      allowed={perm.allowed}
      blockedReason={perm.reason}
    />
  );
}
