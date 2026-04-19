/**
 * In-Memory Community Issue Store (F168)
 * Used for tests and as fallback when Redis is unavailable.
 */

import type { CommunityIssueItem, CreateCommunityIssueInput, UpdateCommunityIssueInput } from '@cat-cafe/shared';
import { generateId } from '@cat-cafe/shared';
import type { ICommunityIssueStore } from '../ports/CommunityIssueStore.js';

export class InMemoryCommunityIssueStore implements ICommunityIssueStore {
  private readonly items = new Map<string, CommunityIssueItem>();

  async create(input: CreateCommunityIssueInput): Promise<CommunityIssueItem | null> {
    for (const item of this.items.values()) {
      if (item.repo === input.repo && item.issueNumber === input.issueNumber) return null;
    }
    const now = Date.now();
    const item: CommunityIssueItem = {
      id: generateId(),
      repo: input.repo,
      issueNumber: input.issueNumber,
      issueType: input.issueType,
      title: input.title,
      state: 'unreplied',
      replyState: 'unreplied',
      assignedThreadId: null,
      assignedCatId: null,
      linkedPrNumbers: [],
      directionCard: null,
      ownerDecision: null,
      relatedFeature: null,
      lastActivity: { at: now, event: 'created' },
      createdAt: now,
      updatedAt: now,
    };
    this.items.set(item.id, item);
    return item;
  }

  async get(id: string): Promise<CommunityIssueItem | null> {
    return this.items.get(id) ?? null;
  }

  async getByRepoAndNumber(repo: string, issueNumber: number): Promise<CommunityIssueItem | null> {
    for (const item of this.items.values()) {
      if (item.repo === repo && item.issueNumber === issueNumber) return item;
    }
    return null;
  }

  async listByRepo(repo: string): Promise<CommunityIssueItem[]> {
    return [...this.items.values()].filter((i) => i.repo === repo).sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async listAll(): Promise<CommunityIssueItem[]> {
    return [...this.items.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async update(id: string, input: UpdateCommunityIssueInput): Promise<CommunityIssueItem | null> {
    const existing = this.items.get(id);
    if (!existing) return null;
    const updated: CommunityIssueItem = {
      ...existing,
      ...input,
      linkedPrNumbers: input.linkedPrNumbers ? [...input.linkedPrNumbers] : existing.linkedPrNumbers,
      updatedAt: Date.now(),
    };
    this.items.set(id, updated);
    return updated;
  }

  async delete(id: string): Promise<boolean> {
    return this.items.delete(id);
  }
}
