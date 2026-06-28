/**
 * TranscriptWriter — F24 Phase C
 * Collects invocation events in memory, flushes to JSONL on seal.
 *
 * File structure per session:
 *   <dataDir>/threads/<threadId>/<catId>/sessions/<sessionId>/
 *     events.jsonl           — NDJSON events with envelope (canonical, written at seal)
 *     events.live.jsonl      — incremental crash-recovery copy (active sessions only)
 *     index.json             — sparse byte-offset index for pagination
 *     digest.extractive.json — rule-based extractive digest
 *
 * events.jsonl envelope:
 *   { v:1, t:number, threadId, catId, sessionId, cliSessionId, invocationId?, eventNo, event }
 */

import { appendFile, mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  type CollaborationContinuityCapsuleV1,
  extractContinuityCapsuleFromSystemInfo,
} from '../agents/invocation/CollaborationContinuityCapsule.js';
import { stripLeakedToolCallPayload } from '../agents/routing/route-helpers.js';

export interface TranscriptSessionInfo {
  sessionId: string;
  threadId: string;
  catId: string;
  cliSessionId: string;
  seq: number;
}

interface BufferedEvent {
  eventNo: number;
  timestamp: number;
  invocationId?: string;
  event: Record<string, unknown>;
}

export interface ExtractiveDigestV1 {
  v: 1;
  sessionId: string;
  threadId: string;
  catId: string;
  seq: number;
  time: { createdAt: number; sealedAt: number };
  sealReason?: string;
  invocations: Array<{
    invocationId?: string;
    toolNames?: string[];
  }>;
  filesTouched: Array<{
    path: string;
    ops: string[];
  }>;
  errors: Array<{
    at: number;
    invocationId?: string;
    message: string;
  }>;
  diagnostics?: {
    noise?: DigestNoiseSummary[];
  };
  /** Last visible assistant text messages, carried verbatim as reference data for continuity. */
  recentMessages?: Array<{
    role: 'assistant';
    invocationId?: string;
    content: string;
  }>;
  /** Latest structured collaboration control-flow state captured at a seal boundary. */
  continuityCapsule?: CollaborationContinuityCapsuleV1;
}

export type DigestNoiseKind = 'context_canceled' | 'mcp_refused' | 'canceled_step';

export interface DigestNoiseSummary {
  kind: DigestNoiseKind;
  count: number;
  sample: string;
  invocationIds: string[];
  firstAt: number;
  lastAt: number;
  outcome: 'recovered' | 'terminal';
}

interface DigestErrorRecord {
  order: number;
  at: number;
  invocationId?: string;
  message: string;
}

interface DigestNoiseGroup {
  kind: DigestNoiseKind;
  count: number;
  sample: string;
  invocationIds: Set<string>;
  firstAt: number;
  lastAt: number;
  recovered: boolean;
  errors: DigestErrorRecord[];
}

export interface TranscriptWriterOptions {
  dataDir: string;
  /** Sparse index stride (default 100) */
  indexStride?: number;
}

export interface HandoffDigestMeta {
  v: number;
  model: string;
  generatedAt: number;
}

export class TranscriptWriter {
  private readonly dataDir: string;
  private readonly indexStride: number;
  /** sessionId → buffered events */
  private buffers = new Map<string, BufferedEvent[]>();
  /** Serialized disk write chains per session for incremental crash-recovery append. */
  private diskWriteQueue = new Map<string, Promise<void>>();

  constructor(opts: TranscriptWriterOptions) {
    this.dataDir = opts.dataDir;
    this.indexStride = opts.indexStride ?? 100;
  }

  /** Append a raw event to the in-memory buffer for a session. */
  appendEvent(session: TranscriptSessionInfo, event: Record<string, unknown>, invocationId?: string): void {
    let buf = this.buffers.get(session.sessionId);
    if (!buf) {
      buf = [];
      this.buffers.set(session.sessionId, buf);
    }
    const entry: BufferedEvent = {
      eventNo: buf.length,
      timestamp: Date.now(),
      ...(invocationId !== undefined ? { invocationId } : {}),
      event,
    };
    buf.push(entry);

    // Incremental disk append for crash recovery (F232 disk fallback).
    // Fire-and-forget: buffer is the primary source during normal operation;
    // disk copy only matters when the process restarts and buffer is lost.
    this.enqueueDiskAppend(session, entry);
  }

