/* eslint-disable cafe/no-hardcoded-colors -- OKLCH Tuner sub-module; preview swatches
 * must render dynamic oklch() literals computed from live params. AC-E11 exception. */

/* Shared range slider for OKLCH Tuner sections */

export function Slider({
  label,
  value,
  min,
  max,
  step,
  fmt,
  onChange,
  swatch,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  fmt: string;
  onChange: (v: number) => void;
  /** Optional oklch() color string — renders a live preview swatch on the left. */
  swatch?: string;
}) {
  return (
    <div className="flex items-center gap-1 pl-4">
      {swatch != null && (
        <div
          className="w-3 h-3 rounded border border-[var(--console-border-soft)] shrink-0"
          style={{ background: swatch }}
        />
      )}
      <span className="w-5 text-[10px] text-cafe-muted shrink-0">{label}</span>
      <input
        type="range"
        aria-label={label}
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(+e.target.value)}
        className="flex-1 h-1 accent-[var(--color-cafe-accent)]"
      />
      <span className="w-10 text-right text-[10px] tabular-nums shrink-0">{fmt}</span>
    </div>
  );
}
