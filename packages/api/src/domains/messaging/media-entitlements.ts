import { randomBytes } from 'node:crypto';
import { mkdir, open, readFile, rename } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

export type MediaGrantScope =
  | { readonly kind: 'delivery'; readonly deliveryId: string }
  | { readonly kind: 'snapshot'; readonly sessionId: string };

export interface MediaGrantInput {
  readonly instanceId: string;
  readonly scope: MediaGrantScope;
  readonly elementId: string;
  readonly hmrId: string;
  readonly expiresAt?: number;
}

export interface MediaEntitlement {
  readonly grantId: string;
  readonly pluginInstanceId: string;
  readonly scope: MediaGrantScope;
  readonly elementId: string;
  readonly hmrId: string;
  readonly grantedAt: number;
  readonly expiresAt?: number;
  readonly revokedAt?: number;
}

export type MediaAuditEvent =
  | {
      readonly kind: 'grant';
      readonly grantId: string;
      readonly pluginInstanceId: string;
      readonly deliveryId?: string;
      readonly snapshotSessionId?: string;
      readonly elementId: string;
      readonly hmrId: string;
      readonly grantedAt: number;
    }
  | {
      readonly kind: 'revoke';
      readonly grantId: string;
      readonly pluginInstanceId: string;
      readonly deliveryId?: string;
      readonly snapshotSessionId?: string;
      readonly elementId: string;
      readonly hmrId: string;
      readonly grantedAt: number;
      readonly revokedAt: number;
      readonly revokeReason: string;
    };

export interface MediaEntitlementState {
  readonly schemaVersion: 1;
  readonly grants: readonly MediaEntitlement[];
  readonly audit: readonly MediaAuditEvent[];
}

export interface MediaEntitlementPort {
  load(): Promise<MediaEntitlementState>;
  /** Persist grant state and its append-only audit event in one atomic effect. */
  save(state: MediaEntitlementState): Promise<void>;
}

function emptyState(): MediaEntitlementState {
  return { schemaVersion: 1, grants: [], audit: [] };
}

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

type AuditPair = {
  grant?: Extract<MediaAuditEvent, { kind: 'grant' }>;
  revoke?: Extract<MediaAuditEvent, { kind: 'revoke' }>;
};

function indexAudit(audit: readonly MediaAuditEvent[]): Map<string, AuditPair> {
  const events = new Map<string, AuditPair>();
  for (const event of audit) {
    if (!event || (event.kind !== 'grant' && event.kind !== 'revoke') || typeof event.grantId !== 'string') {
      throw new Error('media entitlement audit is corrupt');
    }
    const pair = events.get(event.grantId) ?? {};
    if (event.kind === 'grant') {
      if (pair.grant) throw new Error('media entitlement audit is corrupt');
      pair.grant = event;
    } else {
      if (pair.revoke) throw new Error('media entitlement audit is corrupt');
      pair.revoke = event;
    }
    events.set(event.grantId, pair);
  }
  return events;
}

function grantMatchesAudit(grant: MediaEntitlement, pair: AuditPair | undefined): boolean {
  const issued = pair?.grant;
  if (!issued) return false;
  const scopeMatches =
    issued.deliveryId === (grant.scope?.kind === 'delivery' ? grant.scope.deliveryId : undefined) &&
    issued.snapshotSessionId === (grant.scope?.kind === 'snapshot' ? grant.scope.sessionId : undefined);
  return (
    scopeMatches &&
    issued.pluginInstanceId === grant.pluginInstanceId &&
    issued.hmrId === grant.hmrId &&
    issued.elementId === grant.elementId &&
    issued.grantedAt === grant.grantedAt &&
    (grant.revokedAt === undefined) === (pair?.revoke === undefined) &&
    (pair?.revoke === undefined || pair.revoke.revokedAt === grant.revokedAt)
  );
}

