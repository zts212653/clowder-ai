/**
 * F153 Prompt X-Ray: File-based ring buffer for canonical prompt captures.
 *
 * Stores gzip-compressed prompt snapshots with NDJSON index.
 * Default off — controlled by PROMPT_CAPTURE env var.
 */

import {
  appendFile,
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFile,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync, gzip, gzipSync } from 'node:zlib';
import { createModuleLogger } from '../logger.js';

const log = createModuleLogger('debug:prompt-capture');

export interface PromptCapture {
  captureId: string;
  invocationId: string;
  hmacInvocationId?: string;
  catId: string;
  threadId: string;
  userId: string;
  model: string;
  capturedAt: number;

  systemPrompt: string;
  missionPrefix?: string;
  userPrompt: string;
  effectivePrompt: string;

  injectionDecision: {
    isResume: boolean;
    canSkipOnResume: boolean;
    forceReinjection: boolean;
    injected: boolean;
  };

  promptBytes: number;
  tokenEstimate: number;
}

export interface CaptureIndexEntry {
  captureId: string;
  invocationId: string;
  hmacInvocationId?: string;
  catId: string;
  threadId: string;
  userId: string;
  capturedAt: number;
  promptBytes: number;
  file: string;
}

const DEFAULT_BASE_DIR = join(homedir(), '.cat-cafe', 'prompt-captures');
const DEFAULT_MAX_ENTRIES = 500;
const DEFAULT_TTL_MS = 6 * 60 * 60 * 1000;

export class PromptCaptureStore {
  private readonly baseDir: string;
  private readonly payloadDir: string;
  private readonly indexPath: string;
  private readonly maxEntries: number;
  private readonly ttlMs: number;

  constructor(opts?: { baseDir?: string; maxEntries?: number; ttlMs?: number }) {
    this.baseDir = opts?.baseDir ?? DEFAULT_BASE_DIR;
    this.payloadDir = join(this.baseDir, 'payloads');
    this.indexPath = join(this.baseDir, 'index.ndjson');
    this.maxEntries = opts?.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.ttlMs = opts?.ttlMs ?? DEFAULT_TTL_MS;
    this.ensureDirs();
  }

  private ensureDirs(): void {
    if (!existsSync(this.payloadDir)) {
      mkdirSync(this.payloadDir, { recursive: true });
    }
  }

  captureAsync(data: PromptCapture): void {
    const json = JSON.stringify(data);
    const fileName = `${data.captureId}.json.gz`;
    const filePath = join(this.payloadDir, fileName);

    gzip(Buffer.from(json), (gzipErr, compressed) => {
      if (gzipErr) {
        log.warn({ err: gzipErr, captureId: data.captureId }, 'Prompt capture gzip failed');
        return;
      }
      writeFile(filePath, compressed, (writeErr) => {
        if (writeErr) {
          log.warn({ err: writeErr, captureId: data.captureId }, 'Prompt capture write failed');
          return;
        }
        const indexEntry: CaptureIndexEntry = {
          captureId: data.captureId,
          invocationId: data.invocationId,
          hmacInvocationId: data.hmacInvocationId,
          catId: data.catId,
          threadId: data.threadId,
          userId: data.userId,
          capturedAt: data.capturedAt,
          promptBytes: data.promptBytes,
          file: fileName,
        };
        appendFile(this.indexPath, `${JSON.stringify(indexEntry)}\n`, (appendErr) => {
          if (appendErr) log.warn({ err: appendErr }, 'Prompt capture index append failed');
          this.pruneIfNeeded();
        });
      });
    });
  }

  captureSync(data: PromptCapture): string {
    try {
      const compressed = gzipSync(JSON.stringify(data));
      const fileName = `${data.captureId}.json.gz`;
      writeFileSync(join(this.payloadDir, fileName), compressed);
      const indexEntry: CaptureIndexEntry = {
        captureId: data.captureId,
        invocationId: data.invocationId,
        hmacInvocationId: data.hmacInvocationId,
        catId: data.catId,
        threadId: data.threadId,
        userId: data.userId,
        capturedAt: data.capturedAt,
        promptBytes: data.promptBytes,
        file: fileName,
      };
      appendFileSync(this.indexPath, `${JSON.stringify(indexEntry)}\n`);
      this.pruneIfNeeded();
      return data.captureId;
    } catch (err) {
      log.warn({ err, captureId: data.captureId }, 'Failed to write prompt capture');
      return data.captureId;
    }
  }

