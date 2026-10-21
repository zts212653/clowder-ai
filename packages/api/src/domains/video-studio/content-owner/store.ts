import { createHash } from 'node:crypto';
import { type BigIntStats, constants, type Dirent } from 'node:fs';
import { type FileHandle, link, mkdir, open, opendir, readFile, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { CollectiveContentCustodyFence } from './collective-custody-fence.js';
import { commitInitialOwnerState } from './state/initial-commit.js';
import { type ProjectContentStateV1, parseProjectContentState } from './state/manifest.js';
import { type ContentStream, writeOwnerPayload } from './stream-content.js';
import type { VideoProjectScopeV1 } from './types.js';

export type { ProjectContentStateV1 } from './state/manifest.js';

export interface SourcePublicationBatchLookup {
  readonly lookupId: string;
  readonly ownerUserId: string;
  readonly sourceRef: string;
  readonly artifactRef: string;
  readonly revisions: readonly string[];
}

export interface SourcePublicationMatch {
  readonly contentRef: string;
  readonly ownerRevision: number;
  readonly sourceRevision: string;
}

export class ProjectContentOwnerStore {
  readonly collectiveFence: CollectiveContentCustodyFence;
  private readonly rootDir: string;
  private readonly locks = new Map<string, Promise<void>>();
  private readonly verifiedBlobs = new Map<string, { identity: string; ready: Promise<void> }>();

  constructor(dataDir: string) {
    this.rootDir = join(dataDir, 'projects', 'content-owner-v1');
    this.collectiveFence = new CollectiveContentCustodyFence(this.rootDir, this);
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
      return parseProjectContentState(raw, contentRef);
    } catch (error: unknown) {
      if (isErrno(error, 'ENOENT')) return undefined;
      throw error;
    }
  }

  /** Enumerate primary manifests, including owner commits not yet projected into an application ledger.
   * No URL/byte index is an authority, and an incomplete read must never become "no prior publication".
   */
  async findSourcePublications(input: {
    ownerUserId: string;
    sourceRef: string;
    artifactRef: string;
    revisions: string[];
  }): Promise<SourcePublicationMatch[]> {
    const lookupId = 'single';
    const matches = await this.findSourcePublicationsBatch([{ lookupId, ...input }]);
    const candidates = matches.get(lookupId);
    if (!candidates) throw new Error('Owner batch omitted its single source publication lookup');
    return candidates;
  }

  /**
   * Resolve many immutable source coordinates with one complete manifest walk.
   * Any non-ENOENT read/parse failure rejects the whole batch so callers cannot
   * mistake an incomplete owner catalogue for an authoritative negative.
   */
  async findSourcePublicationsBatch(
    inputs: readonly SourcePublicationBatchLookup[],
  ): Promise<Map<string, SourcePublicationMatch[]>> {
    const { matches, lookupIdsByPublication } = indexSourcePublicationLookups(inputs);
    if (inputs.length === 0) return matches;

    const directory = await openOwnerManifestDirectory(this.rootDir);
    if (!directory) return matches;
    for await (const entry of directory) {
      const state = await readOwnerManifest(this.rootDir, entry);
      if (state) appendSourcePublicationMatches(state, lookupIdsByPublication, matches);
    }
    sortSourcePublicationMatches(matches);
    return matches;
  }

  /** Discover projects through the same complete canonical manifest reader as publication batches. */
  async listVideoProjects(ownerUserId: string): Promise<{ contentRef: string; projectScope: VideoProjectScopeV1 }[]> {
    const matches: { contentRef: string; projectScope: VideoProjectScopeV1 }[] = [];
    const directory = await openOwnerManifestDirectory(this.rootDir);
    if (!directory) return matches;
    for await (const entry of directory) {
      const state = await readOwnerManifest(this.rootDir, entry);
      if (state?.projectScope?.ownerUserId === ownerUserId)
        matches.push({ contentRef: state.contentRef, projectScope: { ...state.projectScope } });
    }
    return matches.sort((a, b) => a.contentRef.localeCompare(b.contentRef));
  }

  /** Bounded manifest discovery only; callers must reauthorize every resulting publication. */
  async listRetainedMedia(ownerUserId: string, after = '', limit = 30) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 30) throw new TypeError('Invalid media page');
    const items: { contentRef: string; ownerRevision: number }[] = [];
    const directory = await openOwnerManifestDirectory(this.rootDir);
    if (directory)
      for await (const entry of directory) {
        const state = await readOwnerManifest(this.rootDir, entry);
        if (
          state?.publicationScope?.ownerUserId !== ownerUserId ||
          state.contentRef.localeCompare(after) <= 0 ||
          !['image/png', 'video/mp4'].includes(state.mediaType)
        )
          continue;
        items.push({ contentRef: state.contentRef, ownerRevision: state.currentOwnerRevision });
        items.sort((a, b) => a.contentRef.localeCompare(b.contentRef));
        if (items.length > limit + 1) items.pop();
      }
    return {
      items: items.slice(0, limit),
      ...(items.length > limit ? { nextCursor: items[limit - 1]?.contentRef } : {}),
    };
  }

  async commitInitialState(
    state: ProjectContentStateV1,
    bytes: Uint8Array | ContentStream,
    authorizeEffect: () => Promise<void>,
  ) {
    await commitInitialOwnerState({
      root: this.rootDir,
      target: this.contentRoot(state.contentRef),
      state,
      bytes,
      authorizeEffect,
    });
  }

  async writeState(
    contentRef: string,
    state: ProjectContentStateV1,
    authorizeEffect?: () => Promise<void>,
  ): Promise<void> {
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
      await authorizeEffect?.();
      await rename(temporary, target);
    } catch (error: unknown) {
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
  }

  async writeBlob(contentRef: string, digest: `sha256:${string}`, bytes: Uint8Array | ContentStream): Promise<void> {
    const directory = join(this.contentRoot(contentRef), 'blobs');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const target = join(directory, digest.slice('sha256:'.length));
    const temporary = join(directory, `.blob-${process.pid}-${cryptoRandomSuffix()}.tmp`);
    try {
      const handle = await open(temporary, 'wx', 0o600);
      try {
        await writeOwnerPayload(handle, bytes);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await link(temporary, target).catch((error: unknown) => {
        if (!isErrno(error, 'EEXIST')) throw error;
      });
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
  }

  async readBlob(contentRef: string, digest: `sha256:${string}`): Promise<Buffer> {
    const bytes = await readFile(join(this.contentRoot(contentRef), 'blobs', digest.slice('sha256:'.length)));
    const actual = digestBytes(bytes);
    if (actual !== digest) throw new Error(`Content blob digest mismatch for ${contentRef}`);
    return bytes;
  }

  /** Verify an immutable file once per inode/change identity, then let callers stream their requested range. */
  async openBlob(
    contentRef: string,
    digest: `sha256:${string}`,
  ): Promise<{ handle: FileHandle; byteLength: number; path: string }> {
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
      return { handle, byteLength: Number(stat.size), path };
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

function indexSourcePublicationLookups(inputs: readonly SourcePublicationBatchLookup[]): {
  matches: Map<string, SourcePublicationMatch[]>;
  lookupIdsByPublication: Map<string, Set<string>>;
} {
  const matches = new Map<string, SourcePublicationMatch[]>();
  const lookupIdsByPublication = new Map<string, Set<string>>();
  for (const input of inputs) {
    if (matches.has(input.lookupId)) throw new TypeError(`Duplicate source publication lookup: ${input.lookupId}`);
    matches.set(input.lookupId, []);
    for (const revision of new Set(input.revisions)) {
      const key = publicationLookupKey(input.ownerUserId, input.sourceRef, input.artifactRef, revision);
      const lookupIds = getOrCreateLookupIds(lookupIdsByPublication, key);
      lookupIds.add(input.lookupId);
    }
  }
  return { matches, lookupIdsByPublication };
}

async function openOwnerManifestDirectory(rootDir: string): Promise<Awaited<ReturnType<typeof opendir>> | undefined> {
  try {
    return await opendir(rootDir);
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return undefined;
    throw error;
  }
}

async function readOwnerManifest(rootDir: string, entry: Dirent): Promise<ProjectContentStateV1 | undefined> {
  if (!entry.isDirectory()) return undefined;
  if (!/^[a-f0-9]{64}$/.test(entry.name)) return undefined;
  let raw: string;
  try {
    raw = await readFile(join(rootDir, entry.name, 'state.json'), 'utf8');
  } catch (error) {
    if (isErrno(error, 'ENOENT')) throw new Error(`Incomplete content owner manifest: ${entry.name}`, { cause: error });
    throw error;
  }
  const identity: unknown = JSON.parse(raw);
  if (!isRecord(identity)) throw new Error('Invalid content owner manifest identity');
  if (typeof identity.contentRef !== 'string') throw new Error('Invalid content owner manifest identity');
  if (contentKey(identity.contentRef) !== entry.name) throw new Error('Invalid content owner manifest identity');
  return parseProjectContentState(raw, identity.contentRef);
}

function appendSourcePublicationMatches(
  state: ProjectContentStateV1,
  lookupIdsByPublication: ReadonlyMap<string, ReadonlySet<string>>,
  matches: ReadonlyMap<string, SourcePublicationMatch[]>,
): void {
  const ownerUserId = state.publicationScope?.ownerUserId;
  if (!ownerUserId) return;
  for (const revision of state.revisions) {
    const source = revision.sourcePublication;
    if (!source) continue;
    const lookupIds = lookupIdsByPublication.get(
      publicationLookupKey(ownerUserId, source.sourceRef, source.artifactRef, source.revision),
    );
    if (!lookupIds) continue;
    for (const lookupId of lookupIds) {
      const candidates = matches.get(lookupId);
      if (!candidates) throw new Error(`Unknown source publication lookup: ${lookupId}`);
      candidates.push({
        contentRef: state.contentRef,
        ownerRevision: revision.ownerRevision,
        sourceRevision: source.revision,
      });
    }
  }
}

function sortSourcePublicationMatches(matches: ReadonlyMap<string, SourcePublicationMatch[]>): void {
  for (const candidates of matches.values()) {
    candidates.sort((a, b) => {
      const contentOrder = a.contentRef.localeCompare(b.contentRef);
      return contentOrder !== 0 ? contentOrder : a.ownerRevision - b.ownerRevision;
    });
  }
}

function getOrCreateLookupIds(lookupIdsByPublication: Map<string, Set<string>>, key: string): Set<string> {
  const existing = lookupIdsByPublication.get(key);
  if (existing) return existing;
  const created = new Set<string>();
  lookupIdsByPublication.set(key, created);
  return created;
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

function publicationLookupKey(ownerUserId: string, sourceRef: string, artifactRef: string, revision: string): string {
  return JSON.stringify([ownerUserId, sourceRef, artifactRef, revision]);
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
