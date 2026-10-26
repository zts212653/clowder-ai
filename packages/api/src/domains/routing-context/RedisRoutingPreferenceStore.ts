import { type RoutingPreferenceRevisionV1, routingPreferenceRevisionV1Schema } from '@cat-cafe/shared';
import type { RedisClient } from '@cat-cafe/shared/utils';
import { projectRoutingPreferenceHeads } from './preflight/RoutingPreferenceDecisionProjection.js';
import {
  type IRoutingPreferenceStore,
  type RoutingPreferenceAppendResult,
  RoutingPreferenceConflictError,
  RoutingPreferenceHydrationError,
} from './RoutingPreferenceStore.js';

const APPEND_REVISION_LUA = `
local function allowed_type(key, expected)
  local actual = redis.call('TYPE', key)['ok']
  return actual == 'none' or actual == expected
end

if #KEYS ~= 6 or #ARGV ~= 7 then return {'INVALID_ARGUMENTS', ''} end
if not allowed_type(KEYS[1], 'string') or not allowed_type(KEYS[2], 'string') or
   not allowed_type(KEYS[3], 'zset') or not allowed_type(KEYS[4], 'zset') or
   not allowed_type(KEYS[5], 'string') or not allowed_type(KEYS[6], 'string') then
  return {'TYPE_CONFLICT', ''}
end

local existing_command = redis.call('GET', KEYS[1])
if existing_command then
  if existing_command ~= ARGV[1] then return {'COMMAND_CONFLICT', ''} end
  local existing_detail = redis.call('GET', KEYS[2])
  if existing_detail ~= ARGV[1] then return {'CORRUPT_REPLAY', ''} end
  if not redis.call('ZSCORE', KEYS[3], ARGV[2]) or not redis.call('ZSCORE', KEYS[4], ARGV[2]) then
    return {'CORRUPT_REPLAY', ''}
  end
  return {'REPLAYED', existing_detail, tostring(redis.call('ZCARD', KEYS[3]))}
end
if redis.call('EXISTS', KEYS[2]) == 1 then return {'REVISION_CONFLICT', ''} end

local version = tonumber(ARGV[5])
local current_head = redis.call('GET', KEYS[5])
if version == 1 then
  if current_head or ARGV[6] ~= '' then return {'HEAD_CONFLICT', ''} end
else
  if current_head ~= ARGV[6] then return {'HEAD_CONFLICT', ''} end
  local predecessor_raw = redis.call('GET', KEYS[6])
  if not predecessor_raw then return {'HEAD_CORRUPT', ''} end
  local decoded_ok, predecessor = pcall(cjson.decode, predecessor_raw)
  if not decoded_ok or type(predecessor) ~= 'table' then return {'HEAD_CORRUPT', ''} end
  if predecessor['preferenceId'] ~= ARGV[4] or tonumber(predecessor['version']) ~= version - 1 then
    return {'HEAD_CONFLICT', ''}
  end
  if predecessor['lifecycle'] == 'retired' then return {'CHAIN_RETIRED', ''} end
end

redis.call('SET', KEYS[1], ARGV[1])
redis.call('SET', KEYS[2], ARGV[1])
redis.call('ZADD', KEYS[3], tonumber(ARGV[3]), ARGV[2])
redis.call('ZADD', KEYS[4], tonumber(ARGV[3]), ARGV[2])
redis.call('SET', KEYS[5], ARGV[2])
return {'APPENDED', ARGV[1], tostring(redis.call('ZCARD', KEYS[3]))}
`;

const MAX_HOT_OWNERS = 256;

interface PreferenceDecisionHeads {
  revision: number;
  heads: RoutingPreferenceRevisionV1[];
}

function keyPart(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url');
}

