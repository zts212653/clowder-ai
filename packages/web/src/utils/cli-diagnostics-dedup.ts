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
 * Strategy: walk chronologically, group adjacent cliDiagnostics-bearing messages sharing the
 * same reasonCode + publicSummary fingerprint within a sliding window. First message in a
 * group keeps the full panel + badge "×N"; subsequent messages hide their panel entirely
 * (the chat bubble and signature stay; only the duplicate panel is collapsed).
 *
 * Adjacency-only dedup: any non-cliDiagnostics message between two same-fingerprint
 * diagnostics breaks the group, so cliDiagnostics that legitimately reappear after later
 * conversation are NOT hidden.
 */

import type { ChatMessage as ChatMessageType } from '../stores/chat-types';

const DEFAULT_WINDOW_MS = 30_000;

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
 * Compute per-message dedup info for cliDiagnostics-bearing messages. Returns a Map keyed
 * by messageId; messages absent from the map have no dedup info (render normally with
 * dedupCount=1, hideDiagnosticsPanel=false).
 */
export function computeCliDiagnosticsDedup(
  messages: readonly ChatMessageType[],
  windowMs: number = DEFAULT_WINDOW_MS,
): Map<string, CliDiagnosticsDedupInfo> {
  const result = new Map<string, CliDiagnosticsDedupInfo>();
  let groupAnchorId: string | null = null;
  let groupAnchorFingerprint: string | null = null;
  let groupAnchorTs = 0;
  let groupSize = 0;

  const flushGroup = () => {
    if (groupAnchorId !== null && groupSize > 1) {
      result.set(groupAnchorId, { dedupCount: groupSize, hideDiagnosticsPanel: false });
    }
  };

  for (const msg of messages) {
    const diag = msg.extra?.cliDiagnostics;
    if (!diag) {
      flushGroup();
      groupAnchorId = null;
      groupAnchorFingerprint = null;
      groupSize = 0;
      continue;
    }

    const fp = fingerprint(diag);
    const ts = msg.timestamp ?? 0;

    if (groupAnchorId !== null && groupAnchorFingerprint === fp && ts - groupAnchorTs <= windowMs) {
      groupSize++;
      result.set(msg.id, { dedupCount: 0, hideDiagnosticsPanel: true });
    } else {
      flushGroup();
      groupAnchorId = msg.id;
      groupAnchorFingerprint = fp;
      groupAnchorTs = ts;
      groupSize = 1;
    }
  }

  flushGroup();
  return result;
}
