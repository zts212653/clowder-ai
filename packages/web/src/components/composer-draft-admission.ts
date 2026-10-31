import type { ContextAttachment, MessageContent } from '@cat-cafe/shared';
import {
  composerDraftSignature,
  type DurableDraftSnapshot,
  mergeHydratedDraft,
} from './durable-composer-draft-helpers';
import { mergeContextAttachments } from './durable-composer-draft-merge';

export interface ComposerAdmissionReply {
  id: string;
  content: string;
  senderCatId: string | null;
  threadId: string;
}

export interface ComposerAdmissionSnapshot {
  text: string;
  images: File[];
  contextAttachments: ContextAttachment[];
  replyTo: ComposerAdmissionReply | null;
}

export function durableDraftForAdmission(
  snapshot: ComposerAdmissionSnapshot,
  imageUrls: readonly string[],
  preservedBlocks: readonly MessageContent[],
): DurableDraftSnapshot {
  return {
    text: snapshot.text,
    imageUrls: [...imageUrls],
    contextAttachments: [...snapshot.contextAttachments],
    preservedBlocks: [...preservedBlocks],
    ...(snapshot.replyTo ? { replyTo: snapshot.replyTo.id } : {}),
  };
}

function mergeMessageBlocks(
  hydrated: readonly MessageContent[],
  attempted: readonly MessageContent[],
): MessageContent[] {
  const seen = new Set<string>();
  const merged: MessageContent[] = [];
  for (const block of [...hydrated, ...attempted]) {
    const signature = JSON.stringify(block);
    if (seen.has(signature)) continue;
    seen.add(signature);
    merged.push(block);
  }
  return merged;
}

export interface ReconciledComposerAdmission {
  snapshot: DurableDraftSnapshot;
  requiresConfirmation: boolean;
}

/**
 * A first-send attempt can start before the canonical owner draft finishes
 * hydrating. Keep both facts, but require another explicit send when hydration
 * added anything that was not part of the user's attempted message.
 */
export function reconcileComposerAdmission(
  attempted: DurableDraftSnapshot,
  hydrated: DurableDraftSnapshot,
): ReconciledComposerAdmission {
  const snapshot: DurableDraftSnapshot = {
    text: mergeHydratedDraft(hydrated.text, attempted.text),
    imageUrls: [...new Set([...attempted.imageUrls, ...hydrated.imageUrls])],
    contextAttachments: mergeContextAttachments(hydrated.contextAttachments, attempted.contextAttachments),
    preservedBlocks: mergeMessageBlocks(hydrated.preservedBlocks, attempted.preservedBlocks),
    ...(hydrated.replyTo || attempted.replyTo ? { replyTo: hydrated.replyTo ?? attempted.replyTo } : {}),
  };
  return {
    snapshot,
    requiresConfirmation:
      composerDraftSignature(
        snapshot.text,
        snapshot.imageUrls,
        snapshot.contextAttachments,
        snapshot.preservedBlocks,
        snapshot.replyTo,
      ) !==
      composerDraftSignature(
        attempted.text,
        attempted.imageUrls,
        attempted.contextAttachments,
        attempted.preservedBlocks,
        attempted.replyTo,
      ),
  };
}
