import { type RoutingSignalEventV1, type RoutingSubjectRefV1, routingSignalEventV1Schema } from '@cat-cafe/shared';
import type { RedisClient } from '@cat-cafe/shared/utils';
import {
  advanceRoutingSignalDecisionProjection,
  advanceRoutingSignalDecisionProjectionSequence,
  buildRoutingSignalDecisionProjection,
  parseRoutingSignalDecisionProjection,
  type RoutingSignalDecisionProjectionV1,
} from './preflight/RoutingSignalDecisionProjection.js';
import {
  APPEND_ROUTING_SIGNAL_EVENT_LUA,
  RoutingSignalEventKeys,
  STORE_ROUTING_SIGNAL_DECISION_PROJECTION_LUA,
} from './RedisRoutingSignalPersistence.js';
import {
  type IRoutingSignalEventStore,
  type RoutingSignalEventAppendResult,
  RoutingSignalEventConflictError,
  RoutingSignalEventHydrationError,
} from './RoutingSignalEventStore.js';

const MAX_HOT_OWNERS = 256;

export { RoutingSignalEventKeys } from './RedisRoutingSignalPersistence.js';

export class RedisRoutingSignalEventStore implements IRoutingSignalEventStore {
  private readonly ownerRevisionCache = new Map<string, number>();
  private readonly decisionProjectionCache = new Map<string, RoutingSignalDecisionProjectionV1>();
  private readonly decisionProjectionLoads = new Map<string, Promise<RoutingSignalDecisionProjectionV1>>();

  constructor(private readonly redis: RedisClient) {}

  async append(eventInput: RoutingSignalEventV1): Promise<RoutingSignalEventAppendResult> {
    const event = routingSignalEventV1Schema.parse(eventInput);
    const raw = JSON.stringify(event);
    const closesSignalIds = event.eventType === 'asserted' ? [] : event.closesSignalIds;
    const keys = [
      RoutingSignalEventKeys.command(event.ownerId, event.commandId),
      RoutingSignalEventKeys.detail(event.ownerId, event.eventId),
      RoutingSignalEventKeys.ownerTimeline(event.ownerId),
      RoutingSignalEventKeys.subjectTimeline(event.ownerId, event.subjectRef),
      RoutingSignalEventKeys.closures(event.ownerId),
      RoutingSignalEventKeys.ownerRevision(event.ownerId),
      RoutingSignalEventKeys.ownerAppendSequence(event.ownerId),
      ...closesSignalIds.map((eventId) => RoutingSignalEventKeys.detail(event.ownerId, eventId)),
    ];
    const result = (await this.redis.eval(
      APPEND_ROUTING_SIGNAL_EVENT_LUA,
      keys.length,
      ...keys,
      raw,
      event.eventId,
      String(event.observedAt),
      event.eventType,
      String(closesSignalIds.length),
      ...closesSignalIds,
    )) as [string, string, string?];
    const [outcome, payload, ownerRevisionRaw] = result;
    if (outcome === 'APPENDED') {
      const persisted = this.parsePersisted(payload, event.eventId);
      const ownerRevision = this.parseOwnerRevision(ownerRevisionRaw, event.ownerId);
      await this.advanceDecisionStateAfterAppend(persisted, ownerRevision);
      return { outcome: 'appended', event: persisted };
    }
    if (outcome === 'REPLAYED') {
      const persisted = this.parsePersisted(payload, event.eventId);
      this.rememberOwnerRevision(event.ownerId, this.parseOwnerRevision(ownerRevisionRaw, event.ownerId));
      return { outcome: 'replayed', event: persisted };
    }
    if (outcome === 'COMMAND_CONFLICT') {
      throw new RoutingSignalEventConflictError(`routing signal command conflict: ${event.commandId}`);
    }
    if (outcome === 'EVENT_CONFLICT') {
      throw new RoutingSignalEventConflictError(`routing signal event id conflict: ${event.eventId}`);
    }
    if (outcome === 'CLOSURE_CONFLICT') {
      throw new RoutingSignalEventConflictError(`routing signal closure conflict: ${event.eventId}`);
    }
    if (outcome === 'TYPE_CONFLICT') {
      throw new RoutingSignalEventHydrationError(`routing signal Redis type conflict: ${event.eventId}`);
    }
    if (outcome === 'CORRUPT_REPLAY') {
      throw new RoutingSignalEventHydrationError(`routing signal replay indexes are inconsistent: ${event.eventId}`);
    }
    throw new RoutingSignalEventHydrationError(`routing signal append failed (${outcome}): ${event.eventId}`);
  }

  async get(ownerId: string, eventId: string): Promise<RoutingSignalEventV1 | null> {
    const raw = await this.redis.get(RoutingSignalEventKeys.detail(ownerId, eventId));
    return raw === null ? null : this.parsePersisted(raw, eventId);
  }

  async getByCommand(ownerId: string, commandId: string): Promise<RoutingSignalEventV1 | null> {
    const raw = await this.redis.get(RoutingSignalEventKeys.command(ownerId, commandId));
    return raw === null ? null : this.parsePersisted(raw, `command:${commandId}`);
  }

