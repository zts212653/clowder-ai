import { isMediaSourceReadResult, type MediaSourceReadResult, type PluginManifest } from '@clowder-ai/plugin-contract';
import { FileMessagingMediaLedger } from '../messaging/media-ledger.js';
import {
  type MediaImporter,
  type MediaImportInput,
  type MediaImportResult,
  mediaSourceMatchesIngress,
} from '../messaging/media-staging.js';

export const MEDIA_IMPORT_MAX_BYTES = 64 * 1024 * 1024;
export const MEDIA_IMPORT_READ_TIMEOUT_MS = 60_000;
const MAX_CHUNK_BYTES = 524_288;

type Source = Extract<NonNullable<PluginManifest['contributions']>[number], { type: 'media-source' }>;

export interface HostMediaSourceImporterDeps {
  readonly ledger: FileMessagingMediaLedger;
  readonly resolveManifest: (instanceId: string) => Promise<PluginManifest | undefined>;
  readonly invoke: (instanceId: string, method: string, params: unknown) => Promise<unknown>;
  readonly maxBytes?: number;
  readonly chunkBytes?: number;
  readonly timeoutMs?: number;
  readonly settleTimeoutMs?: number;
  readonly now?: () => number;
}

class ReadTimedOut extends Error {}

/** The only path from a plugin-owned PMR to Host-owned bytes. No locator crosses this boundary. */
export class HostMediaSourceImporter implements MediaImporter {
  private readonly inflight = new Map<string, Promise<MediaImportResult>>();

  constructor(private readonly deps: HostMediaSourceImporterDeps) {}

  private async source(input: MediaImportInput): Promise<Source | undefined> {
    if (!input.ingressIdentity) return undefined;
    const manifest = await this.deps.resolveManifest(input.instanceId);
    if (!manifest || !mediaSourceMatchesIngress(manifest, input.sourceId, input.ingressIdentity)) return undefined;
    const contribution = manifest.contributions?.find(
      (item): item is Source => item.type === 'media-source' && item.id === input.sourceId,
    );
    return contribution;
  }

  async import(input: MediaImportInput): Promise<MediaImportResult> {
    const importKey = [input.instanceId, input.sourceEventId, input.elementId].map(encodeURIComponent).join(':');
    const running = this.inflight.get(importKey);
    if (running) return running;
    const work = this.importOnce(input, importKey);
    this.inflight.set(importKey, work);
    try {
      return await work;
    } finally {
      if (this.inflight.get(importKey) === work) this.inflight.delete(importKey);
    }
  }

  private async importOnce(input: MediaImportInput, importKey: string): Promise<MediaImportResult> {
    try {
      const existing = await this.deps.ledger.findByImportKey(importKey, input.instanceId);
      if (existing) return { kind: 'imported', hmrId: existing };
      const source = await this.source(input);
      if (!source || !input.requestId) return { kind: 'unavailable', reason: 'unavailable' };
      const { maxBytes, chunkBytes } = this.bounds();
      const now = this.deps.now ?? Date.now;
      const timeoutMs = this.readTimeout(input, now);
      let expired = false;
      const bytes = await this.withTimeout(
        this.readAll(input, source, maxBytes, chunkBytes, () => expired),
        timeoutMs,
        () => {
          expired = true;
        },
      );
      if (input.deadline !== undefined && now() >= input.deadline) throw new ReadTimedOut();
      const hmrId = await this.deps.ledger.register(bytes, {
        ownerInstanceId: input.instanceId,
        importKey,
      });
      return { kind: 'imported', hmrId };
    } catch (error) {
      return {
        kind: 'unavailable',
        reason:
          error instanceof ReadTimedOut ? 'timeout' : error instanceof SourceExpired ? 'source_expired' : 'unavailable',
      };
    }
  }

