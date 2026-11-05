import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  FilePluginCapabilityKeyring,
  type PluginCapabilityClaims,
  PluginCapabilityTokenError,
} from '../capability-token/plugin-capability-token.js';
import type { PluginInventoryStore } from '../host-inventory/ports.js';

export const PLUGIN_EXTERNAL_REQUEST_PATH = '/api/plugin-runtime/handle';

export interface PluginExternalAccessRecord {
  readonly instanceId: string;
  readonly token: string;
}

export interface PluginExternalAccessStore {
  find(instanceId: string): Promise<PluginExternalAccessRecord | undefined>;
  ensure(instanceId: string): Promise<PluginExternalAccessRecord>;
  adopt(instanceId: string, token: string): Promise<PluginExternalAccessRecord>;
  resolve(token: string): Promise<string | undefined>;
  rotate(instanceId: string): Promise<PluginExternalAccessRecord>;
  revoke(instanceId: string): Promise<void>;
}

export interface PluginExternalAccessStoreOptions {
  readonly generateToken?: () => string;
}

function defaultToken(): string {
  return `cpa_${randomBytes(32).toString('base64url')}`;
}

function tokenDigest(token: string): Buffer {
  return createHash('sha256').update(token).digest();
}

function tokenMatches(left: string, right: string): boolean {
  return timingSafeEqual(tokenDigest(left), tokenDigest(right));
}

export class MemoryPluginExternalAccessStore implements PluginExternalAccessStore {
  protected readonly records = new Map<string, string>();
  protected readonly generateToken: () => string;

  constructor(options: PluginExternalAccessStoreOptions = {}) {
    this.generateToken = options.generateToken ?? defaultToken;
  }

  async find(instanceId: string): Promise<PluginExternalAccessRecord | undefined> {
    const token = this.records.get(instanceId);
    return token === undefined ? undefined : { instanceId, token };
  }

  async ensure(instanceId: string): Promise<PluginExternalAccessRecord> {
    const existing = this.records.get(instanceId);
    if (existing !== undefined) return { instanceId, token: existing };
    return this.rotate(instanceId);
  }