  /** Get buffered events for a session (for testing). */
  getBufferedEvents(sessionId: string): BufferedEvent[] {
    return this.buffers.get(sessionId) ?? [];
  }

  /** Get buffered event count for a session. */
  getEventCount(sessionId: string): number {
    return this.buffers.get(sessionId)?.length ?? 0;
  }

  /** Enqueue a single event append to disk. Writes are serialized per session. */
  private enqueueDiskAppend(session: TranscriptSessionInfo, entry: BufferedEvent): void {
    const prev = this.diskWriteQueue.get(session.sessionId) ?? Promise.resolve();
    const next = prev
      .then(async () => {
        const dir = this.sessionDir(session);
        await mkdir(dir, { recursive: true });
        const envelope = {
          v: 1,
          t: entry.timestamp,
          threadId: session.threadId,
          catId: session.catId,
          sessionId: session.sessionId,
          cliSessionId: session.cliSessionId,
          invocationId: entry.invocationId,
          eventNo: entry.eventNo,
          event: entry.event,
        };
        await appendFile(join(dir, 'events.live.jsonl'), `${JSON.stringify(envelope)}\n`, 'utf-8');
      })
      .catch(() => {
        // Best-effort: buffer is the primary source; disk append is crash-recovery insurance.
      });
    this.diskWriteQueue.set(session.sessionId, next);
  }

  /** Wait for all pending incremental disk writes to complete. Primarily for testing. */
  async drainPendingWrites(sessionId?: string): Promise<void> {
    if (sessionId) {
      await this.diskWriteQueue.get(sessionId);
    } else {
      await Promise.all([...this.diskWriteQueue.values()]);
    }
  }

  /**
   * Get the current session's touched files.
   * Merges events from both disk (events.live.jsonl — has pre-restart events)
   * and in-memory buffer (has current events including not-yet-flushed writes).
   * The merge is idempotent on file paths via Map key deduplication.
   */
  async getFilesTouched(
    sessionId: string,
    sessionMeta?: { threadId: string; catId: string },
  ): Promise<ExtractiveDigestV1['filesTouched']> {
    const filePaths = new Map<string, Set<string>>();

    // Merge from disk: has pre-restart events + already-flushed post-restart events
    if (sessionMeta) {
      const sessionDir = join(this.dataDir, 'threads', sessionMeta.threadId, sessionMeta.catId, 'sessions', sessionId);
      const diskEvents = await this.readEventsFromLiveFile(sessionDir);
      for (const entry of diskEvents) {
        const evt = entry.event;
        recordFilesTouched(filePaths, evt, (evt.toolName ?? evt.name) as string | undefined);
      }
    }

    // Overlay in-memory buffer: has current events + not-yet-flushed writes
    const buf = this.buffers.get(sessionId) ?? [];
    for (const entry of buf) {
      const evt = entry.event;
      recordFilesTouched(filePaths, evt, (evt.toolName ?? evt.name) as string | undefined);
    }

    return materializeFilesTouched(filePaths);
  }

  /** Read raw events from the incremental live file. Returns [] if file doesn't exist. */
  private async readEventsFromLiveFile(sessionDir: string): Promise<BufferedEvent[]> {
    try {
      const content = await readFile(join(sessionDir, 'events.live.jsonl'), 'utf-8');
      const events: BufferedEvent[] = [];
      for (const line of content.split('\n')) {
        if (!line.trim()) continue;
        try {
          const envelope = JSON.parse(line);
          events.push({
            eventNo: events.length,
            timestamp: envelope.t,
            ...(envelope.invocationId !== undefined ? { invocationId: envelope.invocationId } : {}),
            event: envelope.event,
          });
        } catch {
          // Skip malformed lines
        }
      }
      return events;
    } catch {
      return [];
    }
  }

