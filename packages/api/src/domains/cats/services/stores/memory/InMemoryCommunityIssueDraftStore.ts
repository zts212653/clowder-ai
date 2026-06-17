/**
 * F235: In-memory CommunityIssueDraftStore — for tests and dev.
 *
 * Lifecycle: draft → published | cancelled (terminal).
 * INV-1: Only draft can transition. INV-3: One source → one active draft.
 */

import type { CommunityIssueDraft, CreateCommunityIssueDraftInput } from '@cat-cafe/shared';
import { createCommunityIssueDraft } from '@cat-cafe/shared';
import type { ICommunityIssueDraftStore, PublishDraftInput } from '../ports/CommunityIssueDraftStore.js';

function clone(draft: CommunityIssueDraft): CommunityIssueDraft {
  return JSON.parse(JSON.stringify(draft));
}

export class InMemoryCommunityIssueDraftStore implements ICommunityIssueDraftStore {
  private readonly drafts = new Map<string, CommunityIssueDraft>();
  /** Maps sourceId → draftId for active (non-cancelled) drafts. */
  private readonly sourceIndex = new Map<string, string>();

  async create(input: CreateCommunityIssueDraftInput): Promise<CommunityIssueDraft> {
    // INV-3: One source → one active (non-cancelled) draft
    const existingDraftId = this.sourceIndex.get(input.sourceId);
    if (existingDraftId) {
      const existing = this.drafts.get(existingDraftId);
      if (existing && existing.status !== 'cancelled') {
        throw new Error(`Source ${input.sourceId} already has an active draft: ${existingDraftId}`);
      }
    }

    const draft = createCommunityIssueDraft(input);
    this.drafts.set(draft.draftId, { ...draft } as CommunityIssueDraft);
    this.sourceIndex.set(input.sourceId, draft.draftId);
    return clone(draft);
  }

  async getById(draftId: string): Promise<CommunityIssueDraft | null> {
    const draft = this.drafts.get(draftId);
    return draft ? clone(draft) : null;
  }

  async getBySourceId(sourceId: string): Promise<CommunityIssueDraft | null> {
    const draftId = this.sourceIndex.get(sourceId);
    if (!draftId) return null;
    const draft = this.drafts.get(draftId);
    if (!draft || draft.status === 'cancelled') return null;
    return clone(draft);
  }

  async publish(input: PublishDraftInput): Promise<CommunityIssueDraft> {
    const draft = this.drafts.get(input.draftId);
    if (!draft) throw new Error(`Draft ${input.draftId} not found`);
    if (draft.status !== 'draft') {
      throw new Error(`Draft ${input.draftId} is ${draft.status}, cannot publish (not draft)`);
    }

    // Mutate in place (we clone on return)
    const mutable = draft as { -readonly [K in keyof CommunityIssueDraft]: CommunityIssueDraft[K] };
    mutable.status = 'published';
    mutable.githubIssueNumber = input.githubIssueNumber;
    mutable.githubIssueUrl = input.githubIssueUrl;
    mutable.publishedAt = Date.now();
    return clone(draft);
  }

  async cancel(draftId: string): Promise<CommunityIssueDraft> {
    const draft = this.drafts.get(draftId);
    if (!draft) throw new Error(`Draft ${draftId} not found`);
    if (draft.status !== 'draft') {
      throw new Error(`Draft ${draftId} is ${draft.status}, cannot cancel (not draft)`);
    }

    const mutable = draft as { -readonly [K in keyof CommunityIssueDraft]: CommunityIssueDraft[K] };
    mutable.status = 'cancelled';
    mutable.cancelledAt = Date.now();
    // Remove from source index so a new draft can be created (INV-3 edge)
    this.sourceIndex.delete(draft.sourceId);
    return clone(draft);
  }

  async updateContent(draftId: string, title: string, bodyMarkdown: string): Promise<CommunityIssueDraft> {
    const draft = this.drafts.get(draftId);
    if (!draft) throw new Error(`Draft ${draftId} not found`);
    if (draft.status !== 'draft') {
      throw new Error(`Draft ${draftId} is ${draft.status}, cannot update (not draft)`);
    }

    const mutable = draft as { -readonly [K in keyof CommunityIssueDraft]: CommunityIssueDraft[K] };
    mutable.title = title;
    mutable.bodyMarkdown = bodyMarkdown;
    return clone(draft);
  }
}
