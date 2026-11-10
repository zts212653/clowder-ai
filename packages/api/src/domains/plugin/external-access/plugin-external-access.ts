import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { PluginInventoryStore } from '../host-inventory/ports.js';

export interface PluginExternalAccessRecord {
  readonly instanceId: string;
  readonly token: string;
}

export interface PluginExternalAccessStore {
  find(instanceId: string): Promise<PluginExternalAccessRecord | undefined>;
  adopt(instanceId: string, token: string, assertAuthority?: () => Promise<void>): Promise<PluginExternalAccessRecord>;
  resolve(token: string): Promise<string | undefined>;
  revoke(instanceId: string, expectedToken?: string): Promise<void>;
}

function tokenDigest(token: string): Buffer {
  return createHash('sha256').update(token).digest();
}

function tokenMatches(left: string, right: string): boolean {
  return timingSafeEqual(tokenDigest(left), tokenDigest(right));
}

export class MemoryPluginExternalAccessStore implements PluginExternalAccessStore {
  protected readonly records = new Map<string, string>();

  async find(instanceId: string): Promise<PluginExternalAccessRecord | undefined> {
    const token = this.records.get(instanceId);
    return token === undefined ? undefined : { instanceId, token };
  }

  async adopt(
    instanceId: string,
    token: string,
    assertAuthority?: () => Promise<void>,
  ): Promise<PluginExternalAccessRecord> {
    assertToken(token);
    await assertAuthority?.();
    const existing = this.records.get(instanceId);
    if (existing !== undefined && !tokenMatches(existing, token)) {
      throw new Error('Plugin instance already has an external access token');
    }
    for (const [owner, candidate] of this.records) {
      if (owner !== instanceId && tokenMatches(candidate, token)) {
        throw new Error('External access token already belongs to another plugin instance');
      }
    }
    this.records.set(instanceId, token);
    return { instanceId, token };
  }

  async resolve(token: string): Promise<string | undefined> {
    for (const [instanceId, candidate] of this.records) {
      if (tokenMatches(candidate, token)) return instanceId;
    }
    return undefined;
  }

  async revoke(instanceId: string, expectedToken?: string): Promise<void> {
    const existing = this.records.get(instanceId);
    if (expectedToken !== undefined && (existing === undefined || !tokenMatches(existing, expectedToken))) return;
    this.records.delete(instanceId);
  }
}

interface StoredExternalAccess {
  readonly schemaVersion: 1;
  readonly records: readonly PluginExternalAccessRecord[];
}

const fileQueues = new Map<string, Promise<void>>();

function queueFile<T>(path: string, operation: () => Promise<T>): Promise<T> {
  const previous = fileQueues.get(path) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(operation);
  const settled = current.then(
    () => undefined,
    () => undefined,
  );
  fileQueues.set(path, settled);
  settled.finally(() => {
    if (fileQueues.get(path) === settled) fileQueues.delete(path);
  });
  return current;
}

export class FilePluginExternalAccessStore implements PluginExternalAccessStore {
  constructor(private readonly path: string) {}

  async find(instanceId: string): Promise<PluginExternalAccessRecord | undefined> {
    return queueFile(this.path, async () => {
      const token = (await this.readRecords()).get(instanceId);
      return token === undefined ? undefined : { instanceId, token };
    });
  }

  async adopt(
    instanceId: string,
    token: string,
    assertAuthority?: () => Promise<void>,
  ): Promise<PluginExternalAccessRecord> {
    assertToken(token);
    return queueFile(this.path, async () => {
      const records = await this.readRecords();
      await assertAuthority?.();
      const existing = records.get(instanceId);
      if (existing !== undefined && !tokenMatches(existing, token)) {
        throw new Error('Plugin instance already has an external access token');
      }
      for (const [owner, candidate] of records) {
        if (owner !== instanceId && tokenMatches(candidate, token)) {
          throw new Error('External access token already belongs to another plugin instance');
        }
      }
      records.set(instanceId, token);
      await this.writeRecords(records);
      return { instanceId, token };
    });
  }

  async resolve(token: string): Promise<string | undefined> {
    return queueFile(this.path, async () => {
      for (const [instanceId, candidate] of await this.readRecords()) {
        if (tokenMatches(candidate, token)) return instanceId;
      }
      return undefined;
    });
  }

