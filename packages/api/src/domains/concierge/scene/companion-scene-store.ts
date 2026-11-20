/**
 * CompanionSceneStore (F336 Phase C, plan §D)
 *
 * One scene per user + cat + scene, stored as JSON {revision, updatedAt, snapshot}.
 * TTL=0 and no clearing (铁律 5 LL-048). Writes are compare-and-swap on revision:
 * - baseRevision 0 creates, and only when the key is absent;
 * - any other base writes only over a readable scene at exactly that revision.
 * A value that cannot be read back is `corrupt`: it is reported, kept as is, and no
 * write — create or otherwise — may replace it. Redis and memory share these rules.
 */

import type { RedisClient } from '@cat-cafe/shared/utils';
import { ConciergeKeys } from '../concierge-keys.js';
import { type CompanionSceneSnapshot, isCompanionSceneSnapshot } from './companion-scene-snapshot.js';

export interface CompanionSceneAddress {
  userId: string;
  catId: string;
  sceneId: string;
}

export interface CompanionSceneWrite {
  baseRevision: number;
  snapshot: CompanionSceneSnapshot;
}

/** Only `not_found` may seed a new scene; `error` means keep the archive and do not write. */
export type CompanionSceneRead =
  | { status: 'found'; revision: number; updatedAt: number; snapshot: CompanionSceneSnapshot }
  | { status: 'not_found' }
  | { status: 'error'; reason: 'corrupt' | 'unavailable' };

export type CompanionScenePut =
  | { status: 'ok'; revision: number }
  | { status: 'conflict'; current: CompanionSceneRead }
  | { status: 'error'; reason: 'unavailable' };

export interface ICompanionSceneStore {
  get(address: CompanionSceneAddress): Promise<CompanionSceneRead>;
  put(address: CompanionSceneAddress, write: CompanionSceneWrite): Promise<CompanionScenePut>;
}

const CORRUPT = { status: 'error', reason: 'corrupt' } as const;
const UNAVAILABLE = { status: 'error', reason: 'unavailable' } as const;

function sceneKey({ userId, catId, sceneId }: CompanionSceneAddress): string {
  return ConciergeKeys.companionScene(userId, catId, sceneId);
}

export function readStoredCompanionScene(raw: string | null): CompanionSceneRead {
  if (raw === null) return { status: 'not_found' };
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return CORRUPT;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return CORRUPT;
  const { revision, updatedAt, snapshot } = value as Record<string, unknown>;
  if (!Number.isSafeInteger(revision) || (revision as number) < 1) return CORRUPT;
  if (typeof updatedAt !== 'number' || !Number.isFinite(updatedAt)) return CORRUPT;
  if (!isCompanionSceneSnapshot(snapshot)) return CORRUPT;
  return { status: 'found', revision: revision as number, updatedAt, snapshot };
}

function writableAt(current: CompanionSceneRead, baseRevision: number): boolean {
  if (current.status === 'not_found') return baseRevision === 0;
  return current.status === 'found' && current.revision === baseRevision;
}

function assertBaseRevision(baseRevision: number): void {
  if (!Number.isSafeInteger(baseRevision) || baseRevision < 0) throw new RangeError('invalid scene base revision');
}

function encode(revision: number, updatedAt: number, snapshot: CompanionSceneSnapshot): string {
  return JSON.stringify({ revision, updatedAt, snapshot });
}

/** Atomic re-check of the revision the caller validated; SET without EX keeps TTL=0. */
const PUT_SCENE_LUA = `
local raw = redis.call('GET', KEYS[1])
local base = tonumber(ARGV[1])
if not raw then
  if base ~= 0 then return {0} end
else
  if base == 0 then return {0, raw} end
  local ok, current = pcall(cjson.decode, raw)
  if not ok or type(current) ~= 'table' or current.revision ~= base then return {0, raw} end
end
redis.call('SET', KEYS[1], ARGV[2])
return {1}
`;

interface StoreOptions {
  now?: () => number;
}

export class RedisCompanionSceneStore implements ICompanionSceneStore {
  private readonly now: () => number;

  constructor(
    private readonly redis: RedisClient,
    options: StoreOptions = {},
  ) {
    this.now = options.now ?? Date.now;
  }

  async get(address: CompanionSceneAddress): Promise<CompanionSceneRead> {
    try {
      return readStoredCompanionScene(await this.redis.get(sceneKey(address)));
    } catch {
      return UNAVAILABLE;
    }
  }

  async put(
    address: CompanionSceneAddress,
    { baseRevision, snapshot }: CompanionSceneWrite,
  ): Promise<CompanionScenePut> {
    assertBaseRevision(baseRevision);
    const key = sceneKey(address);
    const revision = baseRevision + 1;
    try {
      // Validate the full stored value first: Lua only sees the revision, and a value
      // this API cannot read must never be replaced, even at its own claimed revision.
      const current = readStoredCompanionScene(await this.redis.get(key));
      if (!writableAt(current, baseRevision)) return { status: 'conflict', current };
      const result = (await this.redis.eval(
        PUT_SCENE_LUA,
        1,
        key,
        String(baseRevision),
        encode(revision, this.now(), snapshot),
      )) as [number, string?];
      if (result[0] === 1) return { status: 'ok', revision };
      return { status: 'conflict', current: readStoredCompanionScene(result[1] ?? null) };
    } catch {
      return UNAVAILABLE;
    }
  }
}

/** Same rules over raw JSON strings keyed like Redis, so tests can plant damaged values. */
export class MemoryCompanionSceneStore implements ICompanionSceneStore {
  private readonly entries: Map<string, string>;
  private readonly now: () => number;

  constructor(options: StoreOptions & { entries?: Map<string, string> } = {}) {
    this.entries = options.entries ?? new Map();
    this.now = options.now ?? Date.now;
  }

  async get(address: CompanionSceneAddress): Promise<CompanionSceneRead> {
    return readStoredCompanionScene(this.entries.get(sceneKey(address)) ?? null);
  }

  async put(
    address: CompanionSceneAddress,
    { baseRevision, snapshot }: CompanionSceneWrite,
  ): Promise<CompanionScenePut> {
    assertBaseRevision(baseRevision);
    const key = sceneKey(address);
    const current = readStoredCompanionScene(this.entries.get(key) ?? null);
    if (!writableAt(current, baseRevision)) return { status: 'conflict', current };
    const revision = baseRevision + 1;
    this.entries.set(key, encode(revision, this.now(), snapshot));
    return { status: 'ok', revision };
  }
}