  read(captureId: string, userId?: string): PromptCapture | null {
    if (!isValidCaptureId(captureId)) return null;
    try {
      const filePath = join(this.payloadDir, `${captureId}.json.gz`);
      if (!existsSync(filePath)) return null;
      const compressed = readFileSync(filePath);
      const capture = JSON.parse(gunzipSync(compressed).toString('utf8')) as PromptCapture;
      if (capture.capturedAt < Date.now() - this.ttlMs) return null;
      if (userId && capture.userId !== userId) return null;
      return capture;
    } catch (err) {
      log.warn({ err, captureId }, 'Failed to read prompt capture');
      return null;
    }
  }

  listByInvocation(invocationId: string, userId?: string): CaptureIndexEntry[] {
    const cutoff = Date.now() - this.ttlMs;
    return this.readIndex().filter(
      (e) =>
        (e.invocationId === invocationId || e.hmacInvocationId === invocationId) &&
        e.capturedAt >= cutoff &&
        (!userId || e.userId === userId),
    );
  }

  listByThread(threadId: string, limit = 20, userId?: string): CaptureIndexEntry[] {
    const cutoff = Date.now() - this.ttlMs;
    return this.readIndex()
      .filter((e) => e.threadId === threadId && e.capturedAt >= cutoff && (!userId || e.userId === userId))
      .slice(-limit);
  }

  listRecent(limit = 20): CaptureIndexEntry[] {
    const cutoff = Date.now() - this.ttlMs;
    return this.readIndex()
      .filter((e) => e.capturedAt >= cutoff)
      .slice(-limit);
  }

  stats(): { entries: number; totalBytes: number } {
    const entries = this.readIndex();
    return {
      entries: entries.length,
      totalBytes: entries.reduce((sum, e) => sum + e.promptBytes, 0),
    };
  }

  prune(): number {
    const cutoff = Date.now() - this.ttlMs;
    const entries = this.readIndex();
    const keep: CaptureIndexEntry[] = [];
    let removed = 0;

    for (const entry of entries) {
      if (entry.capturedAt < cutoff) {
        this.deletePayload(entry.file);
        removed++;
      } else {
        keep.push(entry);
      }
    }

    if (keep.length > this.maxEntries) {
      const overflow = keep.splice(0, keep.length - this.maxEntries);
      for (const entry of overflow) {
        this.deletePayload(entry.file);
        removed++;
      }
    }

    if (removed > 0) {
      this.writeIndex(keep);
      log.info({ removed, remaining: keep.length }, 'Pruned prompt captures');
    }

    return removed;
  }

  private pruneIfNeeded(): void {
    try {
      const entries = this.readIndex();
      if (entries.length > this.maxEntries + 10) {
        this.prune();
      }
    } catch {
      // Non-critical
    }
  }

  private readIndex(): CaptureIndexEntry[] {
    try {
      if (!existsSync(this.indexPath)) return [];
      const content = readFileSync(this.indexPath, 'utf8');
      return content
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as CaptureIndexEntry);
    } catch {
      return [];
    }
  }

  private writeIndex(entries: CaptureIndexEntry[]): void {
    writeFileSync(this.indexPath, entries.map((e) => JSON.stringify(e)).join('\n') + '\n');
  }

  private deletePayload(fileName: string): void {
    try {
      unlinkSync(join(this.payloadDir, fileName));
    } catch {
      // File may already be gone
    }
  }
}

const CAPTURE_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
function isValidCaptureId(id: string): boolean {
  return CAPTURE_ID_RE.test(id);
}

// ── Gate ──────────────────────────────────────────────────────────

export function isPromptCaptureEnabled(catId?: string): boolean {
  const mode = process.env.PROMPT_CAPTURE;
  if (mode !== 'on') return false;
  const allowedCats = process.env.PROMPT_CAPTURE_CATS;
  if (!allowedCats) return true;
  if (!catId) return true;
  return allowedCats.split(',').some((c) => c.trim() === catId);
}

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.5);
}