export const RoutingPreferenceKeys = {
  detail: (ownerId: string, revisionId: string) =>
    `routing-context:preferences:${keyPart(ownerId)}:revision:${keyPart(revisionId)}`,
  command: (ownerId: string, commandId: string) =>
    `routing-context:preferences:${keyPart(ownerId)}:command:${keyPart(commandId)}`,
  ownerTimeline: (ownerId: string) => `routing-context:preferences:${keyPart(ownerId)}:timeline`,
  chainTimeline: (ownerId: string, preferenceId: string) =>
    `routing-context:preferences:${keyPart(ownerId)}:chain:${keyPart(preferenceId)}:timeline`,
  head: (ownerId: string, preferenceId: string) =>
    `routing-context:preferences:${keyPart(ownerId)}:chain:${keyPart(preferenceId)}:head`,
} as const;

export class RedisRoutingPreferenceStore implements IRoutingPreferenceStore {
  private readonly ownerTimelineRevisionCache = new Map<string, number>();
  private readonly decisionHeadsCache = new Map<string, PreferenceDecisionHeads>();
  private readonly decisionHeadLoads = new Map<string, Promise<PreferenceDecisionHeads>>();

  constructor(private readonly redis: RedisClient) {}

  async append(revisionInput: RoutingPreferenceRevisionV1): Promise<RoutingPreferenceAppendResult> {
    const revision = routingPreferenceRevisionV1Schema.parse(revisionInput);
    const raw = JSON.stringify(revision);
    const predecessorId = revision.supersedesRevisionId ?? '';
    const keys = [
      RoutingPreferenceKeys.command(revision.ownerId, revision.commandId),
      RoutingPreferenceKeys.detail(revision.ownerId, revision.revisionId),
      RoutingPreferenceKeys.ownerTimeline(revision.ownerId),
      RoutingPreferenceKeys.chainTimeline(revision.ownerId, revision.preferenceId),
      RoutingPreferenceKeys.head(revision.ownerId, revision.preferenceId),
      RoutingPreferenceKeys.detail(revision.ownerId, predecessorId || revision.revisionId),
    ];
    const result = (await this.redis.eval(
      APPEND_REVISION_LUA,
      keys.length,
      ...keys,
      raw,
      revision.revisionId,
      String(revision.validFrom),
      revision.preferenceId,
      String(revision.version),
      predecessorId,
      revision.lifecycle,
    )) as [string, string, string?];
    const [outcome, payload, timelineRevisionRaw] = result;
    if (outcome === 'APPENDED') {
      const persisted = this.parsePersisted(payload, revision.revisionId);
      const timelineRevision = this.parseTimelineRevision(timelineRevisionRaw, revision.ownerId);
      this.rememberTimelineRevision(revision.ownerId, timelineRevision);
      this.advanceDecisionHeads(persisted, timelineRevision);
      return { outcome: 'appended', revision: persisted };
    }
    if (outcome === 'REPLAYED') {
      const persisted = this.parsePersisted(payload, revision.revisionId);
      const timelineRevision = this.parseTimelineRevision(timelineRevisionRaw, revision.ownerId);
      this.rememberTimelineRevision(revision.ownerId, timelineRevision);
      const cached = this.decisionHeadsCache.get(revision.ownerId);
      if (cached !== undefined && cached.revision !== timelineRevision) {
        this.decisionHeadsCache.delete(revision.ownerId);
      }
      return { outcome: 'replayed', revision: persisted };
    }
    if (outcome === 'COMMAND_CONFLICT') {
      throw new RoutingPreferenceConflictError(`routing preference command conflict: ${revision.commandId}`);
    }
    if (outcome === 'REVISION_CONFLICT') {
      throw new RoutingPreferenceConflictError(`routing preference revision id conflict: ${revision.revisionId}`);
    }
    if (outcome === 'HEAD_CONFLICT') {
      throw new RoutingPreferenceConflictError(`routing preference head conflict: ${revision.preferenceId}`);
    }
    if (outcome === 'CHAIN_RETIRED') {
      throw new RoutingPreferenceConflictError(`routing preference chain is retired: ${revision.preferenceId}`);
    }
    if (outcome === 'TYPE_CONFLICT') {
      throw new RoutingPreferenceHydrationError(`routing preference Redis type conflict: ${revision.revisionId}`);
    }
    if (outcome === 'HEAD_CORRUPT') {
      throw new RoutingPreferenceHydrationError(`routing preference head is corrupt: ${revision.preferenceId}`);
    }
    if (outcome === 'CORRUPT_REPLAY') {
      throw new RoutingPreferenceHydrationError(
        `routing preference replay indexes are inconsistent: ${revision.revisionId}`,
      );
    }
    throw new RoutingPreferenceHydrationError(`routing preference append failed (${outcome}): ${revision.revisionId}`);
  }

