/**
 * F212 follow-up — UI-layer dedup for consecutive duplicate CliDiagnostics panels.
 *
 * Trigger: organic 2026-05-30 — Repo Inbox reconciliation signal occasionally fans out to
 * multiple invocations (different invocationIds, same reasonCode within seconds), so users
 * saw two identical "API 配额超限" panels stacked. Root cause is upstream emit (likely retry
 * / fallback chain in invocation queue), but a UI-layer surgical dedup makes the symptom go
 * away regardless of which emit path multiplied and is forward-compatible against future
 * emit additions (same panel → same dedup, no matter what added new emit paths).
 *
 * Strategy: walk the rows in the order they render and group adjacent rows whose rendered CLI
 * panel shares the same reasonCode + publicSummary fingerprint within a window on the
 * presentation clock. The group head keeps
 * the full panel + badge "×N"; later rows hide that panel only (the chat bubble and signature
 * stay).
 *
 * A row joins only with the CLI panel it actually renders (`projectRowTerminalDiagnostics`, the
 * decision ChatMessage renders), never with the raw `cliDiagnostics` it carries: a row showing
 * the timeout panel, no panel (any response) or nothing at all breaks the
 * group like any other row, so a hidden panel is always one its group head visibly shows (F117).
 *
 * Adjacency-only dedup: any row between two same-fingerprint panels breaks the group, so
 * diagnostics that legitimately reappear after later conversation are NOT hidden.
 */

import { projectRowTerminalDiagnostics } from '../components/chat-row-surface';
import type { ChatMessage as ChatMessageType } from '../stores/chat-types';
import { getMessageTimelineOrderTime } from '../stores/message-timeline';

const WINDOW_MS = 30_000;

export interface CliDiagnosticsDedupInfo {
  /** Group size for the first message in the group (count includes itself + subsequent
   *  duplicates). Subsequent duplicates have dedupCount = 0 and hideDiagnosticsPanel = true. */
  readonly dedupCount: number;
  /** Whether this message should hide its CliDiagnosticsPanel because an earlier adjacent
   *  message in the same group already rendered the panel (with a "×N" badge). */
  readonly hideDiagnosticsPanel: boolean;
}

type CliDiagnostics = NonNullable<NonNullable<ChatMessageType['extra']>['cliDiagnostics']>;

function fingerprint(diag: CliDiagnostics): string {
  // reasonCode + publicSummary is sufficient — same classification + same humanized title
  // means the user sees the exact same panel content. structuredErrorText leakage is already
  // sanitized through publicSummary so we don't need to fingerprint safeExcerpt separately.
  return `${diag.reasonCode ?? 'unknown'}|${diag.publicSummary ?? ''}`;
}

/**
 * Compute per-row dedup info for the rows a surface renders, in that order. `timelineMessages`
 * is the thread timeline the rows render against (defaults to the rows themselves). Rows absent
 * from the map have no dedup info (render normally with dedupCount=1, hideDiagnosticsPanel=false).
 */
export function computeCliDiagnosticsDedup(
  rows: readonly ChatMessageType[],
  timelineMessages: readonly ChatMessageType[] = rows,
): Map<string, CliDiagnosticsDedupInfo> {
  const result = new Map<string, CliDiagnosticsDedupInfo>();
  let head: { id: string; fingerprint: string; at: number } | null = null;
  let groupSize = 0;

  const flushGroup = () => {
    if (head && groupSize > 1) result.set(head.id, { dedupCount: groupSize, hideDiagnosticsPanel: false });
  };

  for (const row of rows) {
    const panel = projectRowTerminalDiagnostics(row, timelineMessages);
    if (panel?.kind !== 'cli') {
      flushGroup();
      head = null;
      groupSize = 0;
      continue;
    }

    const fp = fingerprint(panel.diagnostics);
    const at = getMessageTimelineOrderTime(row);
    if (head && head.fingerprint === fp && Math.abs(at - head.at) <= WINDOW_MS) {
      groupSize++;
      result.set(row.id, { dedupCount: 0, hideDiagnosticsPanel: true });
    } else {
      flushGroup();
      head = { id: row.id, fingerprint: fp, at };
      groupSize = 1;
    }
  }

  flushGroup();
  return result;
}
