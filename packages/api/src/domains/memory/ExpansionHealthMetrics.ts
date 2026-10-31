import { EXPANSION_HEALTH_SOURCE_REVISION, parseExpansionFunnelMeta } from '@cat-cafe/shared';
import type Database from 'better-sqlite3';

export interface ExpansionFollowupCounts {
  presentedEvents: number;
  followedEvents: number;
}

interface ExpansionFunnelRow {
  expansion_funnel_json: string;
}

/**
 * Read the durable V38 expansion outcome contract. Redis ToolEventLog output
 * is deliberately excluded: it expires after seven days and its result lists
 * describe exposure, not a typed-target consumption action.
 */
export function readExpansionFollowupCounts(db: Database.Database): ExpansionFollowupCounts {
  const rows = db
    .prepare(
      `SELECT expansion_funnel_json
         FROM recall_events
        WHERE expansion_funnel_json IS NOT NULL`,
    )
    .all() as ExpansionFunnelRow[];

  let presentedEvents = 0;
  let followedEvents = 0;

  for (const row of rows) {
    const raw = parseJsonObject(row.expansion_funnel_json);
    if (!raw) continue;
    const meta = parseExpansionFunnelMeta(raw);
    if (!meta || meta.sourceRevision !== EXPANSION_HEALTH_SOURCE_REVISION || meta.presented === 0) continue;

    const followed = asStageCount(raw.followed);
    const used = asStageCount(raw.used);
    if (followed == null || used == null || used > followed || followed > meta.presented) continue;

    presentedEvents++;
    if (followed > 0) followedEvents++;
  }

  return { presentedEvents, followedEvents };
}

function parseJsonObject(value: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function asStageCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}
