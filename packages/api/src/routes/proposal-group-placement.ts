import type { ThreadProposal } from '@cat-cafe/shared';
import { resolveThreadAttentionPreferences } from '../config/user-preferences-thread-attention.js';
import type { IThreadStore } from '../domains/cats/services/stores/ports/ThreadStore.js';
import {
  applyThreadAttentionGroupCommand,
  resolveThreadAttentionGroups,
} from '../domains/thread-navigation/thread-attention-group-metadata.js';

export async function suggestProposalGroup(
  store: IThreadStore,
  userId: string,
  sourceThreadId: string,
  title: string,
  explicit: string | null | undefined,
  projectRoot?: string,
): Promise<Pick<ThreadProposal, 'suggestedGroupId' | 'groupSuggestionReason'>> {
  const groups = await resolveThreadAttentionGroups(store, userId);
  if (explicit === null) return { groupSuggestionReason: 'none' };
  if (explicit !== undefined) {
    if (!groups.some((group) => group.id === explicit))
      throw new Error('Suggested Group does not exist or does not belong to the current user');
    return { suggestedGroupId: explicit, groupSuggestionReason: 'explicit' };
  }
  const source = groups.find((group) => group.threadIds.includes(sourceThreadId));
  if (source) return { suggestedGroupId: source.id, groupSuggestionReason: 'source-thread' };
  const aliases = projectRoot ? resolveThreadAttentionPreferences(projectRoot).aliases : {};
  const features = title.match(/\bF\d+\b/gi) ?? [];
  const match = groups.find((group) =>
    features.some((feature) => new RegExp(`\\bF?${feature.slice(1)}\\b`, 'i').test(aliases[`group:${group.id}`] ?? '')),
  );
  return match
    ? { suggestedGroupId: match.id, groupSuggestionReason: 'feature-title' }
    : { groupSuggestionReason: 'none' };
}

export async function validateProposalGroup(
  store: IThreadStore,
  userId: string,
  groupId: string | null | undefined,
): Promise<boolean> {
  return !groupId || (await resolveThreadAttentionGroups(store, userId)).some((group) => group.id === groupId);
}

/** Replayed from the checkpointed approval choice, never from an unapproved suggestion. */
export async function placeApprovedProposalGroup(store: IThreadStore, proposal: ThreadProposal): Promise<void> {
  if (!proposal.attentionGroupId || !proposal.createdThreadId) return;
  const metadata = await store.getThreadMetadata(proposal.createdThreadId);
  if (metadata?.attentionGroup?.groupId === proposal.attentionGroupId) return;
  await applyThreadAttentionGroupCommand(store, proposal.createdBy, {
    action: 'move',
    groupId: proposal.attentionGroupId,
    threadId: proposal.createdThreadId,
  });
}
