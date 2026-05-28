'use client';

import type { CliDiagnostics, CliErrorReasonCode } from '@cat-cafe/shared';
import { useState } from 'react';
import {
  BrainIcon,
  ChevronDownIcon,
  CloudOffIcon,
  FileXIcon,
  GaugeIcon,
  KeyRoundIcon,
  PackageXIcon,
  SettingsXIcon,
  TerminalIcon,
  TextQuoteIcon,
  UnknownReasonIcon,
} from './cli-reason-icons';

/**
 * F212 Phase B — CLI error diagnostics folded panel.
 *
 * Renders structured `cliDiagnostics` payload built by Phase A:
 *  - Always-visible banner with reasonCode-driven icon + publicSummary + publicHint
 *  - Collapsible safeExcerpt (only if Phase A populated it — KD-1 white-list admission)
 *  - debugRef metadata strip (command / exit / signal / invocationId)
 *
 * Visual contract mirrors `TimeoutDiagnosticsPanel` (F118 AC-C3) — same error-banner +
 * collapsible-detail pattern, but per-reasonCode palette + icon for at-a-glance scan.
 *
 * KD-4 (icon = self-drawn SVG, no emoji), KD-5 (color palette author-self-decided —
 * 4-tier severity grouping below).
 */

type IconComponent = (props: { className?: string; style?: React.CSSProperties; ariaLabel?: string }) => JSX.Element;

interface Palette {
  /** Banner background (light-tinted) */
  bg: string;
  /** Banner border (subtle tint) */
  border: string;
  /** Icon + summary accent color */
  accent: string;
  /** Banner text color (dark, max contrast) */
  text: string;
  /** Per-reasonCode icon */
  Icon: IconComponent;
}

// Tailwind 500/100/300 hex (KD-5: author 自决, picked for at-a-glance severity scanning).
const PALETTE_USER_FIX: Omit<Palette, 'Icon'> = {
  bg: '#FEE2E2', // red-100
  border: '#FCA5A5', // red-300
  accent: '#DC2626', // red-600
  text: '#1A1918',
};
const PALETTE_TRANSIENT: Omit<Palette, 'Icon'> = {
  bg: '#FEF3C7', // amber-100
  border: '#FCD34D', // amber-300
  accent: '#D97706', // amber-600
  text: '#1A1918',
};
const PALETTE_SYSTEM: Omit<Palette, 'Icon'> = {
  bg: '#F1F5F9', // slate-100
  border: '#CBD5E1', // slate-300
  accent: '#475569', // slate-600
  text: '#1A1918',
};
const PALETTE_COGNITIVE: Omit<Palette, 'Icon'> = {
  bg: '#EDE9FE', // violet-100
  border: '#C4B5FD', // violet-300
  accent: '#7C3AED', // violet-600
  text: '#1A1918',
};

const REASON_PALETTE: Record<CliErrorReasonCode, Palette> = {
  // Tier 1 — user must fix configuration / credential
  auth_failed: { ...PALETTE_USER_FIX, Icon: KeyRoundIcon },
  invalid_config: { ...PALETTE_USER_FIX, Icon: SettingsXIcon },
  model_not_found: { ...PALETTE_USER_FIX, Icon: PackageXIcon },
  // Tier 2 — transient, retry later
  quota_exceeded: { ...PALETTE_TRANSIENT, Icon: GaugeIcon },
  network_error: { ...PALETTE_TRANSIENT, Icon: CloudOffIcon },
  // Tier 3 — system / environment
  spawn_failed: { ...PALETTE_SYSTEM, Icon: TerminalIcon },
  missing_rollout: { ...PALETTE_SYSTEM, Icon: FileXIcon },
  // Tier 4 — cognitive / context limit
  context_window_exceeded: { ...PALETTE_COGNITIVE, Icon: TextQuoteIcon },
  invalid_thinking_signature: { ...PALETTE_COGNITIVE, Icon: BrainIcon },
};

const UNKNOWN_PALETTE: Palette = { ...PALETTE_SYSTEM, Icon: UnknownReasonIcon };

/**
 * 云端 codex P2 (2026-05-27): persisted/hydrated `cliDiagnostics.reasonCode` may carry
 * a stale, newer, or malformed string (older web fetches a newer-api error; rollback
 * scenarios; JSON-typed strings). Truthy-check then `REASON_PALETTE[code]` would return
 * `undefined` and the subsequent destructure crashes the chat render. Treat any
 * non-member string as unknown so we fall through to UNKNOWN_PALETTE safely.
 */
export function isKnownReason(code: unknown): code is CliErrorReasonCode {
  // 云端 codex P2-7 (2026-05-27): `Object.hasOwn` is ES2022 (Safari 15.4+, Chrome 93+).
  // Use Object.prototype.hasOwnProperty.call for broader client compat (Next.js's
  // browserslist default supports older Safari that predates ES2022).
  return typeof code === 'string' && Object.prototype.hasOwnProperty.call(REASON_PALETTE, code);
}

function truncateMiddle(s: string, max = 32): string {
  if (s.length <= max) return s;
  const head = Math.ceil((max - 1) / 2);
  const tail = max - 1 - head;
  return `${s.slice(0, head)}…${s.slice(-tail)}`;
}

