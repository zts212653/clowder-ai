import type { RedisClient } from '@cat-cafe/shared/utils';
import type { ILabelStore, ThreadLabel } from '../ports/ThreadStore.js';
import { RedisLabelStore } from '../redis/RedisLabelStore.js';

class InMemoryLabelStore implements ILabelStore {
  private labels = new Map<string, ThreadLabel>();
  private userLabels = new Map<string, string[]>();

  async create(label: ThreadLabel): Promise<ThreadLabel> {
    this.labels.set(label.id, { ...label });
    const list = this.userLabels.get(label.createdBy) ?? [];
    list.push(label.id);
    this.userLabels.set(label.createdBy, list);
    return { ...label };
  }

  async list(userId: string): Promise<ThreadLabel[]> {
    const ids = this.userLabels.get(userId) ?? [];
    return ids
      .map((id) => this.labels.get(id))
      .filter((l): l is ThreadLabel => l !== undefined)
      .sort((a, b) => a.sortOrder - b.sortOrder);
  }

  async get(id: string): Promise<ThreadLabel | null> {
    return this.labels.get(id) ? { ...this.labels.get(id)! } : null;
  }

  async update(
    id: string,
    userId: string,
    fields: Partial<Pick<ThreadLabel, 'name' | 'color' | 'sortOrder'>>,
  ): Promise<ThreadLabel | null> {
    const existing = this.labels.get(id);
    if (!existing || existing.createdBy !== userId) return null;
    if (fields.name !== undefined) existing.name = fields.name;
    if (fields.color !== undefined) existing.color = fields.color;
    if (fields.sortOrder !== undefined) existing.sortOrder = fields.sortOrder;
    return { ...existing };
  }

  async delete(id: string, userId: string): Promise<boolean> {
    const existing = this.labels.get(id);
    if (!existing || existing.createdBy !== userId) return false;
    this.labels.delete(id);
    const list = this.userLabels.get(userId);
    if (list) {
      const idx = list.indexOf(id);
      if (idx !== -1) list.splice(idx, 1);
    }
    return true;
  }
}

export function createLabelStore(redis?: RedisClient): ILabelStore {
  if (redis) {
    return new RedisLabelStore(redis);
  }
  return new InMemoryLabelStore();
}
