import { createHash, randomBytes } from 'node:crypto';
import { type BigIntStats, constants, type ReadStream } from 'node:fs';
import { type FileHandle, mkdir, open, readdir, readFile, rename } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { MediaReadResult } from '@clowder-ai/plugin-contract';

export interface MessagingMediaRegistration {
  readonly ownerInstanceId?: string;
  readonly mimeType?: string;
  readonly importKey?: string;
}

interface StoredMediaRecord extends MessagingMediaRegistration {
  readonly hmrId: string;
  readonly byteLength: number;
  readonly createdAt: number;
  readonly digest: `sha256:${string}`;
  /** Private to this module. Never returned in a Host surface, envelope, receipt, or audit. */
  readonly locator: string;
}

const HMR_ID = /^hmr_[A-Za-z0-9_-]{32}$/;
const COPY_CHUNK_BYTES = 64 * 1024;

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

async function copySource(
  source: Uint8Array | { readonly path: string },
  destination: FileHandle,
): Promise<{ byteLength: number; digest: `sha256:${string}` }> {
  const hash = createHash('sha256');
  if (source instanceof Uint8Array) {
    const owned = Buffer.from(source);
    await destination.writeFile(owned);
    return { byteLength: owned.byteLength, digest: `sha256:${hash.update(owned).digest('hex')}` };
  }
  const input = await open(source.path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await input.stat();
    if (!stat.isFile() || !Number.isSafeInteger(stat.size)) {
      throw new TypeError('media source must be a safely sized regular file');
    }
    const chunk = Buffer.allocUnsafe(COPY_CHUNK_BYTES);
    let position = 0;
    while (position < stat.size) {
      const { bytesRead } = await input.read(chunk, 0, Math.min(chunk.length, stat.size - position), position);
      if (bytesRead === 0) throw new Error('media source changed during import');
      hash.update(chunk.subarray(0, bytesRead));
      let written = 0;
      while (written < bytesRead) {
        const result = await destination.write(chunk, written, bytesRead - written);
        if (result.bytesWritten === 0) throw new Error('media destination made no progress');
        written += result.bytesWritten;
      }
      position += bytesRead;
    }
    const after = await input.stat();
    if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs) {
      throw new Error('media source changed during import');
    }
    return { byteLength: position, digest: `sha256:${hash.digest('hex')}` };
  } finally {
    await input.close();
  }
}

function fileIdentity(stat: BigIntStats): string {
  return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
}

async function verifyBytes(handle: FileHandle, size: number, expectedDigest: string): Promise<void> {
  const hash = createHash('sha256');
  const chunk = Buffer.allocUnsafe(COPY_CHUNK_BYTES);
  let position = 0;
  while (position < size) {
    const { bytesRead } = await handle.read(chunk, 0, Math.min(chunk.length, size - position), position);
    if (bytesRead === 0) throw new Error('media bytes truncated after registration');
    hash.update(chunk.subarray(0, bytesRead));
    position += bytesRead;
  }
  if (`sha256:${hash.digest('hex')}` !== expectedDigest) throw new Error('media bytes changed after registration');
}

/** Durable Host-owned bytes. Published hmr IDs are identifiers, never filesystem locators or bearers. */
export class FileMessagingMediaLedger {
  private readonly root: string;
  private readonly verified = new Map<string, { identity: string; ready: Promise<void> }>();
  private registrationTail: Promise<void> = Promise.resolve();

  constructor(
    root: string,
    private readonly now: () => number = Date.now,
  ) {
    this.root = resolve(root);
  }

