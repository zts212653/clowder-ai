'use client';

/* eslint-disable cafe/no-hardcoded-colors -- OKLCH Tuner is the design-token EDITOR itself: the swatches render the live
 * oklch() the saved and the drawn name roles resolve to (the documented AC-E11 exception, as OklchTuner.tsx). */

import type { NamePlateResult } from '@/lib/readable-name-plate';
import { NAME_ROLE_MIN_CONTRAST } from '@/lib/readable-name-role';

/**
 * F322 B follow-up (Opus 5.5 3619): what the Tuner tells the user about the cat-name role next to the slider.
 *   reads       nothing: the name is drawn as saved on a plate that is where it was saved.
 *   adjusted    "显示时已调到可读", side by side "你存的 / 实际显示的" for the name and the plate: the saved values are untouched,
 *               only the drawn lightness moved (the name to the nearest value that reads, the plate toward the work surface).
 *   unreadable  nothing in this theme reads: the best case is drawn and it says so, with the number it reached. Never counted
 *               as a pass, so the figure shown is rounded down: 4.499 is not shown as 4.50.
 */
export type NameRoleHintState = 'reads' | 'adjusted' | 'unreadable';

export function nameRoleHintState(drawn: NamePlateResult): NameRoleHintState {
  if (!drawn.reachable) return 'unreadable';
  return drawn.adjusted || drawn.plateShifted ? 'adjusted' : 'reads';
}

const fixed = (x: number, digits: number) => x.toFixed(digits);
/** Rounded DOWN, so a ratio under the criterion is never shown as meeting it. */
const ratioText = (x: number) => (Math.floor(x * 100) / 100).toFixed(2);

export interface NameRoleHintProps {
  /** What the user saved (the sliders). */
  saved: { nameL: number; plateL: number; c: number; h: number };
  /** What is drawn, resolved against the colours that exist. */
  drawn: NamePlateResult;
}

export function NameRoleHint({ saved, drawn }: NameRoleHintProps) {
  const state = nameRoleHintState(drawn);
  if (state === 'reads') return null;
  const swatch = (l: number) => `oklch(${l} ${saved.c} ${saved.h})`;
  return (
    <div
      data-testid="tuner-name-hint"
      data-state={state}
      role="status"
      className="mt-1 space-y-0.5 rounded border border-[var(--console-border-soft)] px-2 py-1 text-[10px] leading-snug"
    >
      {state === 'unreadable' ? (
        <>
          <div data-testid="tuner-name-hint-title" className="font-bold text-[var(--conn-amber-text)]">
            这组颜色下名字读不清（最高 {ratioText(drawn.worst)}:1）
          </div>
          <div className="text-cafe-muted">
            没有达到 {NAME_ROLE_MIN_CONTRAST}:1。显示的是能做到的最好值，已存的值没有改。
          </div>
        </>
      ) : (
        <div data-testid="tuner-name-hint-title" className="font-bold text-cafe">
          显示时已调到可读
        </div>
      )}
      {/* Whatever moved is shown in both states: the saved value and what is drawn, side by side. */}
      {drawn.adjusted ? (
        <div className="flex items-center gap-1.5 text-cafe-muted" data-testid="tuner-name-hint-name">
          <span>名字</span>
          <span>你存的 L {fixed(saved.nameL, 3)}</span>
          <span
            className="inline-block h-3 w-3 rounded-sm border border-[var(--console-border-soft)]"
            style={{ background: swatch(saved.nameL) }}
          />
          <span>→ 实际显示 L {fixed(drawn.l, 3)}</span>
          <span
            className="inline-block h-3 w-3 rounded-sm border border-[var(--console-border-soft)]"
            style={{ background: swatch(drawn.l) }}
          />
        </div>
      ) : null}
      {drawn.plateShifted ? (
        <div className="text-cafe-muted" data-testid="tuner-name-hint-plate">
          牌子 你存的 L {fixed(saved.plateL, 3)} → 实际显示 L {fixed(drawn.plateL, 3)}
        </div>
      ) : null}
      {state === 'adjusted' ? <div className="text-cafe-muted">已存的值没有改，只是显示时挪了。</div> : null}
    </div>
  );
}
