/*
 * F056 OKLCH Tuner — extra sections (semantic, queue, neutral)
 *
 * Extracted from OklchTuner to keep files under 350-line hard limit.
 * Sections: 6. Semantic status · 7. Queue accent · 8. Text/Border (neutral)
 */

/* eslint-disable cafe/no-hardcoded-colors -- OKLCH Tuner sub-module; preview swatches
 * must render dynamic oklch() literals computed from live params. AC-E11 exception. */
import {
  type Mode,
  NEUTRAL_ROWS,
  type NeutralP,
  SEMANTIC_H_FIELD,
  SEMANTIC_KEYS,
  SEMANTIC_LABELS,
  type SemanticP,
  type TunerState,
} from './oklch-tuner-engine';
import { Slider } from './oklch-tuner-slider';

/* ── Section header SVG icons (replace emoji per maintainer feedback) ── */
const IC = 'w-3 h-3 shrink-0';
function TrafficLightIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className={IC}>
      <title>语义状态色</title>
      <rect x="6" y="2" width="12" height="20" rx="3" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="12" cy="8" r="1.5" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="none" />
      <circle cx="12" cy="16" r="1.5" fill="currentColor" stroke="none" />
    </svg>
  );
}
function InboxIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className={IC}>
      <title>队列强调色</title>
      <path d="M22 12h-6l-2 3h-4l-2-3H2" strokeLinecap="round" strokeLinejoin="round" />
      <path
        d="M5.45 5.11L2 12v6a2 2 0 002 2h16a2 2 0 002-2v-6l-3.45-6.89A2 2 0 0016.76 4H7.24a2 2 0 00-1.79 1.11z"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
function TypeIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className={IC}>
      <title>文字/边框</title>
      <path d="M4 7V4h16v3M9 20h6M12 4v16" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/* ── Icons shared with OklchTuner main (extracted to keep main file < 350 lines) ── */
export function LayersIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className={IC}>
      <title>页面层次</title>
      <path d="M12 2L2 7l10 5 10-5-10-5z" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M2 17l10 5 10-5" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M2 12l10 5 10-5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
export function BubbleIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className={IC}>
      <title>气泡</title>
      <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
export function TagIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className={IC}>
      <title>标签</title>
      <path
        d="M20.59 13.41l-7.17 7.17a2 2 0 01-2.83 0L2 12V2h10l8.59 8.59a2 2 0 010 2.82z"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="7" cy="7" r="1" fill="currentColor" stroke="none" />
    </svg>
  );
}

interface Props {
  mode: Mode;
  params: TunerState;
  onSemantic: (field: keyof SemanticP, value: number) => void;
  onQueue: (field: 'H' | 'C' | 'L', value: number) => void;
  onNeutral: (field: keyof NeutralP, value: number) => void;
}