  /**
   * Flush buffered events to disk + generate index + extractive digest.
   * Clears the buffer after successful write.
   */
  async flush(
    session: TranscriptSessionInfo,
    sealTimestamps?: { createdAt: number; sealedAt: number; sealReason?: string },
  ): Promise<void> {
    let buf = this.buffers.get(session.sessionId) ?? [];

    // Drain pending incremental writes before reading the live file.
    await this.drainPendingWrites(session.sessionId);

    const sessionDir = this.sessionDir(session);

    // Recover pre-restart events from live file, merging with the in-memory
    // buffer instead of replacing. The buffer is authoritative for post-restart
    // events — it may include events whose disk append silently failed
    // (enqueueDiskAppend is best-effort, catch swallows errors).
    // This also covers the zero-post-restart seal case: buffer is empty but
    // events.live.jsonl has all pre-restart events.
    const liveEvents = await this.readEventsFromLiveFile(sessionDir);
    if (liveEvents.length > 0) {
      // Content-based dedup: fingerprint each buffer event so we can identify
      // which live-file events are disk-only (pre-restart) vs duplicates of
      // buffer events that also made it to disk.
      const bufKeys = new Set(buf.map((e) => `${e.timestamp}:${JSON.stringify(e.event)}`));
      const diskOnly = liveEvents.filter((e) => !bufKeys.has(`${e.timestamp}:${JSON.stringify(e.event)}`));
      buf = [...diskOnly, ...buf];
      // Re-number eventNo sequentially after merge.
      for (let i = 0; i < buf.length; i++) {
        buf[i] = { ...buf[i], eventNo: i };
      }
      this.buffers.set(session.sessionId, buf);
    }

    if (buf.length === 0) {
      return;
    }

    await mkdir(sessionDir, { recursive: true });

    // 1. Write events.jsonl
    const jsonlLines: string[] = [];
    const offsets: number[] = [];
    let byteOffset = 0;

    for (const entry of buf) {
      if (entry.eventNo % this.indexStride === 0) {
        offsets.push(byteOffset);
      }

      const envelope = {
        v: 1,
        t: entry.timestamp,
        threadId: session.threadId,
        catId: session.catId,
        sessionId: session.sessionId,
        cliSessionId: session.cliSessionId,
        invocationId: entry.invocationId,
        eventNo: entry.eventNo,
        event: entry.event,
      };

      const line = JSON.stringify(envelope);
      jsonlLines.push(line);
      byteOffset += Buffer.byteLength(line, 'utf-8') + 1; // +1 for newline
    }

    await writeFile(join(sessionDir, 'events.jsonl'), `${jsonlLines.join('\n')}\n`, 'utf-8');

    // 2. Write index.json
    const index = {
      v: 1,
      eventCount: buf.length,
      stride: this.indexStride,
      offsets,
    };
    await writeFile(join(sessionDir, 'index.json'), JSON.stringify(index, null, 2), 'utf-8');

    // 3. Write digest.extractive.json (if seal timestamps provided)
    if (sealTimestamps) {
      const digest = this.generateExtractiveDigest(session, sealTimestamps);
      await writeFile(join(sessionDir, 'digest.extractive.json'), JSON.stringify(digest, null, 2), 'utf-8');
    }

    // Clear buffer + disk write queue
    this.buffers.delete(session.sessionId);
    this.diskWriteQueue.delete(session.sessionId);

    // Remove the incremental crash-recovery file — the canonical events.jsonl is now the source.
    // Best-effort: file may not exist if no incremental writes happened.
    await unlink(join(sessionDir, 'events.live.jsonl')).catch(() => {});
  }

