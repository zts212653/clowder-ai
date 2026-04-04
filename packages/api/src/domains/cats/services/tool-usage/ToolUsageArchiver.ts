/**
 * Tool Usage Archiver — F150 (#339)
 * Persists expiring Redis counters to a JSONL file so "all-time" queries work beyond the 90-day TTL.
 *
 * Archive format (one JSON object per line):
 *   {"date":"2026-01-15","catId":"opus","category":"native","toolName":"Read","count":42}
 */

import { existsSync, mkdirSync } from 'node:fs';
import { appendFile, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createModuleLogger } from '../../../../infrastructure/logger.js';
import type { ToolUsageEntry } from './ToolUsageCounter.js';

const log = createModuleLogger('tool-usage-archive');

export class ToolUsageArchiver {
  constructor(private readonly archivePath: string) {
    const dir = dirname(archivePath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }

  /** Append entries for a single day to the archive file. */
  async archiveEntries(entries: ToolUsageEntry[]): Promise<number> {
    if (entries.length === 0) return 0;
    const lines = entries.map((e) => JSON.stringify(e)).join('\n') + '\n';
    await appendFile(this.archivePath, lines, 'utf-8');
    log.info({ count: entries.length, date: entries[0].date }, 'Archived tool usage entries');
    return entries.length;
  }

  /** Load all archived entries. Caller handles dedup against Redis. */
  async loadArchive(): Promise<ToolUsageEntry[]> {
    if (!existsSync(this.archivePath)) return [];
    const content = await readFile(this.archivePath, 'utf-8');
    const entries: ToolUsageEntry[] = [];
    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      try {
        entries.push(JSON.parse(line) as ToolUsageEntry);
      } catch {
        log.warn({ line: line.slice(0, 80) }, 'Skipped malformed archive line');
      }
    }
    return entries;
  }

  /** Get the set of dates already archived (for dedup). */
  async getArchivedDates(): Promise<Set<string>> {
    if (!existsSync(this.archivePath)) return new Set();
    const content = await readFile(this.archivePath, 'utf-8');
    const dates = new Set<string>();
    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line) as { date?: string };
        if (entry.date) dates.add(entry.date);
      } catch {
        /* skip */
      }
    }
    return dates;
  }
}