function checkedState(value: MediaEntitlementState): MediaEntitlementState {
  if (value.schemaVersion !== 1 || !Array.isArray(value.grants) || !Array.isArray(value.audit)) {
    throw new Error('media entitlement snapshot is corrupt');
  }
  const events = indexAudit(value.audit);
  const seen = new Set<string>();
  for (const grant of value.grants) {
    if (!grant || typeof grant.grantId !== 'string' || seen.has(grant.grantId)) {
      throw new Error('media entitlement grant is corrupt');
    }
    seen.add(grant.grantId);
    if (!grantMatchesAudit(grant, events.get(grant.grantId))) {
      throw new Error('media entitlement audit is corrupt');
    }
  }
  if (seen.size !== events.size) throw new Error('media entitlement audit is corrupt');
  return value;
}

function sameGrantSlot(grant: MediaEntitlement, input: MediaGrantInput, now: number): boolean {
  if (
    grant.pluginInstanceId !== input.instanceId ||
    grant.scope.kind !== input.scope.kind ||
    grant.elementId !== input.elementId ||
    grant.revokedAt !== undefined ||
    (grant.expiresAt !== undefined && grant.expiresAt <= now)
  )
    return false;
  return grant.scope.kind === 'delivery'
    ? grant.scope.deliveryId === (input.scope as Extract<MediaGrantScope, { kind: 'delivery' }>).deliveryId
    : grant.scope.sessionId === (input.scope as Extract<MediaGrantScope, { kind: 'snapshot' }>).sessionId;
}

function addOrReuseGrant(
  grants: MediaEntitlement[],
  audit: MediaAuditEvent[],
  input: MediaGrantInput,
  grantedAt: number,
): MediaEntitlement {
  const existing = grants.find((grant) => sameGrantSlot(grant, input, grantedAt));
  if (existing) {
    if (existing.hmrId !== input.hmrId || existing.expiresAt !== input.expiresAt) {
      throw new Error('media entitlement scope conflicts with an active grant');
    }
    return existing;
  }
  const grant: MediaEntitlement = {
    grantId: `mg_${randomBytes(16).toString('base64url')}`,
    pluginInstanceId: input.instanceId,
    scope: structuredClone(input.scope),
    elementId: input.elementId,
    hmrId: input.hmrId,
    grantedAt,
    ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }),
  };
  grants.push(grant);
  audit.push({
    kind: 'grant',
    grantId: grant.grantId,
    pluginInstanceId: grant.pluginInstanceId,
    ...(grant.scope.kind === 'delivery'
      ? { deliveryId: grant.scope.deliveryId }
      : { snapshotSessionId: grant.scope.sessionId }),
    elementId: grant.elementId,
    hmrId: grant.hmrId,
    grantedAt,
  });
  return grant;
}

export class MemoryMediaEntitlementPort implements MediaEntitlementPort {
  private state = emptyState();
  failNextSave = false;

  async load(): Promise<MediaEntitlementState> {
    return structuredClone(this.state);
  }

  async save(state: MediaEntitlementState): Promise<void> {
    if (this.failNextSave) {
      this.failNextSave = false;
      throw new Error('entitlement audit persistence failed');
    }
    this.state = structuredClone(state);
  }
}

/** Single-snapshot transaction: grant visibility and append-only audit become durable together. */
export class FileMediaEntitlementPort implements MediaEntitlementPort {
  readonly path: string;

  constructor(path: string) {
    this.path = resolve(path);
  }

  async load(): Promise<MediaEntitlementState> {
    try {
      const value = JSON.parse(await readFile(this.path, 'utf8')) as MediaEntitlementState;
      return checkedState(value);
    } catch (error) {
      if (isMissing(error)) return emptyState();
      throw error;
    }
  }

