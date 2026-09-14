'use client';

/**
 * F257 Phase D — Version lifecycle action buttons.
 *
 * Provides operator actions for the lifeline view:
 *   - Activate: switch to a specific version
 *   - Enable/Disable: toggle hook override state
 *   - Rollback: revert to manifest baseline (v1)
 *
 * Destructive override actions retain the audit-reason prompt. Historical
 * version activation uses an in-product confirmation because it closes the
 * tracing cycle and starts a new one through the cycle store CAS.
 */

import type { CycleEvaluationStatus, SegmentEnablementMatrix } from '@cat-cafe/shared';
import { useState } from 'react';
import { createPortal } from 'react-dom';
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
  currentEvalStatus = 'idle',
}: VersionActionsProps & { epochVersion: number; currentEvalStatus?: CycleEvaluationStatus }) {
  const runtime = enablementMatrix.runtimeOverride;
  const perm = epochVersion === 1 ? runtime.actions.rollback : runtime.actions.activateVersion;
  const versionAvailable = epochVersion === 1 || runtime.availableEpochVersions.includes(epochVersion);
  const tracing = currentEvalStatus === 'idle';
  const canActivate = tracing && perm.allowed && versionAvailable;
  const blockedReason = canActivate
    ? null
    : !tracing
      ? '当前正在评估，完成后可切换版本'
      : !perm.allowed
        ? perm.reason
        : `版本 v${epochVersion} 不在可激活历史版本列表中`;
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const confirm = async () => {
    setBusy(true);
    setError(null);
    try {
      const response = await apiFetch(`/api/prompt-hooks/${encodeURIComponent(hookId)}/versions/activate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ epochVersion }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        setError((body as { error?: string }).error ?? `操作失败 (${response.status})`);
        return;
      }
      setConfirming(false);
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
        className="rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-emerald-700 disabled:opacity-50"
        disabled={busy || !canActivate}
        onClick={() => setConfirming(true)}
        title={blockedReason ?? undefined}
      >
        切换为当前版本
      </button>
      {!canActivate && blockedReason && (
        <SettingsText as="p" variant="xs" tone="muted" className="mt-1">
          {blockedReason}
        </SettingsText>
      )}
      {error && (
        <SettingsText as="p" variant="xs" tone="red" className="mt-1">
          {error}
        </SettingsText>
      )}
      {confirming &&
        createPortal(
          <div className="fixed inset-0 z-[130] flex items-center justify-center bg-[var(--console-overlay-backdrop)] p-4 backdrop-blur-sm">
            <button
              type="button"
              aria-label="取消切换"
              className="absolute inset-0"
              onClick={() => !busy && setConfirming(false)}
            />
            <div
              role="dialog"
              aria-modal="true"
              aria-labelledby="version-switch-title"
              className="relative w-full max-w-sm rounded-2xl bg-[var(--console-card-bg)] p-5 shadow-2xl"
            >
              <SettingsText as="h3" id="version-switch-title" variant="sm" tone="default" className="font-semibold">
                切换当前版本
              </SettingsText>
              <SettingsText as="p" variant="xs" tone="muted" className="mt-2">
                切换后，将以该版本开启新周期并继续评估。
              </SettingsText>
              <div className="mt-5 flex justify-end gap-2">
                <button
                  type="button"
                  className="rounded-lg px-3 py-1.5 text-xs text-cafe-secondary hover:bg-[var(--console-panel-bg)]"
                  disabled={busy}
                  onClick={() => setConfirming(false)}
                >
                  取消
                </button>
                <button
                  type="button"
                  className="rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
                  disabled={busy}
                  onClick={() => void confirm()}
                >
                  {busy ? '切换中…' : '确认切换'}
                </button>
              </div>
            </div>
          </div>,
          document.body,
        )}
    </div>
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