  /**
   * Generate extractive digest from buffered events.
   * Rule-based extraction: no LLM, deterministic, zero cost.
   */
  generateExtractiveDigest(
    session: TranscriptSessionInfo,
    sealTimestamps: { createdAt: number; sealedAt: number; sealReason?: string },
  ): ExtractiveDigestV1 {
    const buf = this.buffers.get(session.sessionId) ?? [];

    // Extract tool names (deduplicated per invocation group)
    const toolNames = new Set<string>();
    const filePaths = new Map<string, Set<string>>(); // path → ops
    const errors: DigestErrorRecord[] = [];
    const noiseGroups: DigestNoiseGroup[] = [];
    const recentMessages: NonNullable<ExtractiveDigestV1['recentMessages']> = [];
    const recentMessageByStream = new Map<string, NonNullable<ExtractiveDigestV1['recentMessages']>[number]>();
    let continuityCapsule: CollaborationContinuityCapsuleV1 | undefined;

    for (const entry of buf) {
      const evt = entry.event;
      const evtType = evt.type;
      // R11 P1-2: Support both AgentMessage fields (toolName/toolInput) and
      // raw NDJSON fields (name/input). In production, appendEvent receives
      // AgentMessage objects, which use toolName/toolInput.
      const evtName = (evt.toolName ?? evt.name) as string | undefined;

      // Tool use events
      if (evtType === 'tool_use' && typeof evtName === 'string') {
        toolNames.add(evtName);
        recordFilesTouched(filePaths, evt, evtName);
      }

      // Error events — AgentMessage uses type='error'+error field;
      // raw NDJSON uses type='tool_result'+is_error+content
      if (evtType === 'tool_result' && evt.is_error) {
        const evtContent = evt.content;
        const message = typeof evtContent === 'string' ? evtContent : JSON.stringify(evtContent);
        recordDigestErrorOrNoise(noiseGroups, errors, {
          order: entry.eventNo,
          at: entry.timestamp,
          ...(entry.invocationId !== undefined ? { invocationId: entry.invocationId } : {}),
          message: message.slice(0, 500),
        });
      }
      if (evtType === 'error' && typeof evt.error === 'string') {
        recordDigestErrorOrNoise(noiseGroups, errors, {
          order: entry.eventNo,
          at: entry.timestamp,
          ...(entry.invocationId !== undefined ? { invocationId: entry.invocationId } : {}),
          message: (evt.error as string).slice(0, 500),
        });
      }
      if (evtType === 'system_info' && typeof evt.content === 'string') {
        continuityCapsule = extractContinuityCapsuleFromSystemInfo(evt.content) ?? continuityCapsule;
      }

      const streamKey =
        evtType === 'text' && entry.invocationId !== undefined
          ? `${entry.invocationId}:${typeof evt.catId === 'string' ? evt.catId : session.catId}`
          : null;
      const visibleText = extractVisibleAssistantText(evt, { trim: streamKey === null });
      if (visibleText) {
        markDigestNoiseRecovered(noiseGroups, entry.timestamp, entry.invocationId);
        if (streamKey) {
          const existing = recentMessageByStream.get(streamKey);
          if (existing && recentMessages[recentMessages.length - 1] === existing) {
            const content = normalizeVisibleText(coalesceVisibleText(existing.content, visibleText, evt.textMode), {
              trim: false,
            });
            if (content) {
              existing.content = content.slice(0, 1200);
              moveToEnd(recentMessages, existing);
            } else {
              removeItem(recentMessages, existing);
              recentMessageByStream.delete(streamKey);
            }
          } else {
            const message = {
              role: 'assistant' as const,
              ...(entry.invocationId !== undefined ? { invocationId: entry.invocationId } : {}),
              content: visibleText.slice(0, 1200),
            };
            recentMessages.push(message);
            recentMessageByStream.set(streamKey, message);
          }
        } else {
          recentMessages.push({
            role: 'assistant',
            ...(entry.invocationId !== undefined ? { invocationId: entry.invocationId } : {}),
            content: visibleText.slice(0, 1200),
          });
        }
      }
    }

    const noiseSummaries = finalizeDigestNoise(noiseGroups, errors);
    const digestErrors: ExtractiveDigestV1['errors'] = errors.map(({ order: _order, ...error }) => error);

    return {
      v: 1,
      sessionId: session.sessionId,
      threadId: session.threadId,
      catId: session.catId,
      seq: session.seq,
      time: { createdAt: sealTimestamps.createdAt, sealedAt: sealTimestamps.sealedAt },
      ...(sealTimestamps.sealReason ? { sealReason: sealTimestamps.sealReason } : {}),
      invocations: [
        {
          toolNames: [...toolNames],
        },
      ],
      filesTouched: materializeFilesTouched(filePaths),
      errors: digestErrors,
      ...(noiseSummaries.length > 0 ? { diagnostics: { noise: noiseSummaries } } : {}),
      recentMessages: recentMessages.slice(-5),
      ...(continuityCapsule ? { continuityCapsule } : {}),
    };
  }

