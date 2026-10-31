import type {
  IMessageStore,
  OwnerComposerDraft,
  StoredMessage,
} from '../domains/cats/services/stores/ports/MessageStore.js';
import { createModuleLogger } from '../infrastructure/logger.js';

const log = createModuleLogger('routes/sent-composer-draft-consumption');

interface CapturedDraft {
  userId: string;
  threadId: string;
  draft: OwnerComposerDraft;
}

export interface SentComposerDraftConsumptionReceipt {
  composerDraftConsumption?: { threadId: string; expectedRevision: number; revision: number };
}

function matchesStoredSend(capture: CapturedDraft, message: StoredMessage): boolean {
  const { draft, userId, threadId } = capture;
  return (
    message.userId === userId &&
    message.threadId === threadId &&
    !message.catId &&
    !message.source &&
    !message.deletedAt &&
    message.timestamp >= draft.updatedAt
  );
}

/** Capture the authenticated mounted revision; consume only the Human newly appended by this admission. */
export async function captureSentComposerDraftConsumption(
  store: IMessageStore,
  userId: string,
  threadId: string,
  expectedRevision?: number,
) {
  let draft: OwnerComposerDraft | null = null;
  if (expectedRevision !== undefined) {
    try {
      draft = await store.getOwnerComposerDraft(userId, threadId);
    } catch {
      log.warn({ threadId, expectedRevision }, 'Composer draft capture failed; sending continues');
    }
  }
  const capture = draft && draft.revision === expectedRevision ? { userId, threadId, draft } : null;
  return async (message: StoredMessage | null): Promise<SentComposerDraftConsumptionReceipt> => {
    if (!capture || !message || !matchesStoredSend(capture, message)) return {};
    try {
      const result = await store.clearOwnerComposerDraft(userId, threadId, capture.draft.revision, Date.now());
      if (result.kind !== 'cleared') return {};
      return {
        composerDraftConsumption: { threadId, expectedRevision: capture.draft.revision, revision: result.revision },
      };
    } catch {
      log.warn(
        { threadId, expectedRevision: capture.draft.revision },
        'Composer draft consumption failed; sending continues',
      );
      return {};
    }
  };
}
