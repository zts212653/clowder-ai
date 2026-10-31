import { type CliToolProjectionRow, projectCliToolEventRows } from '@cat-cafe/shared';
import type { ChatMessageMetadata, ToolEvent } from '@/stores/chat-types';

/**
 * F322 B — §1.16 第 3 层: what the collapsed record line counts and what the opened record lists. Pure.
 *
 * Mirrors the CLI block's own reading of `toolEvents` (a call labelled "unknown" is shown nowhere, nor is its result) so the
 * count never disagrees with what the record lists; unlike the CLI block it keeps whether a result was an error, and it takes the
 * duration from the turn itself.
 */
export type ReplyRecordRow = CliToolProjectionRow;

export interface ReplyRecordSummary {
  toolCount: number;
  errorCount: number;
  /** The turn's own duration as the provider reported it; null when it did not (never a spread of tool timestamps). */
  durationMs: number | null;
  /**
   * F319: the upstream answered with a model other than the requested one (self-declared `servedModel`). With nothing requested there
   * is nothing to compare against, so never true then. The warning lives on the reply it describes and must outlive a closed record.
   */
  rerouted: boolean;
  rows: ReplyRecordRow[];
}

function isServedModelRerouted(metadata: ChatMessageMetadata | undefined): boolean {
  const requested = metadata?.model?.trim();
  const served = metadata?.servedModel?.trim();
  return Boolean(requested && served && requested.toLowerCase() !== served.toLowerCase());
}

export function summarizeReplyRecord(
  toolEvents: readonly ToolEvent[] | undefined,
  metadata: ChatMessageMetadata | undefined,
): ReplyRecordSummary {
  const rows = projectCliToolEventRows(toolEvents ?? []);
  const duration = metadata?.usage?.durationMs;
  return {
    toolCount: rows.length,
    errorCount: rows.filter((row) => row.failed).length,
    durationMs: typeof duration === 'number' && Number.isFinite(duration) && duration > 0 ? duration : null,
    rerouted: isServedModelRerouted(metadata),
    rows,
  };
}
