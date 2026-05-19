// F200 Phase A: Correlates ToolEventLog entries into RecallEvents

import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { ConsumedEntry, RecallCandidate, RecallEvent, TargetRef } from './f200-types.js';
import { parseShellReadPaths } from './parse-shell-read-paths.js';
import { targetMatch } from './recall-target-match.js';

const MEMORY_TOOLS = new Set(['search_evidence', 'graph_resolve', 'list_recent']);

const CONSUMED_METHODS = new Set([
  'Read',
  'Grep',
  'graph_resolve',
  'read_session_events',
  'read_session_digest',
  'read_invocation_detail',
  'get_thread_context',
  // F200 HW-4 根因②a: Codex reads docs via shell (`/bin/zsh -lc "sed ... FILE"`)
  // logged as command_execution; targetMatch parses safe read-only shell.
  'command_execution',
]);

const MAX_TOOL_DISTANCE = 20;
const MAX_WALL_CLOCK_MS = 300_000;
const GREP_PATTERNS = ['grep', 'rg ', 'ripgrep'];

export interface RawEvent {
  invocationId: string;
  sessionId: string;
  threadId: string;
  catId: string;
  toolName: string;
  timestamp: number;
  turnIndex: number;
  status: string;
  summary: Record<string, unknown>;
}

export class RecallEventCorrelator {
  private readonly insertStmt: ReturnType<Database.Database['prepare']>;

