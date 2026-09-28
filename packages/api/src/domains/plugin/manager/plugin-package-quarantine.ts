import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { PluginManagerDetail, PluginManagerPackageSource } from '@cat-cafe/shared';
import { PluginInventoryError } from '../host-inventory/types.js';

export const PLUGIN_PACKAGE_QUARANTINE_SCHEMA_VERSION = 1 as const;

export type PluginPackageQuarantineFailureCode =
  | 'PACKAGE_TOO_LARGE'
  | 'PACKAGE_DIGEST_MISMATCH'
  | 'PACKAGE_ID_MISMATCH'
  | 'PACKAGE_VERSION_MISMATCH'
  | 'PACKAGE_PRESENTATION_MISMATCH'
  | 'INVALID_PACKAGE_ARCHIVE'
  | 'UNSUPPORTED_TRANSPORT'
  | 'INVALID_PACKAGE_SCHEMA'
  | 'INVALID_MANIFEST'
  | 'CONTRACT_VERSION_MISMATCH'
  | 'INVALID_GRANT';

const inventoryQuarantineFailureCodes = new Set<PluginPackageQuarantineFailureCode>([
  'INVALID_MANIFEST',
  'CONTRACT_VERSION_MISMATCH',
  'INVALID_GRANT',
]);

export function quarantineFailureCodeFromInventoryError(
  error: unknown,
): PluginPackageQuarantineFailureCode | undefined {
  if (!(error instanceof PluginInventoryError)) return undefined;
  const code = error.code as PluginPackageQuarantineFailureCode;
  return inventoryQuarantineFailureCodes.has(code) ? code : undefined;
}

export type PluginPackageQuarantineSource =
  | {
      readonly kind: 'catalog';
      readonly catalogId: string;
      readonly packageName: string;
    }
  | { readonly kind: 'local-directory' | 'local-archive' };

export interface PluginPackageQuarantineRecord {
  readonly pluginId: string;
  readonly displayName: string;
  readonly availableVersion: string | null;
  readonly packageDigest: string;
  readonly source: PluginPackageQuarantineSource;
  readonly failure: {
    readonly code: PluginPackageQuarantineFailureCode;
    readonly message: string;
  };
  readonly revision: number;
  readonly createdAt: number;
  readonly updatedAt: number;
}

interface PluginPackageQuarantineSnapshot {
  readonly schemaVersion: typeof PLUGIN_PACKAGE_QUARANTINE_SCHEMA_VERSION;
  readonly records: readonly PluginPackageQuarantineRecord[];
}

export interface RecordPluginPackageQuarantineInput {
  readonly pluginId?: string;
  readonly displayName?: string;
  readonly availableVersion?: string;
  readonly packageDigest: string;
  readonly source: PluginPackageQuarantineSource;
  readonly failureCode: PluginPackageQuarantineFailureCode;
}

export interface PluginPackageQuarantineRecorder {
  record(input: RecordPluginPackageQuarantineInput): Promise<PluginPackageQuarantineRecord>;
}

export type PluginPackageQuarantineStoreErrorCode =
  | 'CORRUPT_SNAPSHOT'
  | 'INVALID_RECORD'
  | 'NOT_FOUND'
  | 'STALE_REVISION';

export class PluginPackageQuarantineStoreError extends Error {
  constructor(
    readonly code: PluginPackageQuarantineStoreErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'PluginPackageQuarantineStoreError';
  }
}

const failureMessages = {
  PACKAGE_TOO_LARGE: 'Plugin package exceeds the Host size limit.',
  PACKAGE_DIGEST_MISMATCH: 'Plugin package bytes do not match the expected digest.',
  PACKAGE_ID_MISMATCH: 'Plugin package identity does not match its source.',
  PACKAGE_VERSION_MISMATCH: 'Plugin package version does not match its source.',
  PACKAGE_PRESENTATION_MISMATCH: 'Plugin package presentation does not match its source.',
  INVALID_PACKAGE_ARCHIVE: 'Plugin package archive failed Host verification.',
  UNSUPPORTED_TRANSPORT: 'Plugin package requests an unsupported runtime transport.',
  INVALID_PACKAGE_SCHEMA: 'Plugin package contains an invalid declared schema.',
  INVALID_MANIFEST: 'Plugin package manifest failed Host validation.',
  CONTRACT_VERSION_MISMATCH: 'Plugin package requires an unsupported contract version.',
  INVALID_GRANT: 'Plugin package requests invalid authority.',
} as const satisfies Record<PluginPackageQuarantineFailureCode, string>;

