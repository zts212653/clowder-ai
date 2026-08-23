/**
 * TranscriptReader — F24 Phase D
 * Reads sealed session transcripts from disk.
 *
 * Supports:
 * - Paginated event reading via sparse index
 * - Extractive digest reading
 * - Full-text search across events and digests
 */

import { createReadStream } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { normalizeTranscriptEvent } from './TranscriptEventEnvelope.js';
import { formatEventsHandoff, type HandoffInvocationSummary } from './TranscriptFormatter.js';

export interface TranscriptEvent {
  v: number;
  t: number;
  threadId: string;
  catId: string;
  sessionId: string;
  cliSessionId?: string;
  invocationId?: string;
  eventNo: number;
  event: Record<string, unknown>;
}

export interface TranscriptIndex {
  v: number;
  eventCount: number;
  stride: number;
  offsets: number[];
}

export interface ReadEventsResult {
  events: TranscriptEvent[];
  nextCursor?: { eventNo: number };
  total: number;
}

export interface ReadEventsHandoffResult {
  invocations: HandoffInvocationSummary[];
  nextCursor?: { eventNo: number };
  total: number;
}

export interface SearchHit {
  score: number;
  sessionId: string;
  seq?: number;
  kind: 'digest' | 'event';
  snippet: string;
  pointer: {
    eventNo?: number;
    invocationId?: string;
  };
}

export interface HandoffDigestResult {
  v: number;
  model: string;
  generatedAt: number;
  body: string;
}

export interface TranscriptReaderOptions {
  dataDir: string;
}

export class TranscriptReader {
  private readonly dataDir: string;

  constructor(opts: TranscriptReaderOptions) {
    this.dataDir = opts.dataDir;
  }

  /**
   * Read events from a sealed session transcript with pagination.
   */
  async readEvents(
    sessionId: string,
    threadId: string,
    catId: string,
    cursor?: { eventNo: number },
    limit = 50,
  ): Promise<ReadEventsResult> {
    const sessionDir = this.sessionDir(threadId, catId, sessionId);
    const jsonlPath = join(sessionDir, 'events.jsonl');

    // Check if transcript exists
    try {
      await stat(jsonlPath);
    } catch {
      return { events: [], total: 0 };
    }

    // Try to read index for optimized pagination
    const index = await this.readIndex(sessionDir);
    const startEventNo = cursor?.eventNo ?? 0;

    // Read events using streaming
    const events: TranscriptEvent[] = [];
    let lineNo = 0;

    const rl = createInterface({
      input: createReadStream(jsonlPath, 'utf-8'),
      crlfDelay: Infinity,
    });

    for await (const line of rl) {
      if (line.trim().length === 0) continue;
      if (lineNo >= startEventNo && events.length < limit) {
        try {
          const event = normalizeTranscriptEvent(JSON.parse(line));
          if (event) events.push(event);
        } catch {
          /* skip malformed lines */
        }
      }
      lineNo++;
      // Early exit: we've collected enough and passed our window
      if (events.length >= limit && lineNo > startEventNo + limit) {
        break;
      }
    }

    const total = index?.eventCount ?? lineNo;
    const lastEvent = events.length > 0 ? events[events.length - 1] : undefined;
    const lastEventNo = lastEvent ? lastEvent.eventNo : startEventNo;
    const hasMore = lastEventNo + 1 < total;

    return {
      events,
      ...(hasMore ? { nextCursor: { eventNo: lastEventNo + 1 } } : {}),
      total,
    };
  }

