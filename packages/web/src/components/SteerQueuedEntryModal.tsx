'use client';

import type { MessageWorkDisposition } from '@cat-cafe/shared';
import { useEffect, useMemo, useRef, useState } from 'react';
import { AvatarImageWithFallback } from './AvatarImageWithFallback';

export type SteerDeliveryStrategy = 'guide_reply' | 'interrupt_reply';

export interface SteerTargetAction {
  targetId: string;
  strategy: SteerDeliveryStrategy;
  membershipAtOpen: 'member' | 'admit';
}

export interface SteerSubmission {
  sourceRecordId?: string;
  observedPendingTargetIds: string[];
  actions: SteerTargetAction[];
}

export interface SteerTargetOption {
  id: string;
  label: string;
  avatar?: string;
  /** Static concrete-client capability; runtime presence is checked separately. */
  canGuideReply: boolean;
  /** Exact current-reply projection. Guide requires both this and canGuideReply. */
  hasCurrentReply?: boolean;
  /** Pending routed/fallback targets begin selected; delivered targets never do. */
  defaultSelected?: boolean;
  /** This target was in Queue custody when the modal loaded. */
  pending?: boolean;
  /** History dispatch truth: visible for context, but no longer actionable. */
  delivered?: boolean;
  /** Current roster truth: visible for context, but cannot be selected. */
  unavailable?: boolean;
  disposition?: MessageWorkDisposition;
  /** Optimistic membership fence: existing members cannot be silently re-added after removal. */
  membershipAtOpen?: 'member' | 'admit';
}

function canGuide(target: SteerTargetOption): boolean {
  return target.canGuideReply && target.hasCurrentReply === true && !target.delivered && !target.unavailable;
}

function guideUnavailableReason(target: SteerTargetOption): string | null {
  if (!target.canGuideReply) return '当前成员不支持追加消息引导回复';
  if (target.hasCurrentReply === false) return '当前成员没有可引导的回复';
  return null;
}

function defaultStrategy(target: SteerTargetOption): SteerDeliveryStrategy {
  return canGuide(target) ? 'guide_reply' : 'interrupt_reply';
}

function resolveDefaultTargetIds(
  actionableTargets: readonly SteerTargetOption[],
  initialTargetIds: readonly string[] | undefined,
): string[] {
  const requested = initialTargetIds?.length
    ? initialTargetIds
    : actionableTargets.filter((target) => target.defaultSelected).map((target) => target.id);
  const actionableIds = new Set(actionableTargets.map((target) => target.id));
  return [...new Set(requested.filter((targetId) => actionableIds.has(targetId)))];
}

