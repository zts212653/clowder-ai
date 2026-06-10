import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import type { EventConfidence, EventTrigger } from '@cat-cafe/shared';
import Database from 'better-sqlite3';
import type { TaskOutcomeSnapshotSourceRefs } from '../publish-verdict/types.js';
import type { StoredEpisode, StoredSignal } from './task-outcome-store.js';

interface EventMemoryRow {
  eventId: string;
  type: string;
  trigger: EventTrigger;
  cat: string;
  threadId: string;
  messageId: string;
  timestamp: number;
  summary: string;
  confidence: EventConfidence;
}

export interface ResolvedTaskOutcomeWindow {
  taskOutcomeDbPath: string;
  eventMemoryDbPath: string | null;
  windowStartMs: number;
  windowEndMs: number;
  evidenceCatId?: string;
  episodes: StoredEpisode[];
  signals: StoredSignal[];
  eventRows: EventMemoryRow[];
}

interface ResolveTaskOutcomeSourceWindowOptions {
  ownerUserId?: string;
  defaultTaskOutcomeDbPath?: string;
  defaultEventMemoryDbPath?: string | null;
}

export function resolveTaskOutcomeSourceWindow(
  sourceRefs: TaskOutcomeSnapshotSourceRefs,
  liveHarnessFeedbackRoot: string,
  options: ResolveTaskOutcomeSourceWindowOptions = {},
): ResolvedTaskOutcomeWindow {
  const repoRoot = dirname(dirname(liveHarnessFeedbackRoot));
  const taskOutcomeDbPath =
    sourceRefs.databasePath !== undefined
      ? resolveRepoScopedDbPath(repoRoot, sourceRefs.databasePath, 'databasePath')
      : (options.defaultTaskOutcomeDbPath ?? resolve(repoRoot, 'task-outcome-episodes.sqlite'));
  if (!existsSync(taskOutcomeDbPath)) {
    throw new Error(`evidence_not_found: task-outcome db not found at ${taskOutcomeDbPath}`);
  }

  const taskOutcomeDb = new Database(taskOutcomeDbPath, { readonly: true, fileMustExist: true });
  const startIso = new Date(sourceRefs.windowStartMs).toISOString();
  const endIso = new Date(sourceRefs.windowEndMs).toISOString();

  const episodes = (
    taskOutcomeDb
      .prepare(
        `SELECT * FROM task_outcome_episodes
       WHERE createdAt >= ? AND createdAt < ?
       ORDER BY createdAt ASC`,
      )
      .all(startIso, endIso) as Array<Record<string, unknown>>
  ).map(rowToEpisode);

  const episodeIds = episodes.map((episode) => episode.episodeId);
  const signals =
    episodeIds.length === 0
      ? []
      : (
          taskOutcomeDb
            .prepare(
              `SELECT * FROM task_outcome_signals
             WHERE episodeId IN (${episodeIds.map(() => '?').join(', ')})
               AND createdAt >= ? AND createdAt < ?
             ORDER BY id ASC`,
            )
            .all(...episodeIds, startIso, endIso) as Array<Record<string, unknown>>
        ).map(rowToSignal);

  const eventMemoryDbPath = resolveEventMemoryDbPath(repoRoot, options.defaultEventMemoryDbPath);
  const linkedEventIds = collectLinkedEventIds(signals);
  let eventRows: EventMemoryRow[] = [];
  if (eventMemoryDbPath !== null && linkedEventIds.length > 0) {
    if (!options.ownerUserId) {
      throw new Error(
        'internal_owner_scope_missing: task-outcome event-memory reads require ownerUserId when linked event refs exist',
      );
    }
    eventRows = readLinkedEventMemoryWindow(
      eventMemoryDbPath,
      options.ownerUserId,
      linkedEventIds,
      sourceRefs.windowStartMs,
      sourceRefs.windowEndMs,
      sourceRefs.evidenceCatId,
    );
  }

  return {
    taskOutcomeDbPath,
    eventMemoryDbPath,
    windowStartMs: sourceRefs.windowStartMs,
    windowEndMs: sourceRefs.windowEndMs,
    ...(sourceRefs.evidenceCatId ? { evidenceCatId: sourceRefs.evidenceCatId } : {}),
    episodes,
    signals,
    eventRows,
  };
}

function resolveRepoScopedDbPath(repoRoot: string, value: string, fieldName: string): string {
  if (!value || value === '.' || value === '..') {
    throw new Error(`invalid_source_ref: ${fieldName} must be a non-empty repo-relative path`);
  }
  if (isAbsolute(value)) {
    throw new Error(`invalid_source_ref: ${fieldName} must be repo-relative (absolute paths are forbidden)`);
  }
  const absoluteRoot = resolve(repoRoot);
  const candidate = resolve(absoluteRoot, value);
  const rel = relative(absoluteRoot, candidate);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`invalid_source_ref: ${fieldName} escapes the repo-root allowlist`);
  }
  return candidate;
}

function resolveEventMemoryDbPath(repoRoot: string, configuredPath?: string | null): string | null {
  if (configuredPath === ':memory:') return ':memory:';
  const dbPath = configuredPath ?? join(repoRoot, 'event-memory.sqlite');
  return existsSync(dbPath) ? dbPath : null;
}

function collectLinkedEventIds(signals: StoredSignal[]): string[] {
  const ids = new Set<string>();
  for (const signal of signals) {
    const eventId = signal.record.eventId;
    if (typeof eventId === 'string' && eventId.length > 0) ids.add(eventId);
  }
  return [...ids];
}

function readLinkedEventMemoryWindow(
  dbPath: string,
  ownerUserId: string,
  linkedEventIds: string[],
  windowStartMs: number,
  windowEndMs: number,
  evidenceCatId?: string,
): EventMemoryRow[] {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  const clauses = ['ownerUserId = ?', 'timestamp >= ?', 'timestamp < ?'];
  const params: Array<number | string> = [ownerUserId, windowStartMs, windowEndMs];
  clauses.push(`eventId IN (${linkedEventIds.map(() => '?').join(', ')})`);
  params.push(...linkedEventIds);
  if (evidenceCatId) {
    clauses.push('cat = ?');
    params.push(evidenceCatId);
  }
  return (
    db
      .prepare(`SELECT * FROM event_memory WHERE ${clauses.join(' AND ')} ORDER BY timestamp ASC`)
      .all(...params) as Array<Record<string, unknown>>
  ).map((row) => ({
    eventId: row.eventId as string,
    type: row.type as string,
    trigger: row.trigger_type as EventTrigger,
    cat: row.cat as string,
    threadId: row.threadId as string,
    messageId: row.messageId as string,
    timestamp: row.timestamp as number,
    summary: row.summary as string,
    confidence: row.confidence as EventConfidence,
  }));
}

function rowToEpisode(row: Record<string, unknown>): StoredEpisode {
  return {
    episodeId: row.episodeId as string,
    trigger: row.trigger_type as string,
    threadId: row.threadId as string,
    participants: JSON.parse(row.participants as string) as string[],
    artifacts: JSON.parse(row.artifacts as string) as string[],
    terminalState: row.terminalState as string,
    verdict: (row.verdict as string | null) ?? null,
    createdAt: row.createdAt as string,
  };
}

function rowToSignal(row: Record<string, unknown>): StoredSignal {
  return {
    id: row.id as number,
    episodeId: row.episodeId as string,
    category: row.category as StoredSignal['category'],
    record: JSON.parse(row.record as string) as Record<string, unknown>,
    createdAt: row.createdAt as string,
  };
}

export function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}
