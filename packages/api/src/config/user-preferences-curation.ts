import type Database from 'better-sqlite3';
import { readUserPreferences, updateUserPreferences } from './user-preferences-store.js';

export interface CurationPreference {
  enabled: boolean;
  startedAt: number | null;
  curatorCatId: string;
}

export function readCurationPreference(projectRoot: string, env: NodeJS.ProcessEnv = process.env): CurationPreference {
  const stored = readUserPreferences(projectRoot).memoryCuration;
  return {
    enabled: stored?.enabled ?? env.F102_ABSTRACTIVE === 'on',
    startedAt: typeof stored?.startedAt === 'number' && stored.startedAt > 0 ? stored.startedAt : null,
    curatorCatId: stored?.curatorCatId?.trim() || env.F321_CURATOR_CAT_ID?.trim() || 'codex6-luna',
  };
}

export function saveCurationPreference(
  projectRoot: string,
  db: Database.Database,
  input: { enabled: boolean; curatorCatId?: string },
  now = Date.now(),
  env: NodeJS.ProcessEnv = process.env,
): CurationPreference {
  const previous = readCurationPreference(projectRoot, env);
  const startedAt = previous.startedAt ?? (input.enabled ? now : null);
  if (input.enabled && previous.startedAt === null) {
    // No await between the boundary and reset: subsequent append deltas remain pending.
    // Old summary text and segments remain available; historical pending work is outside v1.
    db.prepare(`UPDATE summary_state SET last_summarized_message_id=NULL, pending_message_count=0, pending_token_count=0,
      pending_signal_flags=0, carry_over=0`).run();
  }
  updateUserPreferences(projectRoot, (current) => ({
    ...current,
    memoryCuration: {
      enabled: input.enabled,
      ...(startedAt !== null ? { startedAt } : {}),
      ...(input.curatorCatId || current.memoryCuration?.curatorCatId
        ? { curatorCatId: input.curatorCatId ?? current.memoryCuration?.curatorCatId }
        : {}),
    },
  }));
  return readCurationPreference(projectRoot, env);
}