export function SteerQueuedEntryModal({
  sourceRecordId,
  targets = [],
  initialTargetIds,
  contextState = 'ready',
  onCancel,
  onConfirm,
}: {
  sourceRecordId?: string;
  targets?: readonly SteerTargetOption[];
  initialTargetIds?: readonly string[];
  contextState?: 'loading' | 'ready' | 'unavailable';
  onCancel: () => void;
  onConfirm: (submission: SteerSubmission) => void;
}) {
  const modalRef = useRef<HTMLDivElement>(null);
  const userInteractedRef = useRef(false);
  const actionableTargets = useMemo(
    () => targets.filter((target) => !target.delivered && !target.unavailable),
    [targets],
  );
  const defaultTargetIds = useMemo(
    () => resolveDefaultTargetIds(actionableTargets, initialTargetIds),
    [actionableTargets, initialTargetIds],
  );
  const [selectedTargetIds, setSelectedTargetIds] = useState<Set<string>>(() => new Set(defaultTargetIds));
  const [focusedTargetId, setFocusedTargetId] = useState<string | undefined>(
    () => defaultTargetIds[0] ?? actionableTargets[0]?.id,
  );
  const [strategyByTargetId, setStrategyByTargetId] = useState<Partial<Record<string, SteerDeliveryStrategy>>>(() =>
    Object.fromEntries(
      targets.flatMap((target) => {
        const strategy = defaultStrategy(target);
        return strategy ? [[target.id, strategy] as const] : [];
      }),
    ),
  );
  const soleSelectedTargetId = selectedTargetIds.size === 1 ? selectedTargetIds.values().next().value : undefined;
  const effectiveFocusedTargetId = soleSelectedTargetId ?? focusedTargetId;
  const focusedTarget = targets.find(
    (target) => target.id === effectiveFocusedTargetId && !target.delivered && !target.unavailable,
  );
  const focusedStrategy = focusedTarget ? strategyByTargetId[focusedTarget.id] : undefined;
  const focusedGuideUnavailableReason = focusedTarget ? guideUnavailableReason(focusedTarget) : null;

  useEffect(() => {
    setStrategyByTargetId((current) => {
      const next: Partial<Record<string, SteerDeliveryStrategy>> = {};
      for (const target of targets) {
        const resolved = defaultStrategy(target);
        const existing = current[target.id];
        // Never upgrade an explicitly chosen non-interrupting action into a
        // destructive interrupt when live reply truth changes underneath the
        // open modal. Clear the stale guide choice and require a new click.
        if (userInteractedRef.current && existing === 'guide_reply' && !canGuide(target)) continue;
        if (userInteractedRef.current && existing !== undefined) next[target.id] = existing;
        else if (resolved !== undefined) next[target.id] = resolved;
      }
      const currentKeys = Object.keys(current);
      const nextKeys = Object.keys(next);
      const unchanged =
        currentKeys.length === nextKeys.length && nextKeys.every((targetId) => current[targetId] === next[targetId]);
      return unchanged ? current : next;
    });
    setSelectedTargetIds((current) => {
      const next = userInteractedRef.current
        ? new Set([...current].filter((targetId) => actionableTargets.some((target) => target.id === targetId)))
        : new Set(defaultTargetIds);
      if (next.size === current.size && [...next].every((targetId) => current.has(targetId))) return current;
      return next;
    });
    setFocusedTargetId((current) => {
      if (!userInteractedRef.current) return defaultTargetIds[0] ?? actionableTargets[0]?.id;
      if (current && actionableTargets.some((target) => target.id === current)) return current;
      return actionableTargets.find((target) => target.defaultSelected)?.id ?? actionableTargets[0]?.id;
    });
  }, [actionableTargets, defaultTargetIds, targets]);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onCancel();
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [onCancel]);

  const toggleTarget = (target: SteerTargetOption) => {
    if (target.delivered || target.unavailable) return;
    userInteractedRef.current = true;
    if (selectedTargetIds.has(target.id) && effectiveFocusedTargetId !== target.id) {
      setFocusedTargetId(target.id);
      return;
    }
    setFocusedTargetId(target.id);
    setSelectedTargetIds((current) => {
      const next = new Set(current);
      if (next.has(target.id)) next.delete(target.id);
      else next.add(target.id);
      return next;
    });
  };

  const chooseStrategy = (strategy: SteerDeliveryStrategy) => {
    if (!focusedTarget || (strategy === 'guide_reply' && !canGuide(focusedTarget))) return;
    userInteractedRef.current = true;
    setSelectedTargetIds((current) => new Set(current).add(focusedTarget.id));
    setStrategyByTargetId((current) => ({ ...current, [focusedTarget.id]: strategy }));
  };

  const selectedActionableTargets = targets.filter(
    (target) => !target.delivered && !target.unavailable && selectedTargetIds.has(target.id),
  );
  const actions = selectedActionableTargets.flatMap((target): SteerTargetAction[] => {
    const requested = strategyByTargetId[target.id];
    if (!requested) return [];
    return [
      {
        targetId: target.id,
        strategy: requested,
        membershipAtOpen: target.membershipAtOpen ?? 'member',
      },
    ];
  });

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: modal backdrop click-to-close, keyboard Escape handled via useEffect
    <div
      role="presentation"
      className="fixed inset-0 bg-[var(--console-overlay-backdrop)] backdrop-blur-sm flex items-center justify-center z-50"
      onClick={(event) => {
        if (modalRef.current && !modalRef.current.contains(event.target as Node)) onCancel();
      }}
    >
      <div ref={modalRef} className="bg-cafe-surface rounded-2xl shadow-2xl w-full max-w-[560px] mx-4 overflow-hidden">
        <div className="px-6 pt-6 pb-4">
          <h2 className="text-lg font-semibold text-cafe-black">Steer</h2>
          <p className="mt-1 text-xs text-cafe-muted">选择成员，再为每位成员选择发送方式</p>
        </div>

        <div className="px-6 pb-4">
          <div className="flex flex-wrap gap-2">
            {targets.map((target) => {
              const selected = selectedTargetIds.has(target.id);
              const focused = target.id === effectiveFocusedTargetId;
              return (
                <button
                  key={target.id}
                  type="button"
                  aria-pressed={selected}
                  disabled={target.delivered || target.unavailable}
                  data-testid={`steer-target-${target.id}`}
                  onClick={() => toggleTarget(target)}
                  className={`flex items-center gap-2 rounded-full border px-3 py-2 text-sm transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
                    selected
                      ? 'border-[var(--color-cocreator-primary)] bg-[var(--color-cocreator-surface)] text-cafe-black'
                      : focused
                        ? 'border-cafe-secondary text-cafe-black'
                        : 'border-[var(--console-border-soft)] text-cafe-secondary hover:bg-cafe-surface-sunken'
                  }`}
                >
                  {target.avatar && (
                    <AvatarImageWithFallback src={target.avatar} alt="" className="h-5 w-5 rounded-full object-cover" />
                  )}
                  <span>{target.label}</span>
                  {target.delivered ? <span className="text-xs text-cafe-muted">已投递</span> : null}
                  {target.unavailable ? <span className="text-xs text-cafe-muted">不可用</span> : null}
                  {selected ? <span aria-hidden="true">✓</span> : null}
                </button>
              );
            })}
            {contextState === 'loading' ? (
              <span className="text-sm text-cafe-muted">正在读取最新成员与处理状态…</span>
            ) : contextState === 'unavailable' ? (
              <span className="text-sm text-cafe-muted">暂时无法读取最新处理状态，请关闭后重试</span>
            ) : targets.length === 0 ? (
              <span className="text-sm text-cafe-muted">当前对话暂无可选成员</span>
            ) : null}
          </div>
        </div>

        <div className="mx-6 mb-5 rounded-xl border border-[var(--console-border-soft)] p-3">
          <p className="mb-2 text-xs text-cafe-muted">
            {focusedTarget ? `发送给 ${focusedTarget.label}` : '请先选择一位成员'}
          </p>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <button
              type="button"
              data-testid="steer-guide-reply"
              disabled={!focusedTarget || !canGuide(focusedTarget)}
              aria-pressed={focusedStrategy === 'guide_reply'}
              onClick={() => chooseStrategy('guide_reply')}
              className={`rounded-xl border px-3 py-2 text-sm transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
                focusedStrategy === 'guide_reply'
                  ? 'border-[var(--color-cocreator-primary)] bg-[var(--color-cocreator-surface)] text-cafe-black'
                  : 'border-[var(--console-border-soft)] text-cafe-secondary hover:bg-cafe-surface-sunken'
              }`}
            >
              立即发送，引导回复
            </button>
            <button
              type="button"
              data-testid="steer-interrupt-reply"
              disabled={!focusedTarget}
              aria-pressed={focusedStrategy === 'interrupt_reply'}
              onClick={() => chooseStrategy('interrupt_reply')}
              className={`rounded-xl border px-3 py-2 text-sm transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
                focusedStrategy === 'interrupt_reply'
                  ? 'border-conn-red-text bg-conn-red-bg text-conn-red-text'
                  : 'border-[var(--console-border-soft)] text-cafe-secondary hover:bg-cafe-surface-sunken'
              }`}
            >
              立即发送，中断回复
            </button>
          </div>
          {focusedGuideUnavailableReason ? (
            <p className="mt-2 text-xs text-cafe-muted">{focusedGuideUnavailableReason}</p>
          ) : selectedActionableTargets.length > actions.length ? (
            <p className="mt-2 text-xs text-cafe-muted">请为每位已选成员选择发送方式</p>
          ) : null}
        </div>

        <div className="px-6 pb-6 flex items-center justify-between gap-3">
          <button
            type="button"
            onClick={onCancel}
            className="text-sm text-cafe-secondary hover:text-cafe-secondary transition-colors"
          >
            取消
          </button>
          <button
            type="button"
            data-testid="steer-confirm"
            disabled={actions.length === 0 || actions.length !== selectedActionableTargets.length}
            onClick={() =>
              onConfirm({
                ...(sourceRecordId ? { sourceRecordId } : {}),
                observedPendingTargetIds: targets.filter((target) => target.pending).map((target) => target.id),
                actions,
              })
            }
            className="text-sm px-5 py-2 rounded-full bg-[var(--color-cocreator-primary)] text-[var(--cafe-surface)] hover:opacity-90 transition-colors disabled:opacity-40"
          >
            确认发送{actions.length > 1 ? `（${actions.length}）` : ''}
          </button>
        </div>
      </div>
    </div>
  );
}
