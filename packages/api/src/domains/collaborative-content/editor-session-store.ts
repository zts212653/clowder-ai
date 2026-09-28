import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { ContentActorV1 } from '../video-studio/content-owner/types.js';

export type StoredEditorSessionState = 'issued' | 'active' | 'revoked' | 'closed';

export interface StoredEditorSessionRecordV1 {
  readonly sessionRef: string;
  readonly bearerDigest: `sha256:${string}`;
  readonly state: StoredEditorSessionState;
  readonly contentRef: string;
  readonly actor: ContentActorV1;
  readonly ownerRevision: number;
  readonly bindingRevision: number;
  readonly providerId: string;
  readonly installationInstanceId: string;
  readonly providerVersion: string;
  readonly packageDigest: string;
  readonly grantRevision: number;
  readonly lifecycleRevision: number;
  readonly surfaceIntegrity: string;
  /** Digest only: the Host's opaque execution lease never enters F309 state or responses. */
  readonly executionLeaseDigest?: string;
  readonly revokeReason?: string;
}

interface EditorSessionSnapshotV1 {
  readonly schemaVersion: 1;
  readonly sessions: readonly StoredEditorSessionRecordV1[];
}

export class EditorSessionStore {
  private readonly snapshotPath: string;
  private lock: Promise<void> = Promise.resolve();

  constructor(options: { readonly dataDir: string }) {
    this.snapshotPath = join(options.dataDir, 'projects', 'collaborative-content-v1', 'editor-sessions.json');
  }

  async get(sessionRef: string): Promise<StoredEditorSessionRecordV1 | undefined> {
    validateSessionRef(sessionRef);
    const snapshot = await this.readSnapshot();
    const session = snapshot.sessions.find((candidate) => candidate.sessionRef === sessionRef);
    return session ? cloneStoredSession(session) : undefined;
  }

  async put(session: StoredEditorSessionRecordV1): Promise<void> {
    const parsed = parseStoredSession(session);
    await this.withLock(async () => {
      const snapshot = await this.readSnapshot();
      await this.writeSnapshot({
        schemaVersion: 1,
        sessions: [...snapshot.sessions.filter((item) => item.sessionRef !== parsed.sessionRef), parsed].sort(
          (left, right) => left.sessionRef.localeCompare(right.sessionRef),
        ),
      });
    });
  }

  withActive<T>(sessionRef: string, bearerDigest: string, work: () => Promise<T>): Promise<T> {
    return this.withLock(async () => {
      const session = await this.get(sessionRef);
      if (!session || session.state !== 'active' || session.bearerDigest !== bearerDigest) {
        throw new EditorSessionStateConflictError();
      }
      return work();
    });
  }

  private async withLock<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.lock;
    let release!: () => void;
    this.lock = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private async readSnapshot(): Promise<EditorSessionSnapshotV1> {
    try {
      const raw = await readFile(this.snapshotPath, 'utf8');
      const parsed: unknown = JSON.parse(raw);
      if (!isRecord(parsed) || parsed.schemaVersion !== 1 || !Array.isArray(parsed.sessions)) {
        throw new Error('Invalid editor session snapshot');
      }
      const sessions = parsed.sessions.map(parseStoredSession);
      if (new Set(sessions.map((session) => session.sessionRef)).size !== sessions.length) {
        throw new Error('Duplicate sessionRef in editor session snapshot');
      }
      return { schemaVersion: 1, sessions };
    } catch (error: unknown) {
      if (isErrno(error, 'ENOENT')) return { schemaVersion: 1, sessions: [] };
      throw error;
    }
  }

  private async writeSnapshot(snapshot: EditorSessionSnapshotV1): Promise<void> {
    const directory = dirname(this.snapshotPath);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = join(directory, `.editor-sessions-${process.pid}-${randomUUID()}.tmp`);
    const handle = await open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await rename(temporary, this.snapshotPath);
    } catch (error: unknown) {
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
  }
}

function parseStoredSession(value: unknown): StoredEditorSessionRecordV1 {
  if (!isRecord(value)) throw new Error('Invalid editor session record');
  const sessionRef = requiredString(value.sessionRef, 'sessionRef');
  validateSessionRef(sessionRef);
  const bearerDigest = requiredString(value.bearerDigest, 'bearerDigest');
  if (!/^sha256:[0-9a-f]{64}$/.test(bearerDigest)) throw new Error('Invalid editor session bearerDigest');
  if (!['issued', 'active', 'revoked', 'closed'].includes(String(value.state))) {
    throw new Error('Invalid editor session state');
  }
  if (!isRecord(value.actor) || (value.actor.kind !== 'human' && value.actor.kind !== 'cat')) {
    throw new Error('Invalid editor session actor');
  }
  const actorId = requiredString(value.actor.actorId, 'actor.actorId');
  const revokeReason =
    value.revokeReason === undefined ? undefined : requiredString(value.revokeReason, 'revokeReason');
  const executionLeaseDigest = value.executionLeaseDigest;
  if (
    executionLeaseDigest !== undefined &&
    (typeof executionLeaseDigest !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(executionLeaseDigest))
  ) {
    throw new Error('Invalid editor session executionLeaseDigest');
  }
  return {
    sessionRef,
    bearerDigest: bearerDigest as `sha256:${string}`,
    state: value.state as StoredEditorSessionState,
    contentRef: requiredString(value.contentRef, 'contentRef'),
    actor: { kind: value.actor.kind, actorId },
    ownerRevision: requiredInteger(value.ownerRevision, 'ownerRevision', 0),
    bindingRevision: requiredInteger(value.bindingRevision, 'bindingRevision', 1),
    providerId: requiredString(value.providerId, 'providerId'),
    installationInstanceId: requiredString(value.installationInstanceId, 'installationInstanceId'),
    providerVersion: requiredString(value.providerVersion, 'providerVersion'),
    packageDigest: requiredString(value.packageDigest, 'packageDigest'),
    grantRevision: requiredInteger(value.grantRevision, 'grantRevision', 1),
    lifecycleRevision: requiredInteger(value.lifecycleRevision, 'lifecycleRevision', 1),
    surfaceIntegrity: requiredString(value.surfaceIntegrity, 'surfaceIntegrity'),
    ...(executionLeaseDigest === undefined ? {} : { executionLeaseDigest }),
    ...(revokeReason === undefined ? {} : { revokeReason }),
  };
}

export class EditorSessionStateConflictError extends Error {
  constructor() {
    super('editor session closed, revoked or rotated before effect');
  }
}

function requiredString(value: unknown, field: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 512 ||
    value.trim() !== value ||
    value.includes('\0')
  ) {
    throw new Error(`Invalid editor session ${field}`);
  }
  return value;
}

function requiredInteger(value: unknown, field: string, minimum: number): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum) {
    throw new Error(`Invalid editor session ${field}`);
  }
  return Number(value);
}

function validateSessionRef(value: string): void {
  if (!/^editor-session:[0-9a-f]{64}$/.test(value)) throw new TypeError('sessionRef is invalid');
}

function cloneStoredSession(session: StoredEditorSessionRecordV1): StoredEditorSessionRecordV1 {
  return { ...session, actor: { ...session.actor } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isErrno(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === code;
}