  /**
   * Write handoff digest to a session directory.
   * F065 Phase C: static so it can be called from SessionSealer without instance state.
   */
  static async writeHandoffDigest(sessionDir: string, meta: HandoffDigestMeta, body: string): Promise<void> {
    const frontmatter = ['---', `v: ${meta.v}`, `model: ${meta.model}`, `generatedAt: ${meta.generatedAt}`, '---'].join(
      '\n',
    );

    await writeFile(join(sessionDir, 'digest.handoff.md'), `${frontmatter}\n\n${body}\n`, 'utf-8');
  }
  /** Compute session directory path. */
  private sessionDir(session: TranscriptSessionInfo): string {
    return join(this.dataDir, 'threads', session.threadId, session.catId, 'sessions', session.sessionId);
  }
}

function recordFilesTouched(
  filePaths: Map<string, Set<string>>,
  evt: Record<string, unknown>,
  evtName: string | undefined,
): void {
  if (evt.type !== 'tool_use' || typeof evtName !== 'string') return;

  const input = (evt.toolInput ?? evt.input) as Record<string, unknown> | undefined;
  if (!input) return;
  const opName = toolNameToOp(evtName);
  const filePathsTouched = extractToolPaths(input, evtName);
  for (const filePath of filePathsTouched) {
    const ops = filePaths.get(filePath) ?? new Set<string>();
    if (opName) ops.add(opName);
    filePaths.set(filePath, ops);
  }
}

function materializeFilesTouched(filePaths: Map<string, Set<string>>): ExtractiveDigestV1['filesTouched'] {
  return [...filePaths.entries()].map(([path, ops]) => ({
    path,
    ops: [...ops],
  }));
}

function toolNameToOp(name: string): string | null {
  switch (name.toLowerCase()) {
    case 'write':
      return 'create';
    case 'edit':
    case 'file_change':
      return 'edit';
    case 'delete':
      return 'delete';
    case 'read':
    case 'grep':
    case 'glob':
      return 'read';
    default:
      return null;
  }
}

function extractToolPaths(input: Record<string, unknown>, toolName: string): string[] {
  const directPath = (input.file_path ?? input.path) as string | undefined;
  if (directPath && typeof directPath === 'string') return [directPath];

  if (toolName.toLowerCase() !== 'file_change' || !Array.isArray(input.changes)) return [];

  return input.changes
    .map((change) => {
      if (typeof change === 'string') return change;
      if (change && typeof change === 'object' && typeof (change as { path?: unknown }).path === 'string') {
        return (change as { path: string }).path;
      }
      return null;
    })
    .filter((path): path is string => typeof path === 'string' && path.length > 0);
}

function extractVisibleAssistantText(evt: Record<string, unknown>, opts?: { trim?: boolean }): string | null {
  if (evt.type === 'text' && typeof evt.content === 'string') {
    return normalizeVisibleText(evt.content, opts);
  }

  if (evt.type === 'assistant') {
    const content = evt.content;
    if (typeof content === 'string') {
      return normalizeVisibleText(content, opts);
    }
    if (Array.isArray(content)) {
      const text = content
        .map((part) => {
          if (!part || typeof part !== 'object') return '';
          const maybeText = (part as { text?: unknown }).text;
          return typeof maybeText === 'string' ? maybeText : '';
        })
        .filter(Boolean)
        .join('\n');
      return normalizeVisibleText(text, opts);
    }
  }

  return null;
}

