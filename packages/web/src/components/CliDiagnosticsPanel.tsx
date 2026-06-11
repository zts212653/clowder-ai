'use client';

import type { CliDiagnostics, CliErrorReasonCode } from '@cat-cafe/shared';
import { useState } from 'react';
import {
  BrainIcon,
  ChevronDownIcon,
  CloudOffIcon,
  FileXIcon,
  GaugeIcon,
  HourglassIcon,
  KeyRoundIcon,
  PackageXIcon,
  SettingsXIcon,
  TerminalIcon,
  TextQuoteIcon,
  UnknownReasonIcon,
  WrenchIcon,
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

// Severity palette via CSS tokens (console-tokens.css --cli-sev-*).
// KD-5: author 自决 severity grouping; tokens derive from semantic / neutral / chart primitives.
const PALETTE_USER_FIX: Omit<Palette, 'Icon'> = {
  bg: 'var(--cli-sev-error-bg)',
  border: 'var(--cli-sev-error-border)',
  accent: 'var(--cli-sev-error-accent)',
  text: 'var(--cli-sev-text)',
};
const PALETTE_TRANSIENT: Omit<Palette, 'Icon'> = {
  bg: 'var(--cli-sev-warning-bg)',
  border: 'var(--cli-sev-warning-border)',
  accent: 'var(--cli-sev-warning-accent)',
  text: 'var(--cli-sev-text)',
};
const PALETTE_SYSTEM: Omit<Palette, 'Icon'> = {
  bg: 'var(--cli-sev-info-bg)',
  border: 'var(--cli-sev-info-border)',
  accent: 'var(--cli-sev-info-accent)',
  text: 'var(--cli-sev-text)',
};
const PALETTE_COGNITIVE: Omit<Palette, 'Icon'> = {
  bg: 'var(--cli-sev-cognitive-bg)',
  border: 'var(--cli-sev-cognitive-border)',
  accent: 'var(--cli-sev-cognitive-accent)',
  text: 'var(--cli-sev-text)',
};

const REASON_PALETTE: Record<CliErrorReasonCode, Palette> = {
  // Tier 1 — user must fix configuration / credential
  auth_failed: { ...PALETTE_USER_FIX, Icon: KeyRoundIcon },
  invalid_config: { ...PALETTE_USER_FIX, Icon: SettingsXIcon },
  model_not_found: { ...PALETTE_USER_FIX, Icon: PackageXIcon },
  // Tier 2 — transient, retry later
  quota_exceeded: { ...PALETTE_TRANSIENT, Icon: GaugeIcon },
  network_error: { ...PALETTE_TRANSIENT, Icon: CloudOffIcon },
  // F212 Phase E (cloud codex P1 fix per @co-creator organic 2026-05-29): Anthropic server-side
  // temporary throttling — NOT user quota. Same transient tier (retry 30-60s) but distinct
  // hourglass icon to differentiate from gauge (quota) at-a-glance.
  server_overloaded: { ...PALETTE_TRANSIENT, Icon: HourglassIcon },
  // Tier 3 — system / environment
  spawn_failed: { ...PALETTE_SYSTEM, Icon: TerminalIcon },
  missing_rollout: { ...PALETTE_SYSTEM, Icon: FileXIcon },
  // Tier 4 — cognitive / context limit
  context_window_exceeded: { ...PALETTE_COGNITIVE, Icon: TextQuoteIcon },
  invalid_thinking_signature: { ...PALETTE_COGNITIVE, Icon: BrainIcon },
  // F212 Phase D: model emitted an unparseable tool call (opus-4.8 decoder drift) — CC/model-side,
  // not a Clowder AI config issue. Cognitive tier (violet), same family as thinking-signature.
  tool_call_parse_failed: { ...PALETTE_COGNITIVE, Icon: WrenchIcon },
  // F212 Phase G (clowder-ai#875): CLI exited cleanly but no text event was produced
  // (e.g. OpenCode + DeepSeek step_start-only stream). NOT a hard error — surface
  // structured evidence (event count/types/model/session prefix) so the user can act
  // (换猫 / 换 model / 直接跑 CLI). System tier (slate, calm) — reasonCode lives here so
  // the panel renders consistently even though the underlying CLI exit code is 0.
  silent_completion: { ...PALETTE_SYSTEM, Icon: UnknownReasonIcon },
};

const UNKNOWN_PALETTE: Palette = { ...PALETTE_SYSTEM, Icon: UnknownReasonIcon };

/**
 * F212 Phase D — Cloud codex P2 fix (2026-05-29, on a429aada3):
 * KD-1 white-list moved from reasonCode-only to excerptSource-based. The backend tags
 * safeExcerpt with the safe source channel ('classifier' = known reasonCode hit,
 * 'cc_structured' = unknown reasonCode + CC structured result error per AC-D3). Frontend
 * gates disclosure on membership — fails closed for (a) malformed/persisted payloads with
 * no excerptSource and (b) forward-compat: any future api source value the current web
 * doesn't recognize yet (e.g. a hypothetical 'pii_redacted') is treated as untrusted.
 */
const KNOWN_EXCERPT_SOURCES: ReadonlySet<string> = new Set(['classifier', 'cc_structured', 'unknown_raw']);

/**
 * 云端 codex P2 (2026-05-27): persisted/hydrated `cliDiagnostics.reasonCode` may carry
 * a stale, newer, or malformed string (older web fetches a newer-api error; rollback
 * scenarios; JSON-typed strings). Truthy-check then `REASON_PALETTE[code]` would return
 * `undefined` and the subsequent destructure crashes the chat render. Treat any
 * non-member string as unknown so we fall through to UNKNOWN_PALETTE safely.
 */
export function isKnownReason(code: unknown): code is CliErrorReasonCode {
  // 云端 codex P2-7 (2026-05-27) + R3 regression (2026-05-30, b304a27d2 → revert):
  // `Object.hasOwn` is ES2022 (Safari 15.4+, Chrome 93+). tsconfig target = ES2017,
  // so use Object.prototype.hasOwnProperty.call for broader client compat (Next.js's
  // browserslist default supports older Safari that predates ES2022). biome-ignore
  // below is mechanical defense: `biome check --write --unsafe` rewrites this back
  // to Object.hasOwn via lint/suspicious/noPrototypeBuiltins; the ignore freezes it.
  // biome-ignore lint/suspicious/noPrototypeBuiltins: ES2017 target requires hasOwnProperty.call
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
  /** F212 follow-up — when this is the head of a deduped group of identical adjacent
   *  diagnostics (same reasonCode + publicSummary within window), show a "×N" badge so the
   *  user sees that the same error fired N times. Group dedup is computed at the message
   *  list level (see `utils/cli-diagnostics-dedup`); subsequent group members hide their
   *  panel entirely via ChatMessage's hideDiagnosticsPanel prop, so this Panel only needs
   *  to render the count badge for the head. */
  dedupCount?: number;
}

export function CliDiagnosticsPanel({ errorMessage, diagnostics, dedupCount }: CliDiagnosticsPanelProps) {
  const [expanded, setExpanded] = useState(false);

  // 云端 codex P2 (2026-05-27): membership check before indexing — stale/newer/malformed
  // reasonCode strings must fall through to UNKNOWN_PALETTE rather than crash on destructure.
  const knownReason = isKnownReason(diagnostics.reasonCode) ? diagnostics.reasonCode : undefined;
  const palette = knownReason ? REASON_PALETTE[knownReason] : UNKNOWN_PALETTE;
  const { Icon, bg, border, accent, text } = palette;
  // publicSummary is always present per Phase A contract; keep errorMessage as a safety net.
  const summary = diagnostics.publicSummary || errorMessage;
  // KD-1 white-list admission (砚砚 review P1-2 / 2026-05-27 → cloud codex P2 / 2026-05-29):
  // disclosure requires (a) non-empty safeExcerpt AND (b) excerptSource in KNOWN_EXCERPT_SOURCES.
  // Migrated from reasonCode-only gate to excerptSource-based for AC-D3 path (unknown reasonCode
  // but CC emitted a structured result error that's safe to surface). Defends against:
  //   - malformed/persisted payloads with safeExcerpt but no excerptSource (砚砚)
  //   - newer api → older web: future excerptSource values are rejected by membership check (云端)
  //   - AC-D3 unknown fallback now CAN show excerpt via excerptSource='cc_structured'
  const hasExcerpt = Boolean(
    diagnostics.safeExcerpt?.trim() &&
      diagnostics.excerptSource &&
      KNOWN_EXCERPT_SOURCES.has(diagnostics.excerptSource),
  );

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
          <span className="text-sm font-semibold flex items-center gap-2 flex-wrap" style={{ color: text }}>
            <span>{summary}</span>
            {dedupCount !== undefined && dedupCount > 1 && (
              <span
                data-testid="cli-diagnostics-dedup-badge"
                role="img"
                aria-label={`Same error occurred ${dedupCount} times`}
                className="text-xs font-normal px-1.5 py-0.5 rounded"
                style={{ backgroundColor: accent, color: bg }}
              >
                ×{dedupCount}
              </span>
            )}
          </span>
          {diagnostics.publicHint && (
            <span className="text-xs" style={{ color: 'var(--cli-diag-hint)', lineHeight: 1.5 }}>
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
              style={{ color: 'var(--cli-diag-meta)', transform: expanded ? 'rotate(180deg)' : undefined }}
            />
            <span className="text-xs font-semibold" style={{ color: 'var(--cli-diag-meta)' }}>
              查看详细错误
            </span>
          </button>
          {expanded && (
            <pre
              data-testid="cli-diagnostics-excerpt"
              className="rounded-lg overflow-x-auto whitespace-pre-wrap break-words text-xs font-mono m-0"
              style={{
                backgroundColor: 'var(--cli-diag-excerpt-bg)',
                color: 'var(--cli-diag-excerpt-text)',
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
        style={{ color: 'var(--cli-diag-meta)' }}
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