  async revoke(instanceId: string, expectedToken?: string): Promise<void> {
    return queueFile(this.path, async () => {
      const records = await this.readRecords();
      const existing = records.get(instanceId);
      if (expectedToken !== undefined && (existing === undefined || !tokenMatches(existing, expectedToken))) return;
      if (!records.delete(instanceId)) return;
      await this.writeRecords(records);
    });
  }

  private async readRecords(): Promise<Map<string, string>> {
    let raw: string;
    try {
      raw = await readFile(this.path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return new Map();
      throw error;
    }
    const parsed = JSON.parse(raw) as Partial<StoredExternalAccess>;
    if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.records)) {
      throw new Error('Invalid plugin external access store');
    }
    const records = new Map<string, string>();
    const tokens: string[] = [];
    for (const record of parsed.records) {
      if (
        typeof record !== 'object' ||
        record === null ||
        typeof record.instanceId !== 'string' ||
        typeof record.token !== 'string' ||
        record.instanceId.length === 0 ||
        record.token.length === 0 ||
        records.has(record.instanceId) ||
        tokens.some((candidate) => tokenMatches(candidate, record.token))
      ) {
        throw new Error('Invalid plugin external access store record');
      }
      records.set(record.instanceId, record.token);
      tokens.push(record.token);
    }
    return records;
  }

  private async writeRecords(records: ReadonlyMap<string, string>): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const tempPath = `${this.path}.${randomUUID()}.tmp`;
    const payload: StoredExternalAccess = {
      schemaVersion: 1,
      records: [...records].map(([instanceId, token]) => ({ instanceId, token })),
    };
    await writeFile(tempPath, `${JSON.stringify(payload, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    await rename(tempPath, this.path);
  }
}

export class PluginExternalAccessError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

export class PluginExternalAccessService {
  constructor(
    private readonly options: {
      readonly endpoint: string;
      readonly upstreamLoopbackOrigin?: string;
      readonly now?: () => number;
      readonly store: PluginExternalAccessStore;
      readonly inventory: Pick<PluginInventoryStore, 'snapshot'>;
      readonly handler: {
        handle(instanceId: string, request: Readonly<Record<string, unknown>>): Promise<unknown>;
      };
    },
  ) {}

  /** Existing-record projection for the migration seam; ordinary module startup never mints a raw token. */
  async legacyAccess(instanceId: string): Promise<{ readonly endpoint: string; readonly token: string }> {
    const instance = await this.currentInstance(instanceId);
    if (instance === undefined) throw new PluginExternalAccessError(404, 'Plugin instance is not current');
    const record = await this.options.store.find(instanceId);
    return record ? { endpoint: this.options.endpoint, token: record.token } : { endpoint: '', token: '' };
  }

  /** Internal migration seam: preserve one already-issued installation credential. */
  async adopt(instanceId: string, token: string, assertAuthority?: () => Promise<void>): Promise<void> {
    const instance = await this.currentInstance(instanceId);
    if (instance === undefined) throw new PluginExternalAccessError(404, 'Plugin instance is not current');
    await this.options.store.adopt(instanceId, token, assertAuthority);
  }

  /** Retire only the old bearer being revalidated, never a replacement credential. */
  async revokeLegacy(instanceId: string, token: string): Promise<void> {
    await this.options.store.revoke(instanceId, token);
  }

  async handle(token: string, request: Readonly<Record<string, unknown>>): Promise<unknown> {
    const instanceId = await this.options.store.resolve(token);
    if (instanceId === undefined) throw new PluginExternalAccessError(401, 'Invalid plugin access token');
    const instance = await this.currentInstance(instanceId);
    if (instance === undefined) throw new PluginExternalAccessError(401, 'Plugin instance is not current');
    if (instance.activationState !== 'enabled') {
      throw new PluginExternalAccessError(409, 'Plugin instance is not enabled');
    }
    if (instance.runtimeState !== 'healthy' && instance.runtimeState !== 'degraded') {
      throw new PluginExternalAccessError(409, 'Plugin runtime is not available');
    }
    return this.options.handler.handle(instanceId, request);
  }

  private async currentInstance(instanceId: string) {
    const snapshot = await this.options.inventory.snapshot();
    return snapshot.instances.find(
      (candidate) => candidate.pluginInstanceId === instanceId && candidate.lifecycleState === 'installed',
    );
  }
}

function assertToken(token: string): void {
  if (token.length === 0 || token.length > 512 || /\s/.test(token)) {
    throw new Error('Invalid plugin external access token');
  }
}
