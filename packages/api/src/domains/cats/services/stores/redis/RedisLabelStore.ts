import type { RedisClient } from '@cat-cafe/shared/utils';
import type { ILabelStore, ThreadLabel } from '../ports/ThreadStore.js';
import { LabelKeys } from '../redis-keys/label-keys.js';

export class RedisLabelStore implements ILabelStore {
  private readonly redis: RedisClient;

  constructor(redis: RedisClient) {
    this.redis = redis;
  }

  private serializeLabel(label: ThreadLabel): Record<string, string> {
    return {
      id: label.id,
      name: label.name,
      color: label.color,
      sortOrder: String(label.sortOrder),
      createdBy: label.createdBy,
      createdAt: String(label.createdAt),
    };
  }

  private hydrateLabel(data: Record<string, string>): ThreadLabel | null {
    if (!data.id) return null;
    return {
      id: data.id,
      name: data.name ?? '',
      color: data.color ?? '#888888',
      sortOrder: Number.parseInt(data.sortOrder ?? '0', 10),
      createdBy: data.createdBy ?? '',
      createdAt: Number.parseInt(data.createdAt ?? '0', 10),
    };
  }

  async create(label: ThreadLabel): Promise<ThreadLabel> {
    await this.redis.hset(LabelKeys.detail(label.id), this.serializeLabel(label));
    await this.redis.zadd(LabelKeys.userList(label.createdBy), label.sortOrder, label.id);
    return label;
  }

  async list(userId: string): Promise<ThreadLabel[]> {
    const ids = await this.redis.zrange(LabelKeys.userList(userId), 0, -1);
    if (ids.length === 0) return [];
    const labels: ThreadLabel[] = [];
    for (const id of ids) {
      const data = await this.redis.hgetall(LabelKeys.detail(id));
      const label = this.hydrateLabel(data);
      if (label) labels.push(label);
    }
    return labels;
  }

  async get(id: string): Promise<ThreadLabel | null> {
    const data = await this.redis.hgetall(LabelKeys.detail(id));
    return this.hydrateLabel(data);
  }

  async update(
    id: string,
    userId: string,
    fields: Partial<Pick<ThreadLabel, 'name' | 'color' | 'sortOrder'>>,
  ): Promise<ThreadLabel | null> {
    const existing = await this.get(id);
    if (!existing || existing.createdBy !== userId) return null;

    const updates: Record<string, string> = {};
    if (fields.name !== undefined) updates.name = fields.name;
    if (fields.color !== undefined) updates.color = fields.color;
    if (fields.sortOrder !== undefined) updates.sortOrder = String(fields.sortOrder);

    if (Object.keys(updates).length > 0) {
      await this.redis.hset(LabelKeys.detail(id), updates);
    }
    if (fields.sortOrder !== undefined) {
      await this.redis.zadd(LabelKeys.userList(existing.createdBy), fields.sortOrder, id);
    }
    return this.get(id);
  }

  async delete(id: string, userId: string): Promise<boolean> {
    const existing = await this.get(id);
    if (!existing || existing.createdBy !== userId) return false;
    await this.redis.del(LabelKeys.detail(id));
    await this.redis.zrem(LabelKeys.userList(userId), id);
    return true;
  }
}