const failureCodes = new Set<PluginPackageQuarantineFailureCode>(
  Object.keys(failureMessages) as PluginPackageQuarantineFailureCode[],
);

function isCanonicalDigest(value: string): boolean {
  if (!/^sha512-[A-Za-z0-9+/]{86}==$/.test(value)) return false;
  const encoded = value.slice('sha512-'.length);
  const bytes = Buffer.from(encoded, 'base64');
  return bytes.byteLength === 64 && bytes.toString('base64') === encoded;
}

function syntheticPluginId(packageDigest: string): string {
  return `rejected-${createHash('sha256').update(packageDigest).digest('hex').slice(0, 24)}`;
}

function validPluginId(value: string): boolean {
  return /^[a-z0-9][a-z0-9._-]{0,127}$/.test(value);
}

function validBoundedString(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum;
}

function parseSource(value: unknown): PluginPackageQuarantineSource {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new PluginPackageQuarantineStoreError('CORRUPT_SNAPSHOT', 'quarantine source must be an object');
  }
  const raw = value as Record<string, unknown>;
  if (raw.kind === 'catalog') {
    if (!validBoundedString(raw.catalogId, 128) || !validBoundedString(raw.packageName, 256)) {
      throw new PluginPackageQuarantineStoreError('CORRUPT_SNAPSHOT', 'catalog quarantine source is invalid');
    }
    return { kind: 'catalog', catalogId: raw.catalogId, packageName: raw.packageName };
  }
  if (raw.kind === 'local-directory' || raw.kind === 'local-archive') return { kind: raw.kind };
  throw new PluginPackageQuarantineStoreError('CORRUPT_SNAPSHOT', 'quarantine source kind is invalid');
}

function parseRecord(value: unknown): PluginPackageQuarantineRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new PluginPackageQuarantineStoreError('CORRUPT_SNAPSHOT', 'quarantine record must be an object');
  }
  const raw = value as Record<string, unknown>;
  if (
    !validBoundedString(raw.pluginId, 128) ||
    !validPluginId(raw.pluginId) ||
    !validBoundedString(raw.displayName, 256) ||
    (raw.availableVersion !== null && !validBoundedString(raw.availableVersion, 128)) ||
    typeof raw.packageDigest !== 'string' ||
    !isCanonicalDigest(raw.packageDigest) ||
    typeof raw.revision !== 'number' ||
    !Number.isSafeInteger(raw.revision) ||
    raw.revision < 1 ||
    typeof raw.createdAt !== 'number' ||
    !Number.isSafeInteger(raw.createdAt) ||
    raw.createdAt < 0 ||
    typeof raw.updatedAt !== 'number' ||
    !Number.isSafeInteger(raw.updatedAt) ||
    raw.updatedAt < raw.createdAt ||
    !raw.failure ||
    typeof raw.failure !== 'object' ||
    Array.isArray(raw.failure)
  ) {
    throw new PluginPackageQuarantineStoreError('CORRUPT_SNAPSHOT', 'quarantine record is invalid');
  }
  const failure = raw.failure as Record<string, unknown>;
  if (typeof failure.code !== 'string' || !failureCodes.has(failure.code as PluginPackageQuarantineFailureCode)) {
    throw new PluginPackageQuarantineStoreError('CORRUPT_SNAPSHOT', 'quarantine failure code is invalid');
  }
  const code = failure.code as PluginPackageQuarantineFailureCode;
  if (failure.message !== failureMessages[code]) {
    throw new PluginPackageQuarantineStoreError('CORRUPT_SNAPSHOT', 'quarantine failure message is not canonical');
  }
  return {
    pluginId: raw.pluginId,
    displayName: raw.displayName,
    availableVersion: raw.availableVersion as string | null,
    packageDigest: raw.packageDigest,
    source: parseSource(raw.source),
    failure: { code, message: failureMessages[code] },
    revision: raw.revision,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
  };
}