export function TunerExtraSections({ mode, params, onSemantic, onQueue, onNeutral }: Props) {
  const sp = mode === 'light' ? params.semanticLight : params.semanticDark;
  const np = mode === 'light' ? params.neutralLight : params.neutralDark;

  return (
    <>
      {/* ── 6. Semantic status colors ── */}
      <div className="space-y-1 pb-2 border-b border-[var(--console-border-soft)]">
        <div className="text-[10px] text-cafe-muted font-bold flex items-center gap-1">
          <TrafficLightIcon /> 语义状态色
        </div>
        <div className="flex gap-0.5 pl-4">
          {SEMANTIC_KEYS.map((k) => {
            const h = sp[SEMANTIC_H_FIELD[k] as keyof SemanticP] as number;
            return (
              <div key={k} className="flex-1 text-center">
                <div
                  className="h-5 rounded-sm border border-[var(--console-border-soft)] mb-0.5"
                  style={{ background: `oklch(${sp.L} ${sp.C} ${h})` }}
                />
                <div
                  className="h-3 rounded-sm border border-[var(--console-border-soft)]"
                  style={{ background: `oklch(${sp.surfL} ${sp.surfC} ${h})` }}
                />
                <span className="text-[8px] text-cafe-muted block mt-0.5">{k}</span>
              </div>
            );
          })}
        </div>
        {SEMANTIC_KEYS.map((k) => {
          const field = SEMANTIC_H_FIELD[k] as keyof SemanticP;
          return (
            <div key={k} className="flex items-center gap-1 pl-4">
              <span className="w-12 text-[9px] text-cafe-muted shrink-0 truncate">
                {SEMANTIC_LABELS[k].split(' ')[0]}
              </span>
              <span className="w-5 text-[9px] text-cafe-muted shrink-0">H</span>
              <input
                type="range"
                aria-label={`${k} hue`}
                min={0}
                max={360}
                step={1}
                value={sp[field] as number}
                onChange={(e) => onSemantic(field, +e.target.value)}
                className="flex-1 h-1 accent-[var(--color-cafe-accent)]"
              />
              <span className="w-8 text-right text-[9px] tabular-nums shrink-0">{sp[field] as number}</span>
            </div>
          );
        })}
        <Slider
          label="L"
          value={sp.L}
          min={0}
          max={1}
          step={0.01}
          fmt={sp.L.toFixed(2)}
          onChange={(v) => onSemantic('L', v)}
        />
        <Slider
          label="C"
          value={sp.C}
          min={0}
          max={0.3}
          step={0.005}
          fmt={sp.C.toFixed(3)}
          onChange={(v) => onSemantic('C', v)}
        />
      </div>

      {/* ── 7. Queue accent ── */}
      <div className="space-y-1 pb-2 border-b border-[var(--console-border-soft)]">
        <div className="text-[10px] text-cafe-muted font-bold flex items-center gap-1">
          <InboxIcon /> 队列强调色
        </div>
        <div className="flex gap-0.5 pl-4">
          {[0, -0.06, 0.34].map((dL, i) => (
            <div
              key={i}
              className="flex-1 h-4 rounded-sm border border-[var(--console-border-soft)]"
              style={{
                background: `oklch(${params.queue.L + dL} ${params.queue.C * (i === 2 ? 0.2 : 1)} ${params.queue.H})`,
              }}
            />
          ))}
        </div>
        <Slider
          label="H"
          value={params.queue.H}
          min={0}
          max={360}
          step={1}
          fmt={`${params.queue.H}`}
          onChange={(v) => onQueue('H', v)}
        />
        <Slider
          label="C"
          value={params.queue.C}
          min={0}
          max={0.3}
          step={0.005}
          fmt={params.queue.C.toFixed(3)}
          onChange={(v) => onQueue('C', v)}
        />
        <Slider
          label="L"
          value={params.queue.L}
          min={0}
          max={1}
          step={0.01}
          fmt={params.queue.L.toFixed(2)}
          onChange={(v) => onQueue('L', v)}
        />
      </div>

      {/* ── 8. Text/Border (also drives console tokens via alias) ── */}
      <div className="space-y-1">
        <div className="text-[10px] text-cafe-muted font-bold flex items-center gap-1">
          <TypeIcon /> 文字/边框 (L)
        </div>
        {NEUTRAL_ROWS.map(([f, lbl]) => (
          <div key={f} className="flex items-center gap-1.5 pl-4">
            <div
              className="w-3 h-3 rounded border border-[var(--console-border-soft)] shrink-0"
              style={{ background: `oklch(${np[f]} ${params.neutralChroma} ${params.neutralHue})` }}
            />
            <span className="w-14 text-[9px] text-cafe-muted shrink-0">{lbl}</span>
            <input
              type="range"
              aria-label={lbl}
              min={0}
              max={1}
              step={0.005}
              value={np[f]}
              onChange={(e) => onNeutral(f, +e.target.value)}
              className="flex-1 h-1 accent-[var(--color-cafe-accent)]"
            />
            <span className="w-9 text-right text-[9px] tabular-nums shrink-0">{np[f].toFixed(3)}</span>
          </div>
        ))}
      </div>
    </>
  );
}
