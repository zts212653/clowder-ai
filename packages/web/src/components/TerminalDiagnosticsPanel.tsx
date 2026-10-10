'use client';

import type { CliDiagnostics } from '@cat-cafe/shared';
import type { ChatMessage, TimeoutDiagnostics } from '@/stores/chat-types';
import { CliDiagnosticsPanel, isKnownReason } from './CliDiagnosticsPanel';
import { TimeoutDiagnosticsPanel } from './TimeoutDiagnosticsPanel';

export type TerminalDiagnostics =
  | { kind: 'cli'; diagnostics: CliDiagnostics }
  | { kind: 'timeout'; diagnostics: TimeoutDiagnostics };

/**
 * F212 Phase B precedence for standalone error rows:
 *   1. a classified CLI error → CLI panel
 *   2. a timeout with no recognized classification → timeout panel
 *      (keeps F118 silence/processAlive; covers unknown-reason persisted payloads too)
 *   3. an unclassified CLI error with no timeout → CLI panel, unknown-icon variant
 * The `isKnownReason` membership check (not truthy) keeps persisted/newer/malformed
 * reasonCode strings from hijacking the timeout view.
 */
export function selectTerminalDiagnostics(
  extra: ChatMessage['extra'],
  timeoutEligible: boolean,
): TerminalDiagnostics | null {
  const cli = extra?.cliDiagnostics;
  if (cli && isKnownReason(cli.reasonCode)) return { kind: 'cli', diagnostics: cli };
  const timeout = timeoutEligible ? extra?.timeoutDiagnostics : undefined;
  if (timeout) return { kind: 'timeout', diagnostics: timeout };
  return cli ? { kind: 'cli', diagnostics: cli } : null;
}

export function TerminalDiagnosticsPanel({
  selected,
  errorMessage,
  dedupCount,
}: {
  selected: TerminalDiagnostics;
  /** Copy naming the failure; the CLI panel falls back to it when publicSummary is missing. */
  errorMessage: string;
  /** Head of an adjacent duplicate group: the CLI panel shows "×N". */
  dedupCount?: number;
}) {
  return selected.kind === 'cli' ? (
    <CliDiagnosticsPanel errorMessage={errorMessage} diagnostics={selected.diagnostics} dedupCount={dedupCount} />
  ) : (
    <TimeoutDiagnosticsPanel errorMessage={errorMessage} diagnostics={selected.diagnostics} />
  );
}