function parseSnapshot(value: unknown): PluginPackageQuarantineSnapshot {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new PluginPackageQuarantineStoreError('CORRUPT_SNAPSHOT', 'quarantine snapshot must be an object');
  }
  const raw = value as Record<string, unknown>;
  if (raw.schemaVersion !== PLUGIN_PACKAGE_QUARANTINE_SCHEMA_VERSION || !Array.isArray(raw.records)) {
    throw new PluginPackageQuarantineStoreError('CORRUPT_SNAPSHOT', 'quarantine snapshot schema is unsupported');
  }
  const records = raw.records.map(parseRecord);
  if (new Set(records.map((record) => record.pluginId)).size !== records.length) {
    throw new PluginPackageQuarantineStoreError('CORRUPT_SNAPSHOT', 'quarantine plugin identities are not unique');
  }
  return { schemaVersion: PLUGIN_PACKAGE_QUARANTINE_SCHEMA_VERSION, records };
}

function emptySnapshot(): PluginPackageQuarantineSnapshot {
  return { schemaVersion: PLUGIN_PACKAGE_QUARANTINE_SCHEMA_VERSION, records: [] };
}

class TransactionQueue {
  private tail: Promise<void> = Promise.resolve();

  async run<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.tail;
    let release = () => {};
    this.tail = new Promise<void>((resolveTail) => {
      release = resolveTail;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  async settled(): Promise<void> {
    await this.tail;
  }
}

const queues = new Map<string, TransactionQueue>();

function queueFor(path: string): TransactionQueue {
  let queue = queues.get(path);
  if (!queue) {
    queue = new TransactionQueue();
    queues.set(path, queue);
  }
  return queue;
}

function notFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

export interface FilePluginPackageQuarantineStoreOptions {
  readonly now?: () => number;
}

export class FilePluginPackageQuarantineStore implements PluginPackageQuarantineRecorder {
  readonly path: string;
  private readonly queue: TransactionQueue;

  constructor(
    path: string,
    private readonly options: FilePluginPackageQuarantineStoreOptions = {},
  ) {
    this.path = resolve(path);
    this.queue = queueFor(this.path);
  }

  private async load(): Promise<PluginPackageQuarantineSnapshot> {
    try {
      return parseSnapshot(JSON.parse(await readFile(this.path, 'utf8')));
    } catch (error) {
      if (notFound(error)) return emptySnapshot();
      if (error instanceof PluginPackageQuarantineStoreError) throw error;
      throw new PluginPackageQuarantineStoreError('CORRUPT_SNAPSHOT', 'quarantine snapshot is not valid JSON');
    }
  }

  private async commit(snapshot: PluginPackageQuarantineSnapshot): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const temporaryPath = `${this.path}.tmp-${process.pid}-${randomUUID()}`;
    await writeFile(temporaryPath, `${JSON.stringify(snapshot, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    try {
      await rename(temporaryPath, this.path);
    } catch (error) {
      await unlink(temporaryPath).catch(() => undefined);
      throw error;
    }
  }

  async list(): Promise<readonly PluginPackageQuarantineRecord[]> {
    await this.queue.settled();
    return structuredClone((await this.load()).records);
  }

  async record(input: RecordPluginPackageQuarantineInput): Promise<PluginPackageQuarantineRecord> {
    if (!isCanonicalDigest(input.packageDigest)) {
      throw new PluginPackageQuarantineStoreError('INVALID_RECORD', 'quarantine digest must be canonical');
    }
    const pluginId = input.pluginId ?? syntheticPluginId(input.packageDigest);
    if (!validPluginId(pluginId)) {
      throw new PluginPackageQuarantineStoreError('INVALID_RECORD', 'quarantine plugin identity is invalid');
    }
    const displayName = input.displayName ?? 'Rejected local plugin package';
    if (!validBoundedString(displayName, 256)) {
      throw new PluginPackageQuarantineStoreError('INVALID_RECORD', 'quarantine display name is invalid');
    }
    if (input.availableVersion !== undefined && !validBoundedString(input.availableVersion, 128)) {
      throw new PluginPackageQuarantineStoreError('INVALID_RECORD', 'quarantine version is invalid');
    }
    if (!failureCodes.has(input.failureCode)) {
      throw new PluginPackageQuarantineStoreError('INVALID_RECORD', 'quarantine failure code is invalid');
    }
    let source: PluginPackageQuarantineSource;
    try {
      source = parseSource(input.source);
    } catch {
      throw new PluginPackageQuarantineStoreError('INVALID_RECORD', 'quarantine source is invalid');
    }
    return this.queue.run(async () => {
      const snapshot = await this.load();
      const existing = snapshot.records.find((record) => record.pluginId === pluginId);
      const now = this.options.now?.() ?? Date.now();
      const record: PluginPackageQuarantineRecord = {
        pluginId,
        displayName,
        availableVersion: input.availableVersion ?? null,
        packageDigest: input.packageDigest,
        source,
        failure: { code: input.failureCode, message: failureMessages[input.failureCode] },
        revision: (existing?.revision ?? 0) + 1,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      };
      const records = snapshot.records.filter((candidate) => candidate.pluginId !== pluginId);
      records.push(record);
      await this.commit({ schemaVersion: PLUGIN_PACKAGE_QUARANTINE_SCHEMA_VERSION, records });
      return structuredClone(record);
    });
  }

  async remove(pluginId: string, expectedRevision: number): Promise<void> {
    return this.queue.run(async () => {
      const snapshot = await this.load();
      const record = snapshot.records.find((candidate) => candidate.pluginId === pluginId);
      if (!record) throw new PluginPackageQuarantineStoreError('NOT_FOUND', `unknown quarantine ${pluginId}`);
      if (record.revision !== expectedRevision) {
        throw new PluginPackageQuarantineStoreError(
          'STALE_REVISION',
          `expected quarantine revision ${expectedRevision}, current ${record.revision}`,
        );
      }
      await this.commit({
        schemaVersion: PLUGIN_PACKAGE_QUARANTINE_SCHEMA_VERSION,
        records: snapshot.records.filter((candidate) => candidate.pluginId !== pluginId),
      });
    });
  }
}

function managerSource(source: PluginPackageQuarantineSource): PluginManagerPackageSource {
  return source.kind === 'catalog'
    ? {
        kind: 'catalog',
        catalogId: source.catalogId,
        packageName: source.packageName,
        trust: 'official',
      }
    : { kind: source.kind, packageName: null, trust: 'local-trusted' };
}

function managerDetail(record: PluginPackageQuarantineRecord): PluginManagerDetail {
  return {
    pluginId: record.pluginId,
    pluginInstanceId: null,
    displayName: record.displayName,
    source: managerSource(record.source),
    availableVersion: record.availableVersion,
    installedVersion: null,
    packageDigest: record.packageDigest,
    artifact: 'quarantined',
    config: 'invalid',
    auth: 'not-required',
    intent: 'disabled',
    live: 'stopped',
    lifecycleRevision: record.revision,
    capabilitySummary: [],
    actions: {
      install: false,
      setEnabled: false,
      uninstall: true,
      blockingReasons: ['package-quarantined'],
    },
    diagnostic: {
      code: record.failure.code,
      message: record.failure.message,
      occurredAt: record.updatedAt,
      revision: record.revision,
    },
    capabilities: [],
    configFields: [],
  };
}

export class PluginPackageQuarantineManagerAdapter {
  constructor(private readonly store: FilePluginPackageQuarantineStore) {}

  async list(): Promise<readonly PluginManagerDetail[]> {
    return (await this.store.list()).map(managerDetail);
  }

  remove(pluginId: string, expectedRevision: number): Promise<void> {
    return this.store.remove(pluginId, expectedRevision);
  }
}