  async getRevision(ownerId: string, revisionId: string): Promise<RoutingPreferenceRevisionV1 | null> {
    const raw = await this.redis.get(RoutingPreferenceKeys.detail(ownerId, revisionId));
    return raw === null ? null : this.parsePersisted(raw, revisionId);
  }

  async getByCommand(ownerId: string, commandId: string): Promise<RoutingPreferenceRevisionV1 | null> {
    const raw = await this.redis.get(RoutingPreferenceKeys.command(ownerId, commandId));
    return raw === null ? null : this.parsePersisted(raw, `command:${commandId}`);
  }

  async getHead(ownerId: string, preferenceId: string): Promise<RoutingPreferenceRevisionV1 | null> {
    const revisionId = await this.redis.get(RoutingPreferenceKeys.head(ownerId, preferenceId));
    if (revisionId === null) return null;
    const head = await this.getRevision(ownerId, revisionId);
    if (head !== null && head.preferenceId === preferenceId) return head;
    throw new RoutingPreferenceHydrationError(`malformed persisted routing preference head: ${preferenceId}`);
  }

  async readDecisionHeads(ownerId: string): Promise<RoutingPreferenceRevisionV1[]> {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const cached = this.decisionHeadsCache.get(ownerId);
      const knownRevision = this.ownerTimelineRevisionCache.get(ownerId);
      if (cached !== undefined && (knownRevision === undefined || cached.revision >= knownRevision)) {
        return [...this.rememberDecisionHeads(ownerId, cached).heads];
      }
      if (cached !== undefined) this.decisionHeadsCache.delete(ownerId);

      let load = this.decisionHeadLoads.get(ownerId);
      if (load === undefined) {
        load = this.loadDecisionHeads(ownerId);
        this.decisionHeadLoads.set(ownerId, load);
      }
      try {
        const loaded = await load;
        const latestKnownRevision = this.ownerTimelineRevisionCache.get(ownerId);
        if (latestKnownRevision !== undefined && loaded.revision < latestKnownRevision) continue;
        return [...this.rememberDecisionHeads(ownerId, loaded).heads];
      } finally {
        if (this.decisionHeadLoads.get(ownerId) === load) this.decisionHeadLoads.delete(ownerId);
      }
    }
    throw new RoutingPreferenceHydrationError(
      `routing preference decision heads could not reach a stable revision: ${ownerId}`,
    );
  }

  async listByOwner(ownerId: string): Promise<RoutingPreferenceRevisionV1[]> {
    return this.listTimeline(ownerId, RoutingPreferenceKeys.ownerTimeline(ownerId));
  }

  async listChain(ownerId: string, preferenceId: string): Promise<RoutingPreferenceRevisionV1[]> {
    const revisions = await this.listTimeline(ownerId, RoutingPreferenceKeys.chainTimeline(ownerId, preferenceId));
    if (revisions.some((revision) => revision.preferenceId !== preferenceId)) {
      throw new RoutingPreferenceHydrationError(`malformed persisted routing preference chain: ${preferenceId}`);
    }
    return revisions;
  }

  private async listTimeline(ownerId: string, timelineKey: string): Promise<RoutingPreferenceRevisionV1[]> {
    const revisionIds = await this.redis.zrange(timelineKey, 0, -1);
    return this.hydrateTimeline(ownerId, revisionIds);
  }

  private async hydrateTimeline(ownerId: string, revisionIds: string[]): Promise<RoutingPreferenceRevisionV1[]> {
    if (revisionIds.length === 0) return [];
    const raws = await this.redis.mget(
      ...revisionIds.map((revisionId) => RoutingPreferenceKeys.detail(ownerId, revisionId)),
    );
    return raws.map((raw, index) => {
      if (raw === null) {
        throw new RoutingPreferenceHydrationError(
          `malformed persisted routing preference: missing ${revisionIds[index]}`,
        );
      }
      return this.parsePersisted(raw, revisionIds[index]);
    });
  }

  private async loadDecisionHeads(ownerId: string): Promise<PreferenceDecisionHeads> {
    const timelineKey = RoutingPreferenceKeys.ownerTimeline(ownerId);
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const revisionIdsBefore = await this.redis.zrange(timelineKey, 0, -1);
      const revisions = await this.hydrateTimeline(ownerId, revisionIdsBefore);
      const revisionIdsAfter = await this.redis.zrange(timelineKey, 0, -1);
      if (
        revisionIdsBefore.length === revisionIdsAfter.length &&
        revisionIdsBefore.every((revisionId, index) => revisionId === revisionIdsAfter[index])
      ) {
        return { revision: revisionIdsAfter.length, heads: projectRoutingPreferenceHeads(revisions) };
      }
    }
    throw new RoutingPreferenceHydrationError(
      `routing preference owner revision changed during decision projection: ${ownerId}`,
    );
  }

  private advanceDecisionHeads(revision: RoutingPreferenceRevisionV1, timelineRevision: number): void {
    const cached = this.decisionHeadsCache.get(revision.ownerId);
    if (cached === undefined) return;
    if (cached.revision + 1 !== timelineRevision) {
      this.decisionHeadsCache.delete(revision.ownerId);
      return;
    }
    this.rememberDecisionHeads(revision.ownerId, {
      revision: timelineRevision,
      heads: projectRoutingPreferenceHeads([...cached.heads, revision]),
    });
  }

  private rememberDecisionHeads(ownerId: string, value: PreferenceDecisionHeads): PreferenceDecisionHeads {
    const current = this.decisionHeadsCache.get(ownerId);
    if (current !== undefined && current.revision > value.revision) return current;
    this.decisionHeadsCache.delete(ownerId);
    this.decisionHeadsCache.set(ownerId, value);
    this.trimCache(this.decisionHeadsCache);
    this.rememberTimelineRevision(ownerId, value.revision);
    return value;
  }

  private rememberTimelineRevision(ownerId: string, revision: number): void {
    const current = this.ownerTimelineRevisionCache.get(ownerId);
    if (current !== undefined && current > revision) return;
    this.ownerTimelineRevisionCache.delete(ownerId);
    this.ownerTimelineRevisionCache.set(ownerId, revision);
    this.trimCache(this.ownerTimelineRevisionCache);
  }

  private trimCache<T>(cache: Map<string, T>): void {
    while (cache.size > MAX_HOT_OWNERS) {
      const oldestOwnerId = cache.keys().next().value;
      if (oldestOwnerId === undefined) break;
      cache.delete(oldestOwnerId);
    }
  }

  private parseTimelineRevision(raw: string | undefined, ownerId: string): number {
    if (raw === undefined || !/^(0|[1-9]\d*)$/.test(raw)) {
      throw new RoutingPreferenceHydrationError(`malformed routing preference owner revision: ${ownerId}`);
    }
    const revision = Number(raw);
    if (!Number.isSafeInteger(revision)) {
      throw new RoutingPreferenceHydrationError(`unsafe routing preference owner revision: ${ownerId}`);
    }
    return revision;
  }

  private parsePersisted(raw: string, revisionId: string): RoutingPreferenceRevisionV1 {
    try {
      const parsed = routingPreferenceRevisionV1Schema.safeParse(JSON.parse(raw));
      if (parsed.success) return parsed.data;
    } catch {
      // Fall through to the typed fail-closed boundary below.
    }
    throw new RoutingPreferenceHydrationError(`malformed persisted routing preference: ${revisionId}`);
  }
}
