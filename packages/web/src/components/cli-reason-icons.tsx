/**
 * F212 Phase B (KD-4): Inline SVG icon set for CLI error reasonCodes.
 *
 * KD-4 mandate: no emoji in any UI surface — these are hand-traced Lucide icons
 * (https://lucide.dev) drawn as React components so they ship without an external
 * icon library and respect the project's "self-drawn SVG" rule. Each icon shares
 * the same 24x24 viewBox, stroke="currentColor", strokeWidth=2 contract — colour
 * is driven by parent `style.color` (see CliDiagnosticsPanel palette).
 *
 * One icon per CliErrorReasonCode; `UnknownReasonIcon` handles the fallback path
 * (reasonCode undefined — unclassified stderr).
 */

import type React from 'react';

type SvgProps = { className?: string; style?: React.CSSProperties; ariaLabel?: string };

function baseSvg(children: React.ReactNode, { className, style, ariaLabel }: SvgProps) {
  return (
    <svg
      className={className}
      style={style}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      role={ariaLabel ? 'img' : 'presentation'}
      aria-label={ariaLabel}
      aria-hidden={ariaLabel ? undefined : true}
    >
      {children}
    </svg>
  );
}

/** key-round — auth_failed (Lucide source) */
export function KeyRoundIcon(props: SvgProps) {
  return baseSvg(
    <>
      <path d="M2 18v3c0 .6.4 1 1 1h4v-3h3v-3h2l1.4-1.4a6.5 6.5 0 1 0-4-4Z" />
      <circle cx="16.5" cy="7.5" r=".5" fill="currentColor" />
    </>,
    props,
  );
}

/** settings-2 with offset x — invalid_config */
export function SettingsXIcon(props: SvgProps) {
  return baseSvg(
    <>
      <path d="M20 7h-9" />
      <path d="M14 17H5" />
      <circle cx="17" cy="17" r="3" />
      <circle cx="7" cy="7" r="3" />
    </>,
    props,
  );
}

/** package-x — model_not_found (box with diagonal mark via inner line) */
export function PackageXIcon(props: SvgProps) {
  return baseSvg(
    <>
      <path d="M16.5 9.4 7.55 4.24" />
      <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
      <path d="m3.3 7 8.7 5 8.7-5" />
      <path d="M12 22V12" />
    </>,
    props,
  );
}

/** gauge — quota_exceeded (Lucide gauge) */
export function GaugeIcon(props: SvgProps) {
  return baseSvg(
    <>
      <path d="m12 14 4-4" />
      <path d="M3.34 19a10 10 0 1 1 17.32 0" />
    </>,
    props,
  );
}

/** hourglass — server_overloaded (Lucide hourglass; transient throttle, retry later) */
export function HourglassIcon(props: SvgProps) {
  return baseSvg(
    <>
      <path d="M5 22h14" />
      <path d="M5 2h14" />
      <path d="M17 22v-4.172a2 2 0 0 0-.586-1.414L12 12l-4.414 4.414A2 2 0 0 0 7 17.828V22" />
      <path d="M7 2v4.172a2 2 0 0 0 .586 1.414L12 12l4.414-4.414A2 2 0 0 0 17 6.172V2" />
    </>,
    props,
  );
}

/** cloud-off — network_error (Lucide cloud-off) */
export function CloudOffIcon(props: SvgProps) {
  return baseSvg(
    <>
      <path d="m2 2 20 20" />
      <path d="M5.782 5.782A7 7 0 0 0 9 19h8.5a4.5 4.5 0 0 0 1.307-.193" />
      <path d="M21.532 16.5A4.5 4.5 0 0 0 17.5 10h-1.79A7.008 7.008 0 0 0 10 5.07" />
    </>,
    props,
  );
}

/** terminal — spawn_failed (Lucide terminal) */
export function TerminalIcon(props: SvgProps) {
  return baseSvg(
    <>
      <path d="m7 11 2-2-2-2" />
      <path d="M11 13h4" />
      <rect width="18" height="18" x="3" y="3" rx="2" />
    </>,
    props,
  );
}

/** file-x — missing_rollout (Lucide file-x) */
export function FileXIcon(props: SvgProps) {
  return baseSvg(
    <>
      <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" />
      <path d="M14 2v4a2 2 0 0 0 2 2h4" />
      <path d="m14.5 12.5-5 5" />
      <path d="m9.5 12.5 5 5" />
    </>,
    props,
  );
}

/** text-quote — context_window_exceeded (Lucide text-quote) */
export function TextQuoteIcon(props: SvgProps) {
  return baseSvg(
    <>
      <path d="M17 6H3" />
      <path d="M21 12H8" />
      <path d="M21 18H8" />
      <path d="M3 12v6" />
    </>,
    props,
  );
}

/** brain — invalid_thinking_signature (Lucide brain) */
export function BrainIcon(props: SvgProps) {
  return baseSvg(
    <>
      <path d="M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z" />
      <path d="M12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18Z" />
      <path d="M15 13a4.5 4.5 0 0 1-3-4 4.5 4.5 0 0 1-3 4" />
    </>,
    props,
  );
}

/** wrench — tool_call_parse_failed (Lucide wrench; model emitted an unparseable tool call) */
export function WrenchIcon(props: SvgProps) {
  return baseSvg(
    <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />,
    props,
  );
}

/** circle-help — fallback for unknown reasonCode (Lucide circle-help) */
export function UnknownReasonIcon(props: SvgProps) {
  return baseSvg(
    <>
      <circle cx="12" cy="12" r="10" />
      <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" />
      <path d="M12 17h.01" />
    </>,
    props,
  );
}

/** chevron-down — collapse/expand toggle (shared with TimeoutDiagnosticsPanel pattern) */
export function ChevronDownIcon(props: SvgProps) {
  return baseSvg(<path d="m6 9 6 6 6-6" />, props);
}
