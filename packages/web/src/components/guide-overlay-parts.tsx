/**
 * @deprecated This file is no longer used by GuideOverlay (v2).
 * Kept for reference only. The v2 overlay uses inline HUD in GuideOverlay.tsx.
 */
'use client';

import type { GuidePhase, OrchestrationStep } from '@/stores/guideStore';

/* ── CSS Custom Properties (injected once via globals.css) ── */
// See guide tokens in globals.css

/* ── Cat Eye Indicator ── */

const EYE_COLORS: Record<GuidePhase, string> = {
  locating: '#6f6257',
  active: '#D4853A',
  complete: '#2f9e44',
};

const EYE_ANIMATIONS: Record<GuidePhase, string> = {
  locating: 'animate-pulse',
  active: 'animate-pulse',
  complete: 'animate-guide-success',
};

export function CatEyeIndicator({ state }: { state: GuidePhase }) {
  const color = EYE_COLORS[state];
  const animation = EYE_ANIMATIONS[state];

  return (
    <div className={`flex items-center gap-1.5 ${animation}`} role="status" aria-label={`观测状态: ${state}`}>
      <svg width="20" height="14" viewBox="0 0 20 14" fill="none" aria-hidden="true">
        <ellipse cx="10" cy="7" rx="9" ry="6" stroke={color} strokeWidth="1.5" fill="none" />
        <ellipse cx="10" cy="7" rx="3" ry="4.5" fill={color}>
          {state === 'active' && <animate attributeName="rx" values="3;2.5;3" dur="1.8s" repeatCount="indefinite" />}
        </ellipse>
        <circle cx="11.5" cy="5.5" r="1" fill="white" opacity="0.7" />
      </svg>
      <span className="text-xs" style={{ color }}>
        {state === 'locating' && '定位中'}
        {state === 'active' && '观察中'}
        {state === 'complete' && '完成'}
      </span>
    </div>
  );
}

/* ── HUD Actions ── */

interface HUDActionsProps {
  onPrev: () => void;
  onNext: () => void;
  onSkip: () => void;
  onExit: () => void;
  hasPrev: boolean;
  hasNext: boolean;
  isComplete: boolean;
  canSkip: boolean;
}

export function HUDActions({ onPrev, onNext, onSkip, onExit, hasPrev, hasNext, isComplete, canSkip }: HUDActionsProps) {
  return (
    <div className="flex items-center gap-2 border-t border-[var(--guide-hud-border)] pt-3">
      <button
        type="button"
        onClick={onExit}
        className="rounded-lg px-3 py-1.5 text-xs text-[var(--guide-text-secondary)] transition hover:bg-black/5"
        aria-label="退出引导"
      >
        退出
      </button>
      <div className="flex-1" />
      {hasPrev && (
        <button
          type="button"
          onClick={onPrev}
          className="rounded-lg px-3 py-1.5 text-xs text-[var(--guide-text-secondary)] transition hover:bg-black/5"
        >
          上一步
        </button>
      )}
      {canSkip && (
        <button
          type="button"
          onClick={onSkip}
          className="rounded-lg px-3 py-1.5 text-xs text-[var(--guide-text-secondary)] transition hover:bg-black/5"
        >
          跳过
        </button>
      )}
      {isComplete ? (
        <button
          type="button"
          onClick={onExit}
          className="rounded-lg bg-[var(--guide-success)] px-4 py-1.5 text-xs font-semibold text-white transition hover:opacity-90"
        >
          完成
        </button>
      ) : (
        <button
          type="button"
          onClick={hasNext ? onNext : onSkip}
          className="rounded-lg bg-[var(--guide-cutout-ring)] px-4 py-1.5 text-xs font-semibold text-white transition hover:opacity-90"
        >
          下一步
        </button>
      )}
    </div>
  );
}

/* ── Guide HUD Panel ── */

interface GuideHUDProps {
  step: OrchestrationStep;
  stepIndex: number;
  totalSteps: number;
  observationState: GuidePhase;
  targetRect: DOMRect | null;
  onPrev: () => void;
  onNext: () => void;
  onSkip: () => void;
  onExit: () => void;
  isComplete: boolean;
  nudgeVisible: boolean;
}

export function GuideHUD({
  step,
  stepIndex,
  totalSteps,
  observationState,
  targetRect,
  onPrev,
  onNext,
  onSkip,
  onExit,
  isComplete,
  nudgeVisible,
}: GuideHUDProps) {
  // Position HUD near target, preferring below
  const style = computeHUDPosition(targetRect);

  return (
    <div
      className="fixed z-[var(--guide-z-hud)] w-[320px] animate-guide-hud-enter rounded-[var(--guide-radius)] border border-[var(--guide-hud-border)] bg-[var(--guide-hud-bg)] p-4 shadow-xl"
      style={style}
      role="dialog"
      aria-label="引导面板"
      aria-live="polite"
    >
      {/* Header */}
      <div className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-xs font-semibold text-[var(--guide-cutout-ring)]">
            {stepIndex + 1} / {totalSteps}
          </span>
          <span className="text-sm font-bold text-[var(--guide-text-primary)]">{step.id}</span>
        </div>
        <CatEyeIndicator state={observationState} />
      </div>

      {/* Tips */}
      <p className="mb-3 text-sm leading-relaxed text-[var(--guide-text-secondary)]">{step.tips}</p>

      {/* Nudge hint (P1-2: shown after 8s idle) */}
      {nudgeVisible && (
        <p className="mb-3 text-xs text-[var(--guide-cutout-ring)] animate-pulse">
          试试按照上方提示操作，或点击「跳过」继续
        </p>
      )}

      {/* Progress dots */}
      <div className="mb-3 flex gap-1">
        {Array.from({ length: totalSteps }, (_, i) => (
          <div
            key={i}
            className="h-1.5 flex-1 rounded-full transition-colors"
            style={{
              backgroundColor:
                i < stepIndex
                  ? 'var(--guide-success)'
                  : i === stepIndex
                    ? 'var(--guide-cutout-ring)'
                    : 'var(--guide-hud-border)',
            }}
          />
        ))}
      </div>

      {/* Actions */}
      <HUDActions
        onPrev={onPrev}
        onNext={onNext}
        onSkip={onSkip}
        onExit={onExit}
        hasPrev={stepIndex > 0}
        hasNext={stepIndex < totalSteps - 1}
        isComplete={isComplete}
        canSkip={false}
      />
    </div>
  );
}

/* ── Position helpers ── */

function computeHUDPosition(targetRect: DOMRect | null): React.CSSProperties {
  if (!targetRect) {
    return { top: '50%', left: '50%', transform: 'translate(-50%, -50%)' };
  }

  const hudWidth = 320;
  const hudHeight = 220;
  const gap = 16;
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  // Prefer below target
  let top = targetRect.bottom + gap;
  let left = targetRect.left + targetRect.width / 2 - hudWidth / 2;

  // If below would overflow, place above
  if (top + hudHeight > vh - gap) {
    top = targetRect.top - hudHeight - gap;
  }

  // Clamp horizontal
  left = Math.max(gap, Math.min(left, vw - hudWidth - gap));
  // Clamp vertical
  top = Math.max(gap, top);

  return { top, left };
}