  async register(
    source: Uint8Array | { readonly path: string },
    meta: MessagingMediaRegistration = {},
  ): Promise<string> {
    const previous = this.registrationTail;
    let release!: () => void;
    this.registrationTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      if (meta.importKey) {
        const existing = await this.findByImportKey(meta.importKey, meta.ownerInstanceId);
        if (existing) return existing;
      }
      return await this.registerNew(source, meta);
    } finally {
      release();
    }
  }

  /** Lookup stays inside the private ledger; callers only receive an opaque HMR identifier. */
  async findByImportKey(importKey: string, ownerInstanceId?: string): Promise<string | undefined> {
    let names: string[];
    try {
      names = await readdir(join(this.root, 'records'));
    } catch (error) {
      if (isMissing(error)) return undefined;
      throw error;
    }
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      const hmrId = name.slice(0, -5);
      if (!HMR_ID.test(hmrId)) continue;
      const record = await this.record(hmrId);
      if (record?.importKey === importKey && record.ownerInstanceId === ownerInstanceId) {
        const verified = await this.openVerifiedRecord(record);
        await verified.handle.close();
        return hmrId;
      }
    }
    return undefined;
  }

  private async registerNew(
    source: Uint8Array | { readonly path: string },
    meta: MessagingMediaRegistration,
  ): Promise<string> {
    const hmrId = `hmr_${randomBytes(24).toString('base64url')}`;
    const blobsRoot = join(this.root, 'blobs');
    const recordsRoot = join(this.root, 'records');
    await mkdir(blobsRoot, { recursive: true, mode: 0o700 });
    await mkdir(recordsRoot, { recursive: true, mode: 0o700 });
    const locator = join(blobsRoot, hmrId);
    const blob = await open(locator, 'wx', 0o600);
    let copied: { byteLength: number; digest: `sha256:${string}` };
    try {
      copied = await copySource(source, blob);
      await blob.sync();
    } finally {
      await blob.close();
    }
    const record: StoredMediaRecord = { ...meta, hmrId, ...copied, createdAt: this.now(), locator };
    const target = join(recordsRoot, `${hmrId}.json`);
    const temporary = `${target}.${randomBytes(8).toString('hex')}.tmp`;
    const handle = await open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(JSON.stringify(record));
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, target);
    const recordsDirectory = await open(recordsRoot, 'r');
    try {
      await recordsDirectory.sync();
    } finally {
      await recordsDirectory.close();
    }
    return hmrId;
  }

  private async record(hmrId: string): Promise<StoredMediaRecord | undefined> {
    if (!HMR_ID.test(hmrId)) return undefined;
    try {
      const candidate = JSON.parse(
        await readFile(join(this.root, 'records', `${hmrId}.json`), 'utf8'),
      ) as StoredMediaRecord;
      if (
        candidate.hmrId !== hmrId ||
        candidate.locator !== join(this.root, 'blobs', hmrId) ||
        !Number.isSafeInteger(candidate.byteLength) ||
        candidate.byteLength < 0 ||
        !Number.isFinite(candidate.createdAt) ||
        !/^sha256:[a-f0-9]{64}$/.test(candidate.digest)
      ) {
        throw new Error('media ledger record is corrupt');
      }
      return candidate;
    } catch (error) {
      if (isMissing(error)) return undefined;
      throw error;
    }
  }

  /** Ownership only; never expose the private locator or turn the hmr identifier into a bearer. */
  async isImportOwner(hmrId: string, instanceId: string): Promise<boolean> {
    const record = await this.record(hmrId);
    return record?.ownerInstanceId === instanceId;
  }

  private async openVerifiedRecord(record: StoredMediaRecord): Promise<{ handle: FileHandle; identity: string }> {
    const handle = await open(record.locator, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await handle.stat({ bigint: true });
      if (!stat.isFile() || stat.size !== BigInt(record.byteLength)) {
        throw new Error('media bytes changed after registration');
      }
      const identity = fileIdentity(stat);
      let verification = this.verified.get(record.locator);
      if (!verification || verification.identity !== identity) {
        verification = { identity, ready: verifyBytes(handle, record.byteLength, record.digest) };
        if (this.verified.size >= 64) {
          const oldest = this.verified.keys().next().value;
          if (oldest) this.verified.delete(oldest);
        }
        this.verified.set(record.locator, verification);
      }
      try {
        await verification.ready;
        if (fileIdentity(await handle.stat({ bigint: true })) !== identity) {
          throw new Error('media bytes changed during read');
        }
      } catch (error) {
        if (this.verified.get(record.locator) === verification) this.verified.delete(record.locator);
        throw error;
      }
      return { handle, identity };
    } catch (error) {
      await handle.close();
      throw error;
    }
  }

  /** Host cat-runtime only. Never project this private path into a plugin, event, receipt, or log. */
  async resolveTrustedBlobPath(hmrId: string): Promise<string | undefined> {
    const record = await this.record(hmrId);
    if (!record) return undefined;
    const { handle } = await this.openVerifiedRecord(record);
    await handle.close();
    return record.locator;
  }

  /** Owner HTTP route only. The verified descriptor stays inside this ledger; no locator escapes. */
  async openVerifiedStream(
    hmrId: string,
  ): Promise<{ stream: ReadStream; byteLength: number; mimeType?: string } | undefined> {
    const record = await this.record(hmrId);
    if (!record) return undefined;
    const { handle } = await this.openVerifiedRecord(record);
    try {
      return {
        stream: handle.createReadStream({ autoClose: true }),
        byteLength: record.byteLength,
        mimeType: record.mimeType,
      };
    } catch (error) {
      await handle.close();
      throw error;
    }
  }

  async readChunk(hmrId: string, offset: number, limit: number): Promise<MediaReadResult | undefined> {
    const record = await this.record(hmrId);
    if (!record) return undefined;
    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      offset > record.byteLength ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 524288
    ) {
      throw new RangeError('media read range is invalid');
    }
    const length = Math.min(limit, record.byteLength - offset);
    const bytes = Buffer.alloc(length);
    const { handle, identity } = await this.openVerifiedRecord(record);
    try {
      let read = 0;
      while (read < length) {
        const result = await handle.read(bytes, read, length - read, offset + read);
        if (result.bytesRead === 0) throw new Error('media bytes truncated after registration');
        read += result.bytesRead;
      }
      if (fileIdentity(await handle.stat({ bigint: true })) !== identity) {
        throw new Error('media bytes changed during read');
      }
    } finally {
      await handle.close();
    }
    const nextOffset = offset + length;
    return nextOffset < record.byteLength
      ? { offset, dataBase64: bytes.toString('base64'), nextOffset, done: false }
      : { offset, dataBase64: bytes.toString('base64'), done: true };
  }
}