  /**
   * Read events in handoff view with invocation-level pagination.
   *
   * Unlike readEvents() which paginates raw events, this method:
   * 1. Reads ALL events from the sealed session
   * 2. Groups them into complete invocation summaries
   * 3. Paginates by raw-event budget, accumulating complete invocations
   *
   * The cursor and total use raw eventNo units — same as raw/chat views —
   * so the external API contract (nextCursor.eventNo) is preserved.
   * Each invocation appears exactly once with complete tool calls,
   * error counts, and key messages.
   *
   * If a single invocation exceeds the limit, the page overflows to
   * include it (at least one complete summary per page).
   */
  async readEventsHandoff(
    sessionId: string,
    threadId: string,
    catId: string,
    cursor?: { eventNo: number },
    limit = 50,
  ): Promise<ReadEventsHandoffResult> {
    const allEvents = await this.readAllEvents(sessionId, threadId, catId);
    if (allEvents.length === 0) {
      return { invocations: [], total: 0 };
    }

    // Group events by invocationId, preserving insertion order
    const groups = new Map<string, TranscriptEvent[]>();
    for (const evt of allEvents) {
      const key = evt.invocationId ?? '_unknown';
      let group = groups.get(key);
      if (!group) {
        group = [];
        groups.set(key, group);
      }
      group.push(evt);
    }

    // Build ordered invocation metadata with first/last eventNo
    const invocationMeta: Array<{ firstEventNo: number; lastEventNo: number; eventCount: number }> = [];
    for (const [, events] of groups) {
      invocationMeta.push({
        firstEventNo: events[0].eventNo,
        lastEventNo: events[events.length - 1].eventNo,
        eventCount: events.length,
      });
    }

    // Format all events into summaries (same insertion order as groups)
    const allSummaries = formatEventsHandoff(allEvents);

    // Find starting invocation: first whose lastEventNo >= cursor.
    // This correctly hits the invocation *containing* cursor.eventNo
    // (e.g. cursor=55 inside inv-A spanning 0-59 → returns inv-A).
    let startIdx = 0;
    if (cursor) {
      startIdx = invocationMeta.findIndex((m) => m.lastEventNo >= cursor.eventNo);
      if (startIdx === -1) {
        return { invocations: [], total: allEvents.length };
      }
    }

    // Accumulate complete invocations by raw-event budget.
    // Always include at least one invocation even if it exceeds the limit.
    let eventBudget = 0;
    let endIdx = startIdx;
    while (endIdx < invocationMeta.length) {
      const invEventCount = invocationMeta[endIdx].eventCount;
      if (eventBudget > 0 && eventBudget + invEventCount > limit) break;
      eventBudget += invEventCount;
      endIdx++;
    }

    const pageSummaries = allSummaries.slice(startIdx, endIdx);
    const hasMore = endIdx < invocationMeta.length;

    return {
      invocations: pageSummaries,
      ...(hasMore ? { nextCursor: { eventNo: invocationMeta[endIdx].firstEventNo } } : {}),
      total: allEvents.length,
    };
  }

  /**
   * Read extractive digest for a sealed session.
   */
  async readDigest(sessionId: string, threadId: string, catId: string): Promise<Record<string, unknown> | null> {
    const digestPath = join(this.sessionDir(threadId, catId, sessionId), 'digest.extractive.json');
    try {
      const content = await readFile(digestPath, 'utf-8');
      return JSON.parse(content) as Record<string, unknown>;
    } catch {
      return null;
    }
  }

  /**
   * Full-text search across transcripts and digests.
   * Phase D: naive implementation (scan all files).
   * Future: upgrade to indexed/vector search without breaking interface.
   */
  async search(
    threadId: string,
    query: string,
    opts?: {
      cats?: string[];
      sessionIds?: string[];
      limit?: number;
      scope?: 'digests' | 'transcripts' | 'both';
    },
  ): Promise<SearchHit[]> {
    const limit = opts?.limit ?? 10;
    const scope = opts?.scope ?? 'both';
    const hits: SearchHit[] = [];
    const needle = query.toLowerCase();

    // Find all session directories for this thread
    const threadDir = join(this.dataDir, 'threads', threadId);
    let catDirs: string[];
    try {
      catDirs = await readdir(threadDir);
    } catch {
      return [];
    }

    for (const catId of catDirs) {
      if (opts?.cats && !opts.cats.includes(catId)) continue;

      const sessionsDir = join(threadDir, catId, 'sessions');
      let sessionDirs: string[];
      try {
        sessionDirs = await readdir(sessionsDir);
      } catch {
        continue;
      }

      for (const sessionId of sessionDirs) {
        if (opts?.sessionIds && !opts.sessionIds.includes(sessionId)) continue;
        if (hits.length >= limit) break;

        const sessionDir = join(sessionsDir, sessionId);

        // Search digests
        if (scope === 'digests' || scope === 'both') {
          try {
            const digestContent = await readFile(join(sessionDir, 'digest.extractive.json'), 'utf-8');
            const digestText = digestContent.toLowerCase();
            if (digestText.includes(needle)) {
              const digest = JSON.parse(digestContent);
              hits.push({
                score: 1.0,
                sessionId,
                seq: digest.seq,
                kind: 'digest',
                snippet: this.extractSnippet(digestContent, query),
                pointer: {},
              });
            }
          } catch {
            /* no digest or parse error */
          }
        }

        // Search transcripts
        if ((scope === 'transcripts' || scope === 'both') && hits.length < limit) {
          try {
            const rl = createInterface({
              input: createReadStream(join(sessionDir, 'events.jsonl'), 'utf-8'),
              crlfDelay: Infinity,
            });
            for await (const line of rl) {
              if (hits.length >= limit) break;
              if (line.toLowerCase().includes(needle)) {
                try {
                  const evt = normalizeTranscriptEvent(JSON.parse(line));
                  if (!evt) continue;
                  hits.push({
                    score: 0.8,
                    sessionId,
                    kind: 'event',
                    snippet: this.extractSnippet(line, query),
                    pointer: {
                      eventNo: evt.eventNo,
                      ...(evt.invocationId ? { invocationId: evt.invocationId } : {}),
                    },
                  });
                } catch {
                  /* skip */
                }
              }
            }
          } catch {
            /* no transcript */
          }
        }
      }
    }

    return hits.slice(0, limit);
  }

