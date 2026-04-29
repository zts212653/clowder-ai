/**
 * TranscriptWriter — F24 Phase C
 * Collects invocation events in memory, flushes to JSONL on seal.
 *
 * File structure per session:
 *   <dataDir>/threads/<threadId>/<catId>/sessions/<sessionId>/
 *     events.jsonl           — NDJSON events with envelope
 *     index.json             — sparse byte-offset index for pagination
 *     digest.extractive.json — rule-based extractive digest
 *
 * events.jsonl envelope:
 *   { v:1, t:number, threadId, catId, sessionId, cliSessionId, invocationId?, eventNo, event }
 */

import { mkdir, writeFile } from 'node:fs/promises';
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
  /** Last visible assistant text messages, carried verbatim as reference data for continuity. */
  recentMessages?: Array<{
    role: 'assistant';
    invocationId?: string;
    content: string;
  }>;
  /** Latest structured collaboration control-flow state captured at a seal boundary. */
  continuityCapsule?: CollaborationContinuityCapsuleV1;
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
    buf.push({
      eventNo: buf.length,
      timestamp: Date.now(),
      ...(invocationId !== undefined ? { invocationId } : {}),
      event,
    });
  }

  /** Get buffered events for a session (for testing). */
  getBufferedEvents(sessionId: string): BufferedEvent[] {
    return this.buffers.get(sessionId) ?? [];
  }

  /** Get buffered event count for a session. */
  getEventCount(sessionId: string): number {
    return this.buffers.get(sessionId)?.length ?? 0;
  }

  /**
   * Flush buffered events to disk + generate index + extractive digest.
   * Clears the buffer after successful write.
   */
  async flush(session: TranscriptSessionInfo, sealTimestamps?: { createdAt: number; sealedAt: number }): Promise<void> {
    const buf = this.buffers.get(session.sessionId);
    if (!buf || buf.length === 0) {
      return;
    }

    const sessionDir = this.sessionDir(session);
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

    // Clear buffer
    this.buffers.delete(session.sessionId);
  }

  /**
   * Generate extractive digest from buffered events.
   * Rule-based extraction: no LLM, deterministic, zero cost.
   */
  generateExtractiveDigest(
    session: TranscriptSessionInfo,
    sealTimestamps: { createdAt: number; sealedAt: number },
  ): ExtractiveDigestV1 {
    const buf = this.buffers.get(session.sessionId) ?? [];

    // Extract tool names (deduplicated per invocation group)
    const toolNames = new Set<string>();
    const filePaths = new Map<string, Set<string>>(); // path → ops
    const errors: ExtractiveDigestV1['errors'] = [];
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

        // Extract file paths from tool input (AgentMessage: toolInput, raw: input)
        const input = (evt.toolInput ?? evt.input) as Record<string, unknown> | undefined;
        if (input) {
          const filePath = (input.file_path ?? input.path) as string | undefined;
          if (filePath && typeof filePath === 'string') {
            const ops = filePaths.get(filePath) ?? new Set();
            const opName = this.toolNameToOp(evtName);
            if (opName) ops.add(opName);
            filePaths.set(filePath, ops);
          }
        }
      }

      // Error events — AgentMessage uses type='error'+error field;
      // raw NDJSON uses type='tool_result'+is_error+content
      if (evtType === 'tool_result' && evt.is_error) {
        const evtContent = evt.content;
        const message = typeof evtContent === 'string' ? evtContent : JSON.stringify(evtContent);
        errors.push({
          at: entry.timestamp,
          ...(entry.invocationId !== undefined ? { invocationId: entry.invocationId } : {}),
          message: message.slice(0, 500),
        });
      }
      if (evtType === 'error' && typeof evt.error === 'string') {
        errors.push({
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

    return {
      v: 1,
      sessionId: session.sessionId,
      threadId: session.threadId,
      catId: session.catId,
      seq: session.seq,
      time: sealTimestamps,
      invocations: [
        {
          toolNames: [...toolNames],
        },
      ],
      filesTouched: [...filePaths.entries()].map(([path, ops]) => ({
        path,
        ops: [...ops],
      })),
      errors,
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

  /** Map tool name to file operation type. */
  private toolNameToOp(name: string): string | null {
    switch (name.toLowerCase()) {
      case 'write':
        return 'create';
      case 'edit':
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

  /** Compute session directory path. */
  private sessionDir(session: TranscriptSessionInfo): string {
    return join(this.dataDir, 'threads', session.threadId, session.catId, 'sessions', session.sessionId);
  }
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
