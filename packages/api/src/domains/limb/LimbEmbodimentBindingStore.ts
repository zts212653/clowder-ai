import type { RedisClient } from '@cat-cafe/shared/utils';

export interface LimbEmbodimentBinding {
  readonly nodeId: string;
  readonly userId: string;
  readonly threadId: string;
  readonly catId: string;
  readonly expressionRef: string;
  readonly voiceProfileRef: string;
  readonly volumePercent: number;
  readonly updatedAt: number;
}

export interface LimbEmbodimentBindingStore {
  get(nodeId: string): Promise<LimbEmbodimentBinding | undefined>;
  getByThread(threadId: string): Promise<LimbEmbodimentBinding[]>;
  put(binding: LimbEmbodimentBinding): Promise<void>;
  remove(nodeId: string): Promise<void>;
}

function key(nodeId: string): string {
  return `limb:embodiment-binding:${nodeId}`;
}

function threadKey(threadId: string): string {
  return `limb:embodiment-thread:${threadId}`;
}

function isBinding(value: unknown): value is LimbEmbodimentBinding {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.nodeId === 'string' &&
    candidate.nodeId.length > 0 &&
    typeof candidate.userId === 'string' &&
    candidate.userId.length > 0 &&
    typeof candidate.threadId === 'string' &&
    candidate.threadId.length > 0 &&
    typeof candidate.catId === 'string' &&
    candidate.catId.length > 0 &&
    typeof candidate.expressionRef === 'string' &&
    candidate.expressionRef.length > 0 &&
    typeof candidate.voiceProfileRef === 'string' &&
    candidate.voiceProfileRef.length > 0 &&
    typeof candidate.volumePercent === 'number' &&
    Number.isSafeInteger(candidate.volumePercent) &&
    candidate.volumePercent >= 0 &&
    candidate.volumePercent <= 100 &&
    typeof candidate.updatedAt === 'number' &&
    Number.isSafeInteger(candidate.updatedAt) &&
    candidate.updatedAt >= 0
  );
}

function assertBinding(binding: LimbEmbodimentBinding): void {
  if (!isBinding(binding)) {
    throw new TypeError('Invalid limb embodiment binding');
  }
}

export class RedisLimbEmbodimentBindingStore implements LimbEmbodimentBindingStore {
  constructor(private readonly redis: Pick<RedisClient, 'get' | 'set' | 'del' | 'sadd' | 'srem' | 'smembers'>) {}

  async get(nodeId: string): Promise<LimbEmbodimentBinding | undefined> {
    const raw = await this.redis.get(key(nodeId));
    if (!raw) return undefined;
    try {
      const parsed: unknown = JSON.parse(raw);
      return isBinding(parsed) && parsed.nodeId === nodeId ? parsed : undefined;
    } catch {
      return undefined;
    }
  }

  async getByThread(threadId: string): Promise<LimbEmbodimentBinding[]> {
    const nodeIds = await this.redis.smembers(threadKey(threadId));
    const bindings = await Promise.all(nodeIds.map((nodeId) => this.get(nodeId)));
    const active: LimbEmbodimentBinding[] = [];
    for (let index = 0; index < nodeIds.length; index += 1) {
      const nodeId = nodeIds[index];
      if (nodeId === undefined) continue;
      const binding = bindings[index];
      if (binding?.threadId === threadId) {
        active.push(binding);
      } else {
        await this.redis.srem(threadKey(threadId), nodeId);
      }
    }
    return active;
  }

  async put(binding: LimbEmbodimentBinding): Promise<void> {
    assertBinding(binding);
    const previous = await this.get(binding.nodeId);
    // Iron Law #5: active embodiment binding is user-visible state, so no TTL.
    await this.redis.set(key(binding.nodeId), JSON.stringify(binding));
    await this.redis.sadd(threadKey(binding.threadId), binding.nodeId);
    if (previous && previous.threadId !== binding.threadId) {
      await this.redis.srem(threadKey(previous.threadId), binding.nodeId);
    }
  }

  async remove(nodeId: string): Promise<void> {
    const previous = await this.get(nodeId);
    await this.redis.del(key(nodeId));
    if (previous) {
      await this.redis.srem(threadKey(previous.threadId), nodeId);
    }
  }
}

export class MemoryLimbEmbodimentBindingStore implements LimbEmbodimentBindingStore {
  private readonly bindings = new Map<string, LimbEmbodimentBinding>();

  async get(nodeId: string): Promise<LimbEmbodimentBinding | undefined> {
    const binding = this.bindings.get(nodeId);
    return binding ? structuredClone(binding) : undefined;
  }

  async getByThread(threadId: string): Promise<LimbEmbodimentBinding[]> {
    return [...this.bindings.values()]
      .filter((binding) => binding.threadId === threadId)
      .map((binding) => structuredClone(binding));
  }

  async put(binding: LimbEmbodimentBinding): Promise<void> {
    assertBinding(binding);
    this.bindings.set(binding.nodeId, structuredClone(binding));
  }

  async remove(nodeId: string): Promise<void> {
    this.bindings.delete(nodeId);
  }
}
