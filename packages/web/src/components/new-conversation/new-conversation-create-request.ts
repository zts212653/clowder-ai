import type { PendingNewConversationIntent } from './first-message-admission';

export interface NewConversationCreateBody {
  idempotencyKey: string;
  projectPath?: string;
  preferredCats?: string[];
  title?: string;
  temporaryTitle?: string;
  pinned?: true;
}

export function buildNewConversationCreateBody(intent: PendingNewConversationIntent): NewConversationCreateBody {
  const title = intent.title?.trim();
  return {
    idempotencyKey: intent.createIdempotencyKey,
    ...(intent.projectPath ? { projectPath: intent.projectPath } : {}),
    ...(intent.preferredCats.length > 0 ? { preferredCats: [...intent.preferredCats] } : {}),
    ...(title
      ? { title }
      : intent.sessionImport?.firstPrompt
        ? { temporaryTitle: intent.sessionImport.firstPrompt.slice(0, 30) }
        : {}),
    ...(intent.pinned ? { pinned: true as const } : {}),
  };
}
