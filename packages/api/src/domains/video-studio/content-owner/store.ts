import { createHash } from 'node:crypto';
import { type BigIntStats, constants } from 'node:fs';
import { type FileHandle, link, mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { validateContentPublication } from './publication.js';
import type { ContentPublicationScopeV1, ContentSettlementReceiptV1, ProjectContentRevisionV1 } from './types.js';

interface StoredOperationV1 {
  readonly fingerprint: `sha256:${string}`;
  readonly receiptId: string;
}

export interface ProjectContentStateV1 {
  readonly schemaVersion: 1;
  readonly contentRef: string;
  readonly mediaType: string;
  readonly currentOwnerRevision: number;
  readonly revisions: readonly ProjectContentRevisionV1[];
  readonly receipts: readonly ContentSettlementReceiptV1[];
  readonly operations: Readonly<Record<string, StoredOperationV1>>;
  readonly publicationScope?: ContentPublicationScopeV1;
}

export class ProjectContentOwnerStore {
  private readonly rootDir: string;
  private readonly locks = new Map<string, Promise<void>>();
  private readonly verifiedBlobs = new Map<string, { identity: string; ready: Promise<void> }>();

  constructor(dataDir: string) {
    this.rootDir = join(dataDir, 'projects', 'content-owner-v1');
  }

  async withContentLock<T>(contentRef: string, operation: () => Promise<T>): Promise<T> {
    const key = contentKey(contentRef);
    const previous = this.locks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.locks.set(key, current);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.locks.get(key) === current) this.locks.delete(key);
    }
  }

  async readState(contentRef: string): Promise<ProjectContentStateV1 | undefined> {
    try {
      const raw = await readFile(this.statePath(contentRef), 'utf8');
      return parseState(raw, contentRef);
    } catch (error: unknown) {
      if (isErrno(error, 'ENOENT')) return undefined;
      throw error;
    }
  }

  async writeState(contentRef: string, state: ProjectContentStateV1): Promise<void> {
    const directory = this.contentRoot(contentRef);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const target = this.statePath(contentRef);
    const temporary = join(directory, `.state-${process.pid}-${cryptoRandomSuffix()}.tmp`);
    const handle = await open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(state, null, 2)}\n`, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await rename(temporary, target);
    } catch (error: unknown) {
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
  }

  async writeBlob(contentRef: string, digest: `sha256:${string}`, bytes: Uint8Array): Promise<void> {
    const directory = join(this.contentRoot(contentRef), 'blobs');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const target = join(directory, digest.slice('sha256:'.length));
    const temporary = join(directory, `.blob-${process.pid}-${cryptoRandomSuffix()}.tmp`);
    const handle = await open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await link(temporary, target);
    } catch (error: unknown) {
      if (!isErrno(error, 'EEXIST')) {
        await unlink(temporary).catch(() => undefined);
        throw error;
      }
    }
    await unlink(temporary);
  }

  async readBlob(contentRef: string, digest: `sha256:${string}`): Promise<Buffer> {
    const bytes = await readFile(join(this.contentRoot(contentRef), 'blobs', digest.slice('sha256:'.length)));
    const actual = digestBytes(bytes);
    if (actual !== digest) throw new Error(`Content blob digest mismatch for ${contentRef}`);
    return bytes;
  }

  /** Verify an immutable file once per inode/change identity, then let callers stream their requested range. */
  async openBlob(contentRef: string, digest: `sha256:${string}`): Promise<{ handle: FileHandle; byteLength: number }> {
    if (!/^sha256:[a-f0-9]{64}$/.test(digest)) throw new Error('Invalid content blob digest');
    const path = join(this.contentRoot(contentRef), 'blobs', digest.slice('sha256:'.length));
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await handle.stat({ bigint: true });
      if (!stat.isFile() || stat.size > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Invalid content blob file');
      const identity = blobFileIdentity(stat);
      let verification = this.verifiedBlobs.get(path);
      if (!verification || verification.identity !== identity) {
        verification = { identity, ready: verifyBlob(handle, Number(stat.size), digest) };
        if (this.verifiedBlobs.size >= 64) {
          const oldest = this.verifiedBlobs.keys().next().value;
          if (oldest) this.verifiedBlobs.delete(oldest);
        }
        this.verifiedBlobs.set(path, verification);
      }
      try {
        await verification.ready;
        if (blobFileIdentity(await handle.stat({ bigint: true })) !== identity) {
          throw new Error('Content blob changed during verification');
        }
      } catch (error) {
        if (this.verifiedBlobs.get(path) === verification) this.verifiedBlobs.delete(path);
        throw error;
      }
      return { handle, byteLength: Number(stat.size) };
    } catch (error) {
      await handle.close();
      throw error;
    }
  }

  private contentRoot(contentRef: string): string {
    return join(this.rootDir, contentKey(contentRef));
  }

  private statePath(contentRef: string): string {
    return join(this.contentRoot(contentRef), 'state.json');
  }
}

export function digestBytes(bytes: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function blobFileIdentity(stat: BigIntStats): string {
  return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
}

async function verifyBlob(handle: FileHandle, byteLength: number, digest: `sha256:${string}`): Promise<void> {
  const hash = createHash('sha256');
  const buffer = Buffer.allocUnsafe(64 * 1024);
  let position = 0;
  while (position < byteLength) {
    const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, byteLength - position), position);
    if (bytesRead === 0) throw new Error('Content blob was truncated during verification');
    hash.update(buffer.subarray(0, bytesRead));
    position += bytesRead;
  }
  if (`sha256:${hash.digest('hex')}` !== digest) throw new Error('Content blob digest mismatch');
}

function contentKey(contentRef: string): string {
  return createHash('sha256').update(contentRef).digest('hex');
}

function cryptoRandomSuffix(): string {
  return createHash('sha256')
    .update(`${Date.now()}\0${process.hrtime.bigint()}\0${Math.random()}`)
    .digest('hex')
    .slice(0, 16);
}

function isErrno(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === code;
}

function parseState(raw: string, expectedContentRef: string): ProjectContentStateV1 {
  const parsed: unknown = JSON.parse(raw);
  if (!isRecord(parsed) || parsed.schemaVersion !== 1 || parsed.contentRef !== expectedContentRef) {
    throw new Error(`Invalid content owner state for ${expectedContentRef}`);
  }
  if (
    typeof parsed.mediaType !== 'string' ||
    !Number.isSafeInteger(parsed.currentOwnerRevision) ||
    !Array.isArray(parsed.revisions) ||
    !Array.isArray(parsed.receipts) ||
    !isRecord(parsed.operations)
  ) {
    throw new Error(`Corrupt content owner state for ${expectedContentRef}`);
  }
  const state = parsed as unknown as ProjectContentStateV1;
  for (const revision of state.revisions)
    validateContentPublication(state.publicationScope, revision.sourcePublication);
  return state;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
