'use client';

import type { MessageWorkDisposition } from '@cat-cafe/shared';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
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
  /** Static member delivery capability projected by /api/cats. */
  canGuideReply: boolean;
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
  return target.canGuideReply && !target.delivered && !target.unavailable;
}

function guideUnavailableReason(target: SteerTargetOption): string | null {
  if (!target.canGuideReply) return '当前成员的接入方式不支持引导回复';
  return null;
}

function defaultStrategy(target: SteerTargetOption): SteerDeliveryStrategy {
  return target.disposition !== 'next_work' && canGuide(target) ? 'guide_reply' : 'interrupt_reply';
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
  const titleId = useId();
  const guideTooltipId = useId();
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
        if (userInteractedRef.current && existing !== undefined && (existing !== 'guide_reply' || canGuide(target))) {
          next[target.id] = existing;
        } else if (resolved !== undefined) next[target.id] = resolved;
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
      <div
        ref={modalRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="mx-4 flex max-h-[min(42rem,calc(100vh-3rem))] w-full max-w-md flex-col overflow-hidden rounded-2xl bg-cafe-surface-canvas shadow-xl"
      >
        <div className="px-5 pt-4">
          <h2 id={titleId} className="text-base font-semibold text-cafe-primary">
            Steer
          </h2>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
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
                  className={`flex items-center gap-2 rounded-full px-3 py-2 text-sm transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
                    selected || focused ? 'text-cafe-primary' : 'text-cafe-secondary hover:bg-cafe-surface'
                  }`}
                >
                  <span
                    aria-hidden="true"
                    data-testid={`steer-target-indicator-${target.id}`}
                    className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-full border transition-colors ${
                      selected
                        ? 'border-[var(--color-cocreator-primary)] bg-[var(--color-cocreator-primary)]'
                        : 'border-cafe-secondary bg-transparent'
                    }`}
                  >
                    {selected ? <span className="h-1.5 w-1.5 rounded-full bg-[var(--cafe-surface-canvas)]" /> : null}
                  </span>
                  {target.avatar && (
                    <AvatarImageWithFallback src={target.avatar} alt="" className="h-5 w-5 rounded-full object-cover" />
                  )}
                  <span>{target.label}</span>
                  {target.delivered ? <span className="text-xs text-cafe-muted">已投递</span> : null}
                  {target.unavailable ? <span className="text-xs text-cafe-muted">不可用</span> : null}
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

          <fieldset
            aria-label={focusedTarget ? `${focusedTarget.label}的发送方式` : '发送方式'}
            data-testid="steer-strategy-options"
            className="mt-4 grid min-w-0 grid-cols-1 gap-1.5 border-0 p-0 sm:grid-cols-2"
          >
            <div
              className="group relative"
              tabIndex={focusedGuideUnavailableReason ? 0 : undefined}
              aria-describedby={focusedGuideUnavailableReason ? guideTooltipId : undefined}
            >
              <button
                type="button"
                data-testid="steer-guide-reply"
                disabled={!focusedTarget || !canGuide(focusedTarget)}
                aria-pressed={focusedStrategy === 'guide_reply'}
                aria-describedby={focusedGuideUnavailableReason ? guideTooltipId : undefined}
                onClick={() => chooseStrategy('guide_reply')}
                className={`flex w-full items-center justify-center gap-1.5 rounded-lg bg-cafe-surface-sunken px-2 py-2 text-sm transition-colors hover:text-cafe-primary disabled:cursor-not-allowed disabled:opacity-40 ${
                  focusedStrategy === 'guide_reply' ? 'font-medium text-cafe-primary' : 'text-cafe-secondary'
                }`}
              >
                <StrategyIndicator selected={focusedStrategy === 'guide_reply'} />
                立即发送，引导回复
              </button>
              {focusedGuideUnavailableReason ? (
                <span
                  id={guideTooltipId}
                  role="tooltip"
                  data-testid="steer-guide-unavailable-tooltip"
                  className="pointer-events-none absolute bottom-full left-1/2 z-30 mb-2 w-max max-w-64 -translate-x-1/2 rounded-md bg-[var(--cafe-text)] px-2.5 py-1.5 text-xs text-[var(--cafe-surface-canvas)] opacity-0 shadow-lg transition-opacity group-hover:opacity-100 group-focus-within:opacity-100"
                >
                  {focusedGuideUnavailableReason}
                </span>
              ) : null}
            </div>
            <button
              type="button"
              data-testid="steer-interrupt-reply"
              disabled={!focusedTarget}
              aria-pressed={focusedStrategy === 'interrupt_reply'}
              onClick={() => chooseStrategy('interrupt_reply')}
              className={`flex items-center justify-center gap-1.5 rounded-lg bg-cafe-surface-sunken px-2 py-2 text-sm transition-colors hover:text-cafe-primary disabled:cursor-not-allowed disabled:opacity-40 ${
                focusedStrategy === 'interrupt_reply' ? 'font-medium text-conn-red-text' : 'text-cafe-secondary'
              }`}
            >
              <StrategyIndicator selected={focusedStrategy === 'interrupt_reply'} danger />
              立即发送，中断回复
            </button>
          </fieldset>
          {selectedActionableTargets.length > actions.length ? (
            <p className="mt-2 text-xs text-cafe-muted">请为每位已选成员选择发送方式</p>
          ) : null}
        </div>

        <div className="flex items-center justify-end gap-2 px-5 pb-4 pt-2">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-lg px-3 py-2 text-sm text-cafe-secondary transition-colors hover:bg-cafe-surface-sunken hover:text-cafe-primary"
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
            className="rounded-lg bg-[var(--color-cocreator-primary)] px-4 py-2 text-sm text-[var(--cafe-surface)] transition-colors hover:opacity-90 disabled:opacity-40"
          >
            确认发送{actions.length > 1 ? `（${actions.length}）` : ''}
          </button>
        </div>
      </div>
    </div>
  );
}

function StrategyIndicator({ selected, danger = false }: { selected: boolean; danger?: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={`flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full border ${
        selected
          ? danger
            ? 'border-conn-red-text bg-conn-red-text'
            : 'border-[var(--color-cocreator-primary)] bg-[var(--color-cocreator-primary)]'
          : 'border-cafe-secondary bg-transparent'
      }`}
    >
      {selected ? <span className="h-1.5 w-1.5 rounded-full bg-[var(--cafe-surface-canvas)]" /> : null}
    </span>
  );
}