  constructor(private readonly db: Database.Database) {
    this.insertStmt = db.prepare(`
      INSERT OR IGNORE INTO recall_events
        (recall_id, cat_id, invocation_id, tool_name, query, mode, scope,
         candidates_json, consumed_json, reformulated, fell_back_to_grep,
         abandoned, next_graph_resolve_after_read, token_cost, timestamp,
         shadow_ranking_json, result_set_id, attribution_clarity)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
  }

  correlateWindow(events: RawEvent[]): RecallEvent[] {
    const results: RecallEvent[] = [];

    // F200 HW-4 根因③ (砚砚 audit Round 1 Result 3): assign result-set
    // bundles. Same-invocation searches with no downstream consuming event
    // between them share one resultSetId; a downstream read/graph/shell-read
    // closes the bundle (砚砚 P2: shell-read counts as a boundary, else a
    // search→read→search→read coverage task gets mixed into one bundle).
    const bundleByIndex = new Map<number, string>();
    const bundleCandCount = new Map<string, Map<string, number>>();
    {
      const openByInv = new Map<string, string>();
      for (let k = 0; k < events.length; k++) {
        const ev = events[k]!;
        // 云端 codex round4 P1-b: graph_resolve has DUAL identity (MEMORY_TOOLS
        // + CONSUMING_METHOD). It must FIRST close the prior bundle (it consumes
        // prior searches), THEN open its own bundle (it's also a search-like
        // retrieval). Independent `if`s, not `else if` — handle both roles.
        if (this.isConsumingEvent(ev)) {
          openByInv.delete(ev.invocationId);
        }
        if (MEMORY_TOOLS.has(ev.toolName)) {
          let rs = openByInv.get(ev.invocationId);
          if (!rs) {
            rs = randomUUID();
            openByInv.set(ev.invocationId, rs);
          }
          bundleByIndex.set(k, rs);
          const m = bundleCandCount.get(rs) ?? new Map<string, number>();
          const seen = new Set<string>();
          for (const c of this.extractCandidates(ev)) {
            if (!seen.has(c.anchor)) {
              seen.add(c.anchor);
              m.set(c.anchor, (m.get(c.anchor) ?? 0) + 1);
            }
          }
          bundleCandCount.set(rs, m);
          // Dual-id (graph_resolve): own bundle self-closes so a subsequent
          // search starts a fresh bundle, not piggy-back on graph_resolve's
          // (codex P1-b — search→graph_resolve→search must be 3 isolated bundles).
          if (this.isConsumingEvent(ev)) {
            openByInv.delete(ev.invocationId);
          }
        }
      }
    }

    for (let i = 0; i < events.length; i++) {
      const event = events[i]!;
      if (!MEMORY_TOOLS.has(event.toolName)) continue;

      const candidates = this.extractCandidates(event);
      const sameCatWindow = this.buildWindow(events, i, event);
      const consumed = this.findConsumed(candidates, sameCatWindow);
      const reformulated = this.isReformulated(events, i, event);
      const fellBackToGrep = this.hasFellBackToGrep(sameCatWindow);
      const abandoned = consumed.length === 0 && !reformulated;
      const nextGraphResolveAfterRead = this.hasGraphAfterRead(sameCatWindow);

      const resultSetId = bundleByIndex.get(i);
      let attributionClarity: 'clean' | 'ambiguous' | undefined;
      if (consumed.length > 0) {
        const counts = resultSetId ? bundleCandCount.get(resultSetId) : undefined;
        const overlapped = counts ? consumed.some((c) => (counts.get(c.anchor) ?? 0) >= 2) : false;
        attributionClarity = overlapped ? 'ambiguous' : 'clean';
      }

      results.push({
        recallId: randomUUID(),
        catId: event.catId,
        invocationId: event.invocationId,
        toolName: event.toolName as RecallEvent['toolName'],
        query: this.extractQuery(event),
        mode: asString(event.summary.mode),
        scope: asString(event.summary.scope),
        candidates,
        consumed,
        reformulated,
        fellBackToGrep,
        abandoned,
        nextGraphResolveAfterRead,
        tokenCost: 0,
        timestamp: event.timestamp,
        ...(resultSetId ? { resultSetId } : {}),
        ...(attributionClarity ? { attributionClarity } : {}),
      });
    }
    return results;
  }

  /** F200 HW-4 根因③: a real downstream consumption that closes a bundle.
   * command_execution only counts when it actually read a file (shell-read),
   * mirroring findConsumed so bundle boundaries match consumption. */
  private isConsumingEvent(ev: RawEvent): boolean {
    if (!CONSUMED_METHODS.has(ev.toolName)) return false;
    if (ev.toolName === 'command_execution') {
      const cmd = typeof ev.summary?.command === 'string' ? (ev.summary.command as string) : '';
      return parseShellReadPaths(cmd).length > 0;
    }
    return true;
  }

  persistBatch(batch: RecallEvent[]): void {
    const tx = this.db.transaction((items: RecallEvent[]) => {
      for (const e of items) {
        const params = [
          e.recallId,
          e.catId,
          e.invocationId,
          e.toolName,
          e.query,
          e.mode ?? null,
          e.scope ?? null,
          JSON.stringify(e.candidates),
          JSON.stringify(e.consumed),
          e.reformulated ? 1 : 0,
          e.fellBackToGrep ? 1 : 0,
          e.abandoned ? 1 : 0,
          e.nextGraphResolveAfterRead ? 1 : 0,
          e.tokenCost,
          e.timestamp,
          e.shadowRankingJson ?? null,
          e.resultSetId ?? null,
          e.attributionClarity ?? null,
        ];
        this.insertStmt.run(params);
      }
    });
    tx(batch);
  }

  private extractCandidates(event: RawEvent): RecallCandidate[] {
    const raw = event.summary._f200Candidates as
      | Array<{ anchor: string; rank: number; sourcePath?: string; docKind?: string }>
      | undefined;
    if (!raw || !Array.isArray(raw)) return [];

    return raw.map((c) => ({
      anchor: c.anchor,
      rank: c.rank,
      targetRef: this.inferTargetRef(c),
      docKind: c.docKind,
    }));
  }

  private inferTargetRef(c: {
    anchor: string;
    sourcePath?: string;
    threadId?: string;
    sessionId?: string;
    invocationId?: string;
    passageId?: string;
  }): TargetRef {
    if (c.passageId) {
      return { kind: 'passage', passageId: c.passageId, threadId: c.threadId, sessionId: c.sessionId };
    }
    if (c.invocationId && c.sessionId) {
      return { kind: 'invocation', sessionId: c.sessionId, invocationId: c.invocationId };
    }
    if (c.sessionId) return { kind: 'session', sessionId: c.sessionId };
    if (c.threadId) return { kind: 'thread', threadId: c.threadId };
    return { kind: 'doc', sourcePath: c.sourcePath ?? '', anchor: c.anchor };
  }

  private buildWindow(events: RawEvent[], startIdx: number, source: RawEvent): Array<RawEvent & { distance: number }> {
    const window: Array<RawEvent & { distance: number }> = [];
    let sameCatCount = 0;
    for (let j = startIdx + 1; j < events.length; j++) {
      const e = events[j]!;
      if (e.catId !== source.catId) continue;
      if (e.invocationId !== source.invocationId) break;
      sameCatCount++;
      const withinDistance = sameCatCount <= MAX_TOOL_DISTANCE;
      const withinWallClock = e.timestamp - source.timestamp <= MAX_WALL_CLOCK_MS;
      if (!withinDistance && !withinWallClock) break;
      window.push({ ...e, distance: sameCatCount });
    }
    return window;
  }

  private findConsumed(candidates: RecallCandidate[], window: Array<RawEvent & { distance: number }>): ConsumedEntry[] {
    const consumed: ConsumedEntry[] = [];
    const matched = new Set<string>();

    for (const wEvent of window) {
      if (!CONSUMED_METHODS.has(wEvent.toolName)) continue;

      const toolInput = wEvent.summary as Record<string, unknown>;
      for (const cand of candidates) {
        if (matched.has(cand.anchor)) continue;
        if (!targetMatch(wEvent.toolName, toolInput, cand.targetRef)) continue;

        const dwellProxy = this.computeDwell(wEvent, window);
        consumed.push({
          anchor: cand.anchor,
          rank: cand.rank,
          method: wEvent.toolName as ConsumedEntry['method'],
          dwellProxy,
          // F200 HW-4 根因③: consuming event provenance — a positive is no
          // longer an opaque proxy; we know which event + how far.
          consumingEventId: `${wEvent.toolName}@${wEvent.timestamp}`,
          distance: wEvent.distance,
        });
        matched.add(cand.anchor);
        // gpt52 HW-4 review R1 P1: NO inner break for command_execution — one
        // shell event can read multiple files (sed a; sed b), each path
        // matches a distinct candidate. matched.has(anchor) dedups.
        // gpt52 HW-4 review R2 P1: narrow no-break to command_execution ONLY.
        // graph_resolve matcher has pre-existing prefix/substring fuzziness
        // (query="F10" matches both F1 and F10); without break the old single
        // mis-attribution amplifies to multi mis-attribution. Other methods
        // (Read/Grep/graph_resolve) keep the break to bound the blast radius.
        if (wEvent.toolName !== 'command_execution') break;
      }
    }
    return consumed;
  }

  private computeDwell(readEvent: RawEvent, window: Array<RawEvent & { distance: number }>): number | undefined {
    for (const e of window) {
      if (e.timestamp > readEvent.timestamp && e.catId === readEvent.catId) {
        return e.timestamp - readEvent.timestamp;
      }
    }
    return undefined;
  }

  private isReformulated(events: RawEvent[], idx: number, source: RawEvent): boolean {
    for (let j = idx + 1; j < events.length; j++) {
      const e = events[j]!;
      if (e.catId !== source.catId) continue;
      if (e.invocationId !== source.invocationId) break;
      if (MEMORY_TOOLS.has(e.toolName)) return true;
      break;
    }
    return false;
  }

  private hasFellBackToGrep(window: Array<RawEvent & { distance: number }>): boolean {
    for (const e of window) {
      if (e.toolName !== 'Bash') continue;
      const cmd = typeof e.summary.command === 'string' ? e.summary.command.toLowerCase() : '';
      if (GREP_PATTERNS.some((p) => cmd.includes(p))) return true;
    }
    return false;
  }

  private hasGraphAfterRead(window: Array<RawEvent & { distance: number }>): boolean {
    let sawRead = false;
    for (const e of window) {
      if (e.toolName === 'Read') sawRead = true;
      if (sawRead && e.toolName === 'graph_resolve') return true;
    }
    return false;
  }

  private extractQuery(event: RawEvent): string {
    return asString(event.summary.query) ?? '';
  }
}

function asString(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}