  async adopt(instanceId: string, token: string): Promise<PluginExternalAccessRecord> {
    assertToken(token);
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

  async rotate(instanceId: string): Promise<PluginExternalAccessRecord> {
    const token = this.generateToken();
    this.records.set(instanceId, token);
    return { instanceId, token };
  }

  async revoke(instanceId: string): Promise<void> {
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
  private readonly generateToken: () => string;

  constructor(
    private readonly path: string,
    options: PluginExternalAccessStoreOptions = {},
  ) {
    this.generateToken = options.generateToken ?? defaultToken;
  }

  async find(instanceId: string): Promise<PluginExternalAccessRecord | undefined> {
    return queueFile(this.path, async () => {
      const token = (await this.readRecords()).get(instanceId);
      return token === undefined ? undefined : { instanceId, token };
    });
  }

  async ensure(instanceId: string): Promise<PluginExternalAccessRecord> {
    return queueFile(this.path, async () => {
      const records = await this.readRecords();
      const existing = records.get(instanceId);
      if (existing !== undefined) return { instanceId, token: existing };
      const token = this.generateToken();
      records.set(instanceId, token);
      await this.writeRecords(records);
      return { instanceId, token };
    });
  }

  async adopt(instanceId: string, token: string): Promise<PluginExternalAccessRecord> {
    assertToken(token);
    return queueFile(this.path, async () => {
      const records = await this.readRecords();
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

  async rotate(instanceId: string): Promise<PluginExternalAccessRecord> {
    return queueFile(this.path, async () => {
      const records = await this.readRecords();
      const token = this.generateToken();
      records.set(instanceId, token);
      await this.writeRecords(records);
      return { instanceId, token };
    });
  }

  async revoke(instanceId: string): Promise<void> {
    return queueFile(this.path, async () => {
      const records = await this.readRecords();
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
      readonly tokens?: FilePluginCapabilityKeyring;
      readonly inventory: Pick<PluginInventoryStore, 'snapshot'>;
      readonly handler: {
        handle(
          instanceId: string,
          request: Readonly<Record<string, unknown>>,
          credential?: Readonly<Pick<PluginCapabilityClaims, 'sub' | 'cap' | 'jti' | 'iat' | 'exp'>>,
        ): Promise<unknown>;
      };
    },
  ) {}

  async access(instanceId: string): Promise<{ readonly endpoint: string; readonly token: string }> {
    const instance = await this.currentInstance(instanceId);
    if (instance === undefined) throw new PluginExternalAccessError(404, 'Plugin instance is not current');
    const record = await this.options.store.ensure(instanceId);
    return { endpoint: this.options.endpoint, token: record.token };
  }

  /** Existing-record projection for the migration seam; ordinary module startup never mints a raw token. */
  async legacyAccess(instanceId: string): Promise<{ readonly endpoint: string; readonly token: string }> {
    const instance = await this.currentInstance(instanceId);
    if (instance === undefined) throw new PluginExternalAccessError(404, 'Plugin instance is not current');
    const record = await this.options.store.find(instanceId);
    return record ? { endpoint: this.options.endpoint, token: record.token } : { endpoint: '', token: '' };
  }

  async issueExternal(
    instanceId: string,
    input: { readonly capabilityId: string; readonly ttlSeconds: number },
  ): Promise<{
    readonly token: string;
    readonly tokenId: string;
    readonly issuedAt: number;
    readonly expiresAt: number;
    readonly refreshRecommendedAt: number;
    readonly forwarding: {
      readonly upstreamLoopbackOrigin: string;
      readonly relativePath: string;
      readonly method: 'POST';
    };
  }> {
    const tokens = this.options.tokens;
    if (!tokens) throw new PluginExternalAccessError(503, 'Plugin capability tokens are unavailable');
    await this.currentCapability(instanceId, input.capabilityId);
    const issued = await tokens.issueExternal({
      instanceId,
      capabilityId: input.capabilityId,
      ttlSeconds: input.ttlSeconds,
    });
    const endpoint = new URL(this.options.endpoint, 'http://clowder.invalid');
    return {
      token: issued.token,
      tokenId: issued.tokenId,
      issuedAt: issued.issuedAt,
      expiresAt: issued.expiresAt,
      refreshRecommendedAt: issued.refreshRecommendedAt,
      forwarding: {
        upstreamLoopbackOrigin: this.options.upstreamLoopbackOrigin ?? '',
        relativePath: endpoint.pathname,
        method: 'POST',
      },
    };
  }

  async inspectExternal(
    instanceId: string,
    input: { readonly token: string; readonly capabilityId: string },
  ): Promise<{
    readonly usable: boolean;
    readonly reason: string;
    readonly expiresAt?: number;
    readonly remainingSeconds?: number;
    readonly refreshRecommended: boolean;
  }> {
    try {
      const tokens = this.options.tokens;
      if (!tokens) throw new PluginExternalAccessError(503, 'Plugin capability tokens are unavailable');
      const claims = await tokens.verifyExternal(input.token, {
        instanceId,
        capabilityId: input.capabilityId,
      });
      await this.currentCapability(instanceId, input.capabilityId, true);
      const now = Math.floor((this.options.now ?? Date.now)() / 1_000);
      const remainingSeconds = Math.max(0, claims.exp - now);
      return {
        usable: true,
        reason: 'usable',
        expiresAt: claims.exp,
        remainingSeconds,
        refreshRecommended: remainingSeconds <= 30 * 24 * 60 * 60,
      };
    } catch (error) {
      return {
        usable: false,
        reason:
          error instanceof PluginCapabilityTokenError
            ? error.code.toLowerCase()
            : error instanceof PluginExternalAccessError
              ? error.message
              : 'token_unavailable',
        refreshRecommended: true,
      };
    }
  }

  /** Internal migration seam: preserve one already-issued installation credential. */
  async adopt(instanceId: string, token: string): Promise<void> {
    const instance = await this.currentInstance(instanceId);
    if (instance === undefined) throw new PluginExternalAccessError(404, 'Plugin instance is not current');
    await this.options.store.adopt(instanceId, token);
  }

  async handle(token: string, request: Readonly<Record<string, unknown>>): Promise<unknown> {
    let instanceId: string | undefined;
    let credential: PluginCapabilityClaims | undefined;
    if (token.split('.').length === 3 && this.options.tokens) {
      try {
        credential = await this.options.tokens.verifyExternalToken(token);
        instanceId = credential.sub;
        await this.currentCapability(instanceId, credential.cap, true);
      } catch (error) {
        if (error instanceof PluginCapabilityTokenError) {
          throw new PluginExternalAccessError(401, 'Invalid plugin access token');
        }
        throw error;
      }
    } else {
      instanceId = await this.options.store.resolve(token);
    }
    if (instanceId === undefined) throw new PluginExternalAccessError(401, 'Invalid plugin access token');
    const instance = await this.currentInstance(instanceId);
    if (instance === undefined) throw new PluginExternalAccessError(401, 'Plugin instance is not current');
    if (instance.activationState !== 'enabled') {
      throw new PluginExternalAccessError(409, 'Plugin instance is not enabled');
    }
    if (instance.runtimeState !== 'healthy' && instance.runtimeState !== 'degraded') {
      throw new PluginExternalAccessError(409, 'Plugin runtime is not available');
    }
    const response = await this.options.handler.handle(
      instanceId,
      request,
      credential && {
        sub: credential.sub,
        cap: credential.cap,
        jti: credential.jti,
        iat: credential.iat,
        exp: credential.exp,
      },
    );
    if (credential && typeof response === 'object' && response !== null && 'hostEffects' in response) {
      const effect = (
        response as {
          hostEffects?: { retireLegacyCredential?: { tokenId?: unknown } };
        }
      ).hostEffects?.retireLegacyCredential;
      if (effect?.tokenId !== credential.jti) {
        throw new PluginExternalAccessError(502, 'Plugin returned an invalid credential transition');
      }
      await this.options.store.revoke(instanceId);
      const { hostEffects: _hostEffects, ...publicResponse } = response as Record<string, unknown>;
      return publicResponse;
    }
    return response;
  }

  private async currentInstance(instanceId: string) {
    const snapshot = await this.options.inventory.snapshot();
    return snapshot.instances.find(
      (candidate) => candidate.pluginInstanceId === instanceId && candidate.lifecycleState === 'installed',
    );
  }

  private async currentCapability(instanceId: string, capabilityId: string, requireRuntime = false) {
    const snapshot = await this.options.inventory.snapshot();
    const instance = snapshot.instances.find(
      (candidate) => candidate.pluginInstanceId === instanceId && candidate.lifecycleState === 'installed',
    );
    if (!instance) throw new PluginExternalAccessError(404, 'Plugin instance is not current');
    if (requireRuntime) {
      if (instance.activationState !== 'enabled')
        throw new PluginExternalAccessError(409, 'Plugin instance is not enabled');
      if (instance.runtimeState !== 'healthy' && instance.runtimeState !== 'degraded') {
        throw new PluginExternalAccessError(409, 'Plugin runtime is not available');
      }
    }
    const manifest = snapshot.packages.find((item) => item.packageDigest === instance.packageDigest)?.manifest;
    const declared =
      manifest?.contributions?.some((contribution) => {
        const candidate = contribution as Readonly<{ type?: unknown; id?: unknown }>;
        return candidate.type === 'external-request' && candidate.id === capabilityId;
      }) ?? false;
    if (!declared) throw new PluginExternalAccessError(403, 'Plugin capability is not declared');
    return { instance, manifest };
  }
}

function assertToken(token: string): void {
  if (token.length === 0 || token.length > 512 || /\s/.test(token)) {
    throw new Error('Invalid plugin external access token');
  }
}