  /**
   * Read all events belonging to a specific invocation from a session transcript.
   * F98 Gap 2: supports read_invocation_detail MCP tool.
   */
  async readInvocationEvents(
    sessionId: string,
    threadId: string,
    catId: string,
    invocationId: string,
  ): Promise<TranscriptEvent[] | null> {
    const sessionDir = this.sessionDir(threadId, catId, sessionId);
    const jsonlPath = join(sessionDir, 'events.jsonl');

    try {
      await stat(jsonlPath);
    } catch {
      return null;
    }

    const events: TranscriptEvent[] = [];
    const rl = createInterface({
      input: createReadStream(jsonlPath, 'utf-8'),
      crlfDelay: Infinity,
    });

    for await (const line of rl) {
      if (line.trim().length === 0) continue;
      try {
        const evt = normalizeTranscriptEvent(JSON.parse(line));
        if (!evt) continue;
        if (evt.invocationId === invocationId) {
          events.push(evt);
        }
      } catch {
        /* skip malformed */
      }
    }

    return events.length > 0 ? events : null;
  }

  /**
   * Read handoff digest (LLM-generated) for a sealed session.
   * F065 Phase C: returns parsed YAML frontmatter + markdown body.
   */
  async readHandoffDigest(sessionId: string, threadId: string, catId: string): Promise<HandoffDigestResult | null> {
    const digestPath = join(this.sessionDir(threadId, catId, sessionId), 'digest.handoff.md');
    try {
      const content = await readFile(digestPath, 'utf-8');
      return this.parseHandoffDigest(content);
    } catch {
      return null;
    }
  }

  /**
   * Read ALL events from a sealed session transcript (no limit).
   * F065 Phase C: needed for handoff digest generation on long sessions.
   */
  async readAllEvents(
    sessionId: string,
    threadId: string,
    catId: string,
    signal?: AbortSignal,
  ): Promise<TranscriptEvent[]> {
    signal?.throwIfAborted();
    const jsonlPath = join(this.sessionDir(threadId, catId, sessionId), 'events.jsonl');

    try {
      await stat(jsonlPath);
    } catch {
      return [];
    }

    const events: TranscriptEvent[] = [];
    const rl = createInterface({
      input: createReadStream(jsonlPath, { encoding: 'utf-8', signal }),
      crlfDelay: Infinity,
    });

    for await (const line of rl) {
      signal?.throwIfAborted();
      if (line.trim().length === 0) continue;
      try {
        const event = normalizeTranscriptEvent(JSON.parse(line));
        if (event) events.push(event);
      } catch {
        /* skip malformed */
      }
    }

    return events;
  }

  /** Public accessor for session directory path. */
  getSessionDir(threadId: string, catId: string, sessionId: string): string {
    return this.sessionDir(threadId, catId, sessionId);
  }

  /** Check if a session has a transcript on disk. */
  async hasTranscript(sessionId: string, threadId: string, catId: string): Promise<boolean> {
    try {
      await stat(join(this.sessionDir(threadId, catId, sessionId), 'events.jsonl'));
      return true;
    } catch {
      return false;
    }
  }

  private async readIndex(sessionDir: string): Promise<TranscriptIndex | null> {
    try {
      const content = await readFile(join(sessionDir, 'index.json'), 'utf-8');
      return JSON.parse(content) as TranscriptIndex;
    } catch {
      return null;
    }
  }

  private sessionDir(threadId: string, catId: string, sessionId: string): string {
    return join(this.dataDir, 'threads', threadId, catId, 'sessions', sessionId);
  }

  /** Parse a handoff digest markdown file with YAML frontmatter. */
  private parseHandoffDigest(content: string): HandoffDigestResult | null {
    const fmMatch = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
    if (!fmMatch || !fmMatch[1] || !fmMatch[2]) return null;

    const frontmatter = fmMatch[1];
    const body = fmMatch[2].trim();

    // Simple YAML key-value parsing (no nested objects needed)
    const meta: Record<string, string> = {};
    for (const line of frontmatter.split('\n')) {
      const colonIdx = line.indexOf(':');
      if (colonIdx > 0) {
        const key = line.slice(0, colonIdx).trim();
        const val = line.slice(colonIdx + 1).trim();
        meta[key] = val;
      }
    }

    const v = Number(meta.v);
    const generatedAt = Number(meta.generatedAt);
    if (!Number.isFinite(v) || !meta.model || !Number.isFinite(generatedAt)) {
      return null;
    }

    return { v, model: meta.model, generatedAt, body };
  }

  private extractSnippet(text: string, query: string, maxLen = 200): string {
    const lower = text.toLowerCase();
    const idx = lower.indexOf(query.toLowerCase());
    if (idx < 0) return text.slice(0, maxLen);
    const start = Math.max(0, idx - 40);
    const end = Math.min(text.length, idx + query.length + 160);
    const snippet = text.slice(start, end);
    return (start > 0 ? '...' : '') + snippet + (end < text.length ? '...' : '');
  }
}
