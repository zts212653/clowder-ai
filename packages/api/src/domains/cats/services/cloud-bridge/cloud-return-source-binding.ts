import { createHash } from 'node:crypto';
import type { RedisClient } from '@cat-cafe/shared/utils';

/**
 * F202 W2-3 h3c-2 (review P1-3) — one source, one cloud cat, for good. A polled return carries no
 * dispatch identity of its own: the Host attributes it to the cat its grant names. So the first grant
 * for a source binds the source to that cat, and the binding outlives every grant: it never expires,
 * is never refreshed and is never overwritten. Grants can lapse and be issued again; the owner cannot
 * change. A grant for another cat is refused, and a grant is only claimable while its source belongs
 * to its cat — an answer that arrives days late from the native inbox still cannot be recorded as the
 * wrong cat. The cost is one small key per message ever sent to a cloud cat.
 */

const SOURCE_PREFIX = 'cloud-bridge:return-source:';
/** The owner of a source two persisted grants disagreed about: it belongs to no cat. */
export const UNOWNED_SOURCE = '!unowned';

export interface CloudReturnSource {
  readonly threadId: string;
  readonly userId: string;
  readonly sourceMessageId: string;
  readonly targetCatId: string;
}

export function cloudReturnSourceKey(source: Omit<CloudReturnSource, 'targetCatId'>): string {
  const material = JSON.stringify({
    v: 1,
    threadId: source.threadId,
    userId: source.userId,
    sourceMessageId: source.sourceMessageId,
  });
  return `${SOURCE_PREFIX}${createHash('sha256').update(material).digest('hex')}`;
}

/** `bound` when the source belongs to this cat; otherwise its owner — `null` when none can be named. */
export type SourceBinding = { readonly bound: true } | { readonly bound: false; readonly owner: string | null };

function refusal(owner: string | null): SourceBinding {
  return { bound: false, owner: owner === UNOWNED_SOURCE ? null : owner };
}

/** When the Host minted this message id (`<16-digit ms>-<seq>-<8 hex>`); `undefined` for any other id. */
export function sourceCreatedAt(sourceMessageId: string): number | undefined {
  const match = /^(\d{16})-\d{6,}-[0-9a-f]{8}$/u.exec(sourceMessageId);
  return match ? Number(match[1]) : undefined;
}

/**
 * A source without an owner may take its first one only if the Host can prove it is younger than the
 * bindings (the epoch): from then on every dispatch writes its binding, so a younger source with none
 * was never sent anywhere. An older source might have been sent by a Host that kept no binding, and
 * its grant may have lapsed since while the answer still waits in the native inbox — nobody can say
 * whose it is, so nobody gets it. The id is the Host's own record of when the message was created.
 */
function provablyNew(sourceMessageId: string, epoch: number): boolean {
  const createdAt = sourceCreatedAt(sourceMessageId);
  return createdAt !== undefined && createdAt >= epoch;
}

/** Admits a dispatch: binds a provably new source to this cat, or reports whose it is. Never overwrites. */
export async function bindSourceInRedis(
  redis: Pick<RedisClient, 'set' | 'get'>,
  source: CloudReturnSource,
  epoch: number,
): Promise<SourceBinding> {
  const key = cloudReturnSourceKey(source);
  const owner = await redis.get(key);
  if (owner !== null) return owner === source.targetCatId ? { bound: true } : refusal(owner);
  if (!provablyNew(source.sourceMessageId, epoch)) return { bound: false, owner: null };
  if ((await redis.set(key, source.targetCatId, 'NX')) === 'OK') return { bound: true };
  const winner = await redis.get(key);
  return winner === source.targetCatId ? { bound: true } : refusal(winner);
}

export async function sourceOwnerInRedis(
  redis: Pick<RedisClient, 'get'>,
  source: Omit<CloudReturnSource, 'targetCatId'>,
): Promise<string | null> {
  return redis.get(cloudReturnSourceKey(source));
}

export class MemorySourceBindings {
  private readonly owners = new Map<string, string>();

  /** `epoch`: memory keeps no bindings across a restart, so a store's history starts when it does. */
  constructor(private readonly epoch: number) {}

  bind(source: CloudReturnSource): SourceBinding {
    const key = cloudReturnSourceKey(source);
    const owner = this.owners.get(key);
    if (owner !== undefined) return owner === source.targetCatId ? { bound: true } : refusal(owner);
    if (!provablyNew(source.sourceMessageId, this.epoch)) return { bound: false, owner: null };
    this.owners.set(key, source.targetCatId);
    return { bound: true };
  }

  ownerOf(source: Omit<CloudReturnSource, 'targetCatId'>): string | null {
    return this.owners.get(cloudReturnSourceKey(source)) ?? null;
  }
}

const EPOCH_KEY = `${SOURCE_PREFIX}epoch`;
const MIGRATED_KEY = `${SOURCE_PREFIX}migrated`;

/**
 * Opens the bindings of a Redis database and returns its epoch. The first run records the epoch —
 * durably, once — and then recovers the owner of every grant persisted before bindings existed: those
 * are dispatches too. A source two of them disagree about belongs to neither. Sources older than the
 * epoch whose grants had already lapsed stay ownerless, and are refused (see `provablyNew`).
 */
export async function openSourceBindingsInRedis(
  redis: Pick<RedisClient, 'get' | 'set' | 'scan'>,
  grants: { readonly keyPattern: string; readonly read: (raw: string | null) => CloudReturnSource | null },
  now: () => number = Date.now,
): Promise<number> {
  await redis.set(EPOCH_KEY, String(now()), 'NX');
  const epoch = Number(await redis.get(EPOCH_KEY));
  if (!Number.isFinite(epoch)) throw new Error('the cloud return source epoch is unreadable');
  if ((await redis.get(MIGRATED_KEY)) === 'v2') return epoch;
  let cursor = '0';
  do {
    const [next, keys] = await redis.scan(cursor, 'MATCH', grants.keyPattern, 'COUNT', 500);
    cursor = next;
    for (const key of keys) {
      const source = grants.read(await redis.get(key));
      if (!source || (await redis.set(cloudReturnSourceKey(source), source.targetCatId, 'NX')) === 'OK') continue;
      const owner = await redis.get(cloudReturnSourceKey(source));
      if (owner !== source.targetCatId && owner !== UNOWNED_SOURCE) {
        await redis.set(cloudReturnSourceKey(source), UNOWNED_SOURCE);
      }
    }
  } while (cursor !== '0');
  await redis.set(MIGRATED_KEY, 'v2');
  return epoch;
}