function normalizeVisibleText(text: string, opts?: { trim?: boolean }): string | null {
  const sanitized = stripLeakedToolCallPayload(text.replace(/[\x00-\x08\x0b-\x1f]/g, ''));
  if (sanitized.trim().length === 0) return null;
  return opts?.trim === false ? sanitized : sanitized.trim();
}

function coalesceVisibleText(existing: string, next: string, textMode: unknown): string {
  if (textMode === 'replace') {
    return next;
  }
  return `${existing}${next}`;
}

function moveToEnd<T>(items: T[], item: T): void {
  const index = items.indexOf(item);
  if (index >= 0 && index !== items.length - 1) {
    items.splice(index, 1);
    items.push(item);
  }
}

function removeItem<T>(items: T[], item: T): void {
  const index = items.indexOf(item);
  if (index >= 0) {
    items.splice(index, 1);
  }
}

function recordDigestErrorOrNoise(
  noiseGroups: DigestNoiseGroup[],
  errors: DigestErrorRecord[],
  error: DigestErrorRecord,
): void {
  const kind = classifyDigestNoise(error.message);
  if (!kind) {
    errors.push(error);
    return;
  }

  const latest = noiseGroups.at(-1);
  const group =
    latest && latest.kind === kind && !latest.recovered && noiseGroupMatchesInvocation(latest, error.invocationId)
      ? latest
      : {
          kind,
          count: 0,
          sample: error.message,
          invocationIds: new Set<string>(),
          firstAt: error.at,
          lastAt: error.at,
          recovered: false,
          errors: [],
        };

  if (group.count === 0) {
    noiseGroups.push(group);
  }

  group.count += 1;
  group.lastAt = error.at;
  group.errors.push(error);
  if (error.invocationId) group.invocationIds.add(error.invocationId);
}

function classifyDigestNoise(message: string): DigestNoiseKind | null {
  if (/context cancell?ed/i.test(message)) return 'context_canceled';
  if (/\bmcp\b/i.test(message) && /refus|status:\s*refused/i.test(message)) return 'mcp_refused';
  if (/cancell?ed step|step .* cancell?ed|user_cancel/i.test(message)) return 'canceled_step';
  return null;
}

function noiseGroupMatchesInvocation(group: DigestNoiseGroup, invocationId?: string): boolean {
  if (!invocationId) return group.invocationIds.size === 0;
  return group.invocationIds.size === 1 && group.invocationIds.has(invocationId);
}

function noiseGroupCanRecoverFromInvocation(group: DigestNoiseGroup, invocationId?: string): boolean {
  if (group.invocationIds.size === 0) return true;
  return invocationId !== undefined && group.invocationIds.has(invocationId);
}

function markDigestNoiseRecovered(noiseGroups: DigestNoiseGroup[], recoveredAt: number, invocationId?: string): void {
  for (const group of noiseGroups) {
    if (!group.recovered && group.lastAt <= recoveredAt && noiseGroupCanRecoverFromInvocation(group, invocationId)) {
      group.recovered = true;
    }
  }
}

function finalizeDigestNoise(noiseGroups: DigestNoiseGroup[], errors: DigestErrorRecord[]): DigestNoiseSummary[] {
  const summaries: DigestNoiseSummary[] = [];
  for (const group of noiseGroups) {
    if (group.count < 2) {
      errors.push(...group.errors);
      continue;
    }

    const outcome = group.recovered ? 'recovered' : 'terminal';
    summaries.push({
      kind: group.kind,
      count: group.count,
      sample: group.sample,
      invocationIds: [...group.invocationIds],
      firstAt: group.firstAt,
      lastAt: group.lastAt,
      outcome,
    });

    if (outcome === 'terminal') {
      const representative = group.errors[0];
      if (representative) errors.push(representative);
    }
  }
  errors.sort((left, right) => left.order - right.order);
  return summaries;
}