  async getOwnerRevision(ownerId: string): Promise<number> {
    const cached = this.ownerRevisionCache.get(ownerId);
    if (cached !== undefined) {
      this.rememberOwnerRevision(ownerId, cached);
      return cached;
    }
    const raw = await this.redis.get(RoutingSignalEventKeys.ownerRevision(ownerId));
    const revision = this.parseOwnerRevision(raw ?? '0', ownerId);
    this.rememberOwnerRevision(ownerId, revision);
    return revision;
  }

  async readDecisionProjection(ownerId: string): Promise<RoutingSignalDecisionProjectionV1> {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const cached = this.decisionProjectionCache.get(ownerId);
      const knownRevision = this.ownerRevisionCache.get(ownerId);
      if (cached !== undefined && (knownRevision === undefined || cached.revision >= knownRevision)) {
        return this.rememberDecisionProjection(ownerId, cached);
      }
      if (cached !== undefined) this.decisionProjectionCache.delete(ownerId);

      let load = this.decisionProjectionLoads.get(ownerId);
      if (load === undefined) {
        load = this.loadDecisionProjection(ownerId);
        this.decisionProjectionLoads.set(ownerId, load);
      }
      try {
        const loaded = await load;
        const latestKnownRevision = this.ownerRevisionCache.get(ownerId);
        if (latestKnownRevision !== undefined && loaded.revision < latestKnownRevision) continue;
        return this.rememberDecisionProjection(ownerId, loaded);
      } finally {
        if (this.decisionProjectionLoads.get(ownerId) === load) this.decisionProjectionLoads.delete(ownerId);
      }
    }
    throw new RoutingSignalEventHydrationError(
      `routing signal process projection could not reach a stable revision: ${ownerId}`,
    );
  }

  private async loadDecisionProjection(ownerId: string): Promise<RoutingSignalDecisionProjectionV1> {
    let projection = await this.readPersistedDecisionProjection(ownerId);
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const targetRevision = await this.getOwnerRevision(ownerId);
      projection = await this.projectDecisionRevision(ownerId, projection, targetRevision);

      if (projection.revision !== (await this.getOwnerRevision(ownerId))) continue;
      const stored = await this.persistDecisionProjection(ownerId, projection);
      if (stored) return projection;
    }
    throw new RoutingSignalEventHydrationError(
      `routing signal projection could not reach a stable revision: ${ownerId}`,
    );
  }

  private async projectDecisionRevision(
    ownerId: string,
    projection: RoutingSignalDecisionProjectionV1 | null,
    targetRevision: number,
  ): Promise<RoutingSignalDecisionProjectionV1> {
    if (projection === null || projection.revision > targetRevision) {
      return this.rebuildDecisionProjection(ownerId);
    }
    if (projection.revision === targetRevision) return projection;
    const deltas = await this.readAppendSequence(ownerId, projection.revision + 1, targetRevision);
    if (deltas === null) return this.rebuildDecisionProjection(ownerId);
    try {
      return advanceRoutingSignalDecisionProjectionSequence(projection, deltas);
    } catch {
      return this.rebuildDecisionProjection(ownerId);
    }
  }

  async listByOwner(ownerId: string): Promise<RoutingSignalEventV1[]> {
    return this.listTimeline(ownerId, RoutingSignalEventKeys.ownerTimeline(ownerId));
  }

  async listBySubject(ownerId: string, subjectRef: RoutingSubjectRefV1): Promise<RoutingSignalEventV1[]> {
    return this.listTimeline(ownerId, RoutingSignalEventKeys.subjectTimeline(ownerId, subjectRef));
  }

  private async listTimeline(ownerId: string, timelineKey: string): Promise<RoutingSignalEventV1[]> {
    const eventIds = await this.redis.zrange(timelineKey, 0, -1);
    if (eventIds.length === 0) return [];
    const raws = await this.redis.mget(...eventIds.map((eventId) => RoutingSignalEventKeys.detail(ownerId, eventId)));
    return raws.map((raw, index) => {
      if (raw === null) {
        throw new RoutingSignalEventHydrationError(`malformed persisted routing signal: missing ${eventIds[index]}`);
      }
      return this.parsePersisted(raw, eventIds[index]);
    });
  }

  private async readPersistedDecisionProjection(ownerId: string): Promise<RoutingSignalDecisionProjectionV1 | null> {
    const key = RoutingSignalEventKeys.decisionProjection(ownerId);
    let raw: string | null;
    try {
      raw = await this.redis.get(key);
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes('WRONGTYPE')) throw error;
      await this.redis.del(key);
      return null;
    }
    if (raw === null) return null;
    try {
      return parseRoutingSignalDecisionProjection(JSON.parse(raw), ownerId);
    } catch {
      return null;
    }
  }

  private async rebuildDecisionProjection(ownerId: string): Promise<RoutingSignalDecisionProjectionV1> {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const revisionBefore = await this.getOwnerRevision(ownerId);
      const events = await this.listByOwner(ownerId);
      const revisionAfter = await this.getOwnerRevision(ownerId);
      if (revisionBefore === revisionAfter) {
        return buildRoutingSignalDecisionProjection({ ownerId, revision: revisionAfter, events });
      }
    }
    throw new RoutingSignalEventHydrationError(
      `routing signal owner revision changed during projection rebuild: ${ownerId}`,
    );
  }

  private async readAppendSequence(
    ownerId: string,
    firstRevision: number,
    lastRevision: number,
  ): Promise<RoutingSignalEventV1[] | null> {
    const eventIds = await this.redis.zrangebyscore(
      RoutingSignalEventKeys.ownerAppendSequence(ownerId),
      firstRevision,
      lastRevision,
    );
    if (eventIds.length !== lastRevision - firstRevision + 1) return null;
    const raws = await this.redis.mget(...eventIds.map((eventId) => RoutingSignalEventKeys.detail(ownerId, eventId)));
    const events: RoutingSignalEventV1[] = [];
    for (const [index, raw] of raws.entries()) {
      if (raw === null) return null;
      events.push(this.parsePersisted(raw, eventIds[index]));
    }
    return events;
  }

  private async persistDecisionProjection(
    ownerId: string,
    projection: RoutingSignalDecisionProjectionV1,
  ): Promise<boolean> {
    const outcome = (await this.redis.eval(
      STORE_ROUTING_SIGNAL_DECISION_PROJECTION_LUA,
      2,
      RoutingSignalEventKeys.ownerRevision(ownerId),
      RoutingSignalEventKeys.decisionProjection(ownerId),
      String(projection.revision),
      JSON.stringify(projection),
    )) as string;
    if (outcome === 'STORED') return true;
    if (outcome === 'REVISION_MISMATCH') return false;
    if (outcome === 'TYPE_CONFLICT') {
      throw new RoutingSignalEventHydrationError(`routing signal projection Redis type conflict: ${ownerId}`);
    }
    throw new RoutingSignalEventHydrationError(`routing signal projection persist failed (${outcome}): ${ownerId}`);
  }

  private async advanceDecisionStateAfterAppend(event: RoutingSignalEventV1, ownerRevision: number): Promise<void> {
    this.rememberOwnerRevision(event.ownerId, ownerRevision);
    const cached = this.decisionProjectionCache.get(event.ownerId);
    if (cached === undefined || cached.revision === ownerRevision) return;
    if (cached.revision + 1 !== ownerRevision) {
      this.decisionProjectionCache.delete(event.ownerId);
      return;
    }

    let advanced: RoutingSignalDecisionProjectionV1;
    try {
      advanced = advanceRoutingSignalDecisionProjection(cached, event, ownerRevision);
    } catch {
      this.decisionProjectionCache.delete(event.ownerId);
      try {
        await this.readDecisionProjection(event.ownerId);
      } catch {
        // The canonical append already committed. A later preflight retries the disposable projection.
      }
      return;
    }
    this.rememberDecisionProjection(event.ownerId, advanced);
    try {
      await this.persistDecisionProjection(event.ownerId, advanced);
    } catch {
      // Persistence is a restart optimization; the process projection remains revision-fenced and exact.
    }
  }

  private rememberOwnerRevision(ownerId: string, revision: number): void {
    const current = this.ownerRevisionCache.get(ownerId);
    if (current !== undefined && current > revision) return;
    this.ownerRevisionCache.delete(ownerId);
    this.ownerRevisionCache.set(ownerId, revision);
    this.trimCache(this.ownerRevisionCache);
  }

  private rememberDecisionProjection(
    ownerId: string,
    projection: RoutingSignalDecisionProjectionV1,
  ): RoutingSignalDecisionProjectionV1 {
    const current = this.decisionProjectionCache.get(ownerId);
    if (current !== undefined && current.revision > projection.revision) return current;
    this.decisionProjectionCache.delete(ownerId);
    this.decisionProjectionCache.set(ownerId, projection);
    this.trimCache(this.decisionProjectionCache);
    this.rememberOwnerRevision(ownerId, projection.revision);
    return projection;
  }

  private trimCache<T>(cache: Map<string, T>): void {
    while (cache.size > MAX_HOT_OWNERS) {
      const oldestOwnerId = cache.keys().next().value;
      if (oldestOwnerId === undefined) break;
      cache.delete(oldestOwnerId);
    }
  }

  private parseOwnerRevision(raw: string | undefined, ownerId: string): number {
    if (raw === undefined || !/^(0|[1-9]\d*)$/.test(raw)) {
      throw new RoutingSignalEventHydrationError(`malformed routing signal owner revision: ${ownerId}`);
    }
    const revision = Number(raw);
    if (!Number.isSafeInteger(revision)) {
      throw new RoutingSignalEventHydrationError(`unsafe routing signal owner revision: ${ownerId}`);
    }
    return revision;
  }

  private parsePersisted(raw: string, eventId: string): RoutingSignalEventV1 {
    try {
      const parsed = routingSignalEventV1Schema.safeParse(JSON.parse(raw));
      if (parsed.success) return parsed.data;
    } catch {
      // Fall through to the typed fail-closed boundary below.
    }
    throw new RoutingSignalEventHydrationError(`malformed persisted routing signal: ${eventId}`);
  }
}