/**
 * 云端 codex P2-5 (2026-05-27): backend `resolveCliCommand()` may resolve to an
 * absolute path (e.g. `/home/user/codex` from `which` fallback), and
 * the api-side sanitizer redacts HOME/USERPROFILE only inside stderr — not the
 * structured `debugRef.command`. Mirror the same redaction on the frontend before
 * rendering so the debug strip can't leak host install paths.
 */
function sanitizePathLeaks(s: string): string {
  return s
    .replace(/\/Users\/[^/\s]+/g, '~') // macOS user
    .replace(/\/home\/[^/\s]+/g, '~') // Linux user
    .replace(/\/var\/root(?=[/\s]|$)/g, '~') // macOS root (云端 codex P2-6)
    .replace(/\/root(?=[/\s]|$)/g, '~') // Linux root home (云端 codex P2-6, container installs)
    .replace(/C:\\Users\\[^\\\s]+/g, '~'); // Windows user
}

interface CliDiagnosticsPanelProps {
  /** The bubble's display content (`Error: ...`). Falls back if publicSummary missing. */
  errorMessage: string;
  diagnostics: CliDiagnostics;
}

export function CliDiagnosticsPanel({ errorMessage, diagnostics }: CliDiagnosticsPanelProps) {
  const [expanded, setExpanded] = useState(false);

  // 云端 codex P2 (2026-05-27): membership check before indexing — stale/newer/malformed
  // reasonCode strings must fall through to UNKNOWN_PALETTE rather than crash on destructure.
  const knownReason = isKnownReason(diagnostics.reasonCode) ? diagnostics.reasonCode : undefined;
  const palette = knownReason ? REASON_PALETTE[knownReason] : UNKNOWN_PALETTE;
  const { Icon, bg, border, accent, text } = palette;
  // publicSummary is always present per Phase A contract; keep errorMessage as a safety net.
  const summary = diagnostics.publicSummary || errorMessage;
  // KD-1 white-list admission (砚砚 review P1-2 + 云端 codex P2, 2026-05-27): excerpt
  // disclosure requires (known reasonCode) AND (non-empty safeExcerpt). Defends against:
  //   - malformed/persisted payloads with safeExcerpt but no reasonCode (砚砚)
  //   - unknown reasonCode strings (e.g. newer api → older web) leaking unsanitized text (云端)
  const hasExcerpt = Boolean(knownReason && diagnostics.safeExcerpt && diagnostics.safeExcerpt.trim().length > 0);

  return (
    <div data-testid="cli-diagnostics" className="flex flex-col gap-2.5">
      {/* Error banner */}
      <div
        data-testid="cli-diagnostics-banner"
        className="flex items-start gap-2.5 rounded-xl"
        style={{ backgroundColor: bg, border: `1px solid ${border}`, padding: '10px 14px' }}
      >
        <Icon
          className="w-4 h-4 flex-shrink-0 mt-0.5"
          style={{ color: accent }}
          ariaLabel={knownReason ?? 'cli-error-unknown'}
        />
        <div className="flex flex-col gap-1 min-w-0">
          <span className="text-sm font-semibold" style={{ color: text }}>
            {summary}
          </span>
          {diagnostics.publicHint && (
            <span className="text-xs" style={{ color: '#6D6C6A', lineHeight: 1.5 }}>
              {diagnostics.publicHint}
            </span>
          )}
        </div>
      </div>

      {/* Excerpt toggle — only shown when Phase A populated safeExcerpt (reasonCode whitelisted) */}
      {hasExcerpt && (
        <>
          <button
            type="button"
            data-testid="cli-diagnostics-toggle"
            onClick={() => setExpanded(!expanded)}
            className="flex items-center gap-1.5 cursor-pointer bg-transparent border-none p-0 self-start"
          >
            <ChevronDownIcon
              className="w-3.5 h-3.5 transition-transform"
              style={{ color: '#9C9B99', transform: expanded ? 'rotate(180deg)' : undefined }}
            />
            <span className="text-xs font-semibold" style={{ color: '#9C9B99' }}>
              查看详细错误
            </span>
          </button>
          {expanded && (
            <pre
              data-testid="cli-diagnostics-excerpt"
              className="rounded-lg overflow-x-auto whitespace-pre-wrap break-words text-xs font-mono m-0"
              style={{
                backgroundColor: '#1E1D1C',
                color: '#D89575',
                padding: '12px 14px',
                lineHeight: 1.5,
              }}
            >
              {diagnostics.safeExcerpt}
            </pre>
          )}
        </>
      )}

      {/* debugRef strip — always shown (no secrets, safe to expose) */}
      <div
        data-testid="cli-diagnostics-debug-ref"
        className="flex flex-wrap gap-x-3 gap-y-1 text-xs"
        style={{ color: '#9C9B99' }}
      >
        <span>
          <span className="font-medium">command:</span>{' '}
          {truncateMiddle(sanitizePathLeaks(diagnostics.debugRef.command), 40)}
        </span>
        <span>
          <span className="font-medium">exit:</span>{' '}
          {diagnostics.debugRef.exitCode == null ? 'null' : diagnostics.debugRef.exitCode}
        </span>
        {diagnostics.debugRef.signal != null && (
          <span>
            <span className="font-medium">signal:</span> {String(diagnostics.debugRef.signal)}
          </span>
        )}
        {diagnostics.debugRef.invocationId && (
          <span>
            <span className="font-medium">invocationId:</span> {truncateMiddle(diagnostics.debugRef.invocationId, 32)}
          </span>
        )}
      </div>
    </div>
  );
}