  async save(state: MediaEntitlementState): Promise<void> {
    const directory = dirname(this.path);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.${randomBytes(8).toString('hex')}.tmp`;
    const handle = await open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(JSON.stringify(state));
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, this.path);
    const dir = await open(directory, 'r');
    try {
      await dir.sync();
    } finally {
      await dir.close();
    }
  }
}

export class MediaEntitlementLedger {
  private pending: Promise<void> = Promise.resolve();
  private writeFailure = false;

  constructor(
    private readonly port: MediaEntitlementPort,
    private readonly clock: { now(): number } = { now: Date.now },
  ) {}

  private async serialize<T>(action: () => Promise<T>): Promise<T> {
    const prior = this.pending;
    let release!: () => void;
    this.pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    await prior;
    try {
      return await action();
    } finally {
      release();
    }
  }

  async grant(input: MediaGrantInput): Promise<MediaEntitlement> {
    const [grant] = await this.grantMany([input]);
    if (!grant) throw new Error('media entitlement grant was not persisted');
    return grant;
  }

  /** One durable audit transaction for a bounded delivery/page, avoiding N snapshot rewrites. */
  async grantMany(inputs: readonly MediaGrantInput[]): Promise<readonly MediaEntitlement[]> {
    return this.serialize(async () => {
      if (this.writeFailure) throw new Error('media entitlement persistence is unavailable');
      const state = await this.port.load();
      const grantedAt = this.clock.now();
      const grants = [...state.grants];
      const audit = [...state.audit];
      const result: MediaEntitlement[] = [];
      for (const input of inputs) {
        result.push(addOrReuseGrant(grants, audit, input, grantedAt));
      }
      if (audit.length === state.audit.length) return result;
      try {
        await this.port.save({ schemaVersion: 1, grants, audit });
      } catch (error) {
        this.writeFailure = true;
        throw error;
      }
      return result;
    });
  }

  async revoke(
    target: { readonly grantId: string } | { readonly scope: MediaGrantScope } | { readonly instanceId: string },
    reason: string,
  ): Promise<void> {
    await this.serialize(async () => {
      const state = await this.port.load();
      const revokedAt = this.clock.now();
      const matches = (grant: MediaEntitlement) =>
        'grantId' in target
          ? grant.grantId === target.grantId
          : 'instanceId' in target
            ? grant.pluginInstanceId === target.instanceId
            : grant.scope.kind === target.scope.kind &&
              (grant.scope.kind === 'delivery'
                ? grant.scope.deliveryId === (target.scope as { readonly deliveryId: string }).deliveryId
                : grant.scope.sessionId === (target.scope as { readonly sessionId: string }).sessionId);
      const affected = state.grants.filter((grant) => grant.revokedAt === undefined && matches(grant));
      if (affected.length === 0) return;
      const grants = state.grants.map((grant) =>
        affected.some((item) => item.grantId === grant.grantId) ? { ...grant, revokedAt } : grant,
      );
      const audit: MediaAuditEvent[] = affected.map((grant) => ({
        kind: 'revoke',
        grantId: grant.grantId,
        pluginInstanceId: grant.pluginInstanceId,
        ...(grant.scope.kind === 'delivery'
          ? { deliveryId: grant.scope.deliveryId }
          : { snapshotSessionId: grant.scope.sessionId }),
        elementId: grant.elementId,
        hmrId: grant.hmrId,
        grantedAt: grant.grantedAt,
        revokedAt,
        revokeReason: reason,
      }));
      try {
        await this.port.save({ schemaVersion: 1, grants, audit: [...state.audit, ...audit] });
      } catch (error) {
        this.writeFailure = true;
        throw error;
      }
    });
  }

  async isEntitled(instanceId: string, hmrId: string): Promise<boolean> {
    if (this.writeFailure) return false;
    const state = await this.port.load();
    const now = this.clock.now();
    return state.grants.some(
      (grant) =>
        grant.pluginInstanceId === instanceId &&
        grant.hmrId === hmrId &&
        grant.revokedAt === undefined &&
        (grant.expiresAt === undefined || grant.expiresAt > now),
    );
  }
}
