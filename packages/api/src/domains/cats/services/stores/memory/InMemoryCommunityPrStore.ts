import { generateId } from '@cat-cafe/shared';
import type {
  CommunityPrItem,
  CreateCommunityPrInput,
  ICommunityPrStore,
  UpdateCommunityPrInput,
} from '../ports/CommunityPrStore.js';

export class InMemoryCommunityPrStore implements ICommunityPrStore {
  private readonly items = new Map<string, CommunityPrItem>();

  async create(input: CreateCommunityPrInput): Promise<CommunityPrItem | null> {
    for (const item of this.items.values()) {
      if (item.repo === input.repo && item.prNumber === input.prNumber) return null;
    }
    const now = Date.now();
    const item: CommunityPrItem = {
      id: generateId(),
      ...input,
      lastReviewedSha: null,
      updatedAt: now,
      createdAt: now,
    };
    this.items.set(item.id, item);
    return item;
  }

  async get(id: string): Promise<CommunityPrItem | null> {
    return this.items.get(id) ?? null;
  }

  async getByRepoAndNumber(repo: string, prNumber: number): Promise<CommunityPrItem | null> {
    for (const item of this.items.values()) {
      if (item.repo === repo && item.prNumber === prNumber) return item;
    }
    return null;
  }

  async listByRepo(repo: string): Promise<CommunityPrItem[]> {
    return [...this.items.values()].filter((i) => i.repo === repo).sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async listAll(): Promise<CommunityPrItem[]> {
    return [...this.items.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async update(id: string, input: UpdateCommunityPrInput): Promise<CommunityPrItem | null> {
    const existing = this.items.get(id);
    if (!existing) return null;
    const updated = { ...existing, ...input, updatedAt: Date.now() };
    this.items.set(id, updated);
    return updated;
  }

  async delete(id: string): Promise<boolean> {
    return this.items.delete(id);
  }
}