  private bounds(): { maxBytes: number; chunkBytes: number } {
    const maxBytes = this.deps.maxBytes ?? MEDIA_IMPORT_MAX_BYTES;
    const chunkBytes = this.deps.chunkBytes ?? MAX_CHUNK_BYTES;
    if (
      !Number.isSafeInteger(maxBytes) ||
      maxBytes < 1 ||
      !Number.isSafeInteger(chunkBytes) ||
      chunkBytes < 1 ||
      chunkBytes > MAX_CHUNK_BYTES
    ) {
      throw new RangeError('media import bounds are invalid');
    }
    return { maxBytes, chunkBytes };
  }

  private readTimeout(input: MediaImportInput, now: () => number): number {
    const timeoutMs = Math.min(
      this.deps.timeoutMs ?? MEDIA_IMPORT_READ_TIMEOUT_MS,
      (input.deadline ?? Infinity) - now(),
    );
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new ReadTimedOut();
    return timeoutMs;
  }

  private async withTimeout<T>(operation: Promise<T>, timeoutMs: number, onTimeout?: () => void): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        operation,
        new Promise<T>((_resolve, reject) => {
          timer = setTimeout(() => {
            onTimeout?.();
            reject(new ReadTimedOut());
          }, timeoutMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async readAll(
    input: MediaImportInput,
    source: Source,
    maxBytes: number,
    chunkBytes: number,
    expired: () => boolean,
  ): Promise<Uint8Array> {
    const chunks: Buffer[] = [];
    let offset = 0;
    for (;;) {
      if (expired()) throw new ReadTimedOut();
      const raw: unknown = await this.deps.invoke(input.instanceId, source.readAction.method, {
        requestId: input.requestId,
        reference: input.reference,
        offset,
        limit: Math.min(chunkBytes, Math.max(1, maxBytes - offset)),
      });
      if (expired()) throw new ReadTimedOut();
      const { bytes, done, nextOffset } = this.decodeChunk(raw, input, offset, chunkBytes, maxBytes);
      chunks.push(bytes);
      offset += bytes.length;
      if (done) return Buffer.concat(chunks, offset);
      if (bytes.length === 0 || nextOffset !== offset) {
        throw new Error('media-source chunk made no progress or exceeds bounds');
      }
    }
  }

  private decodeChunk(
    raw: unknown,
    input: MediaImportInput,
    offset: number,
    chunkBytes: number,
    maxBytes: number,
  ): { bytes: Buffer; done: boolean; nextOffset?: number } {
    if (!isMediaSourceReadResult(raw) || raw.requestId !== input.requestId) {
      throw new Error('invalid media-source read response');
    }
    const reply: MediaSourceReadResult = raw;
    if (reply.kind === 'rejected') {
      if (reply.code === 'MEDIA_SOURCE_UNAVAILABLE') throw new SourceExpired();
      throw new Error('media-source read rejected');
    }
    if (
      reply.offset !== offset ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(reply.dataBase64)
    ) {
      throw new Error('invalid media-source chunk position or bytes');
    }
    const bytes = Buffer.from(reply.dataBase64, 'base64');
    if (
      bytes.toString('base64') !== reply.dataBase64 ||
      bytes.length > chunkBytes ||
      offset + bytes.length > maxBytes
    ) {
      throw new Error('media-source chunk exceeds bounds');
    }
    return { bytes, done: reply.done, ...(reply.nextOffset === undefined ? {} : { nextOffset: reply.nextOffset }) };
  }

  async settle(input: MediaImportInput, outcome: 'imported' | 'unavailable'): Promise<void> {
    const source = await this.source(input);
    if (!source || !input.requestId) throw new Error('media-source settlement target is unavailable');
    await this.withTimeout(
      this.deps.invoke(input.instanceId, source.settleAction.method, {
        requestId: input.requestId,
        reference: input.reference,
        outcome,
      }),
      this.deps.settleTimeoutMs ?? 5_000,
    );
  }
}

class SourceExpired extends Error {}
