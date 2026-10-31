import { type PluginManifest } from '@clowder-ai/plugin-contract';
import { FileMessagingMediaLedger } from '../messaging/media-ledger.js';
import {
  type MediaImporter,
  type MediaImportInput,
  type MediaImportResult,
  mediaSourceMatchesIngress,
} from '../messaging/media-staging.js';

export const MEDIA_IMPORT_MAX_BYTES = 64 * 1024 * 1024;
export const MEDIA_IMPORT_READ_TIMEOUT_MS = 60_000;

type Source = Extract<NonNullable<PluginManifest['contributions']>[number], { type: 'media-source' }>;

export interface HostMediaSourceImporterDeps {
  readonly ledger: FileMessagingMediaLedger;
  readonly resolveManifest: (instanceId: string) => Promise<PluginManifest | undefined>;
  readonly read: (instanceId: string, reference: string, options: { signal: AbortSignal }) => AsyncIterable<Uint8Array>;
  readonly maxBytes?: number;
  readonly timeoutMs?: number;
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
      if (!source) return { kind: 'unavailable', reason: 'unavailable' };
      const maxBytes = this.deps.maxBytes ?? MEDIA_IMPORT_MAX_BYTES;
      if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new RangeError('Invalid media import byte limit');
      const now = this.deps.now ?? Date.now;
      const timeoutMs = this.readTimeout(input, now);
      const controller = new AbortController();
      const bytes = await this.withTimeout(this.readAll(input, maxBytes, controller.signal), timeoutMs, () =>
        controller.abort(new ReadTimedOut()),
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
          error instanceof ReadTimedOut
            ? 'timeout'
            : (error as { code?: string })?.code === 'MEDIA_SOURCE_UNAVAILABLE'
              ? 'source_expired'
              : 'unavailable',
      };
    }
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

  private async readAll(input: MediaImportInput, maxBytes: number, signal: AbortSignal): Promise<Uint8Array> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const bytes of this.deps.read(input.instanceId, input.reference, { signal })) {
      signal.throwIfAborted();
      if (!(bytes instanceof Uint8Array) || size + bytes.byteLength > maxBytes)
        throw new Error('Plugin stream exceeds media import bounds');
      chunks.push(Buffer.from(bytes));
      size += bytes.byteLength;
    }
    signal.throwIfAborted();
    return Buffer.concat(chunks, size);
  }
}
