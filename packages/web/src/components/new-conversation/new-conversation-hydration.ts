import type { ContextAttachment } from '@cat-cafe/shared';
import { apiFetch } from '@/utils/api-client';
import { getContextAttachmentDraft, threadImageDrafts } from '../thread-drafts';
import type { PendingNewConversationIntent } from './first-message-admission';
import { loadNewConversationIntent } from './new-conversation-intent-store';

const DRAFT_THREAD_ID = 'default';
function randomUuid(): string {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  const hex = (length: number) => Array.from({ length }, () => Math.floor(Math.random() * 16).toString(16)).join('');
  return `${hex(8)}-${hex(4)}-4${hex(3)}-${['8', '9', 'a', 'b'][Math.floor(Math.random() * 4)]}${hex(3)}-${hex(12)}`;
}

export function freshIntent(projectPath?: string): PendingNewConversationIntent {
  return {
    v: 1,
    createIdempotencyKey: randomUuid(),
    messageIdempotencyKey: randomUuid(),
    ...(projectPath ? { projectPath } : {}),
    preferredCats: [],
    creationStarted: false,
  };
}

async function readOwner(signal: AbortSignal): Promise<string> {
  const response = await apiFetch('/api/session', { signal });
  if (!response.ok) throw new Error('session unavailable');
  const body = (await response.json()) as { userId?: unknown };
  if (typeof body.userId !== 'string' || !body.userId.trim()) throw new Error('session owner unavailable');
  return body.userId;
}

async function readCwd(signal: AbortSignal): Promise<string | undefined> {
  try {
    const response = await apiFetch('/api/projects/cwd', { signal });
    if (!response.ok) return undefined;
    const body = (await response.json()) as { path?: unknown };
    return typeof body.path === 'string' && body.path.trim() ? body.path : undefined;
  } catch {
    return undefined;
  }
}

export interface HydratedAdmissionState {
  ownerUserId: string;
  intent: PendingNewConversationIntent;
  files: File[];
  contextAttachments: ContextAttachment[];
}

export async function hydrateAdmissionState(signal: AbortSignal): Promise<HydratedAdmissionState> {
  const [ownerUserId, cwd] = await Promise.all([readOwner(signal), readCwd(signal)]);
  const stored = await loadNewConversationIntent(ownerUserId);
  return {
    ownerUserId,
    intent: stored?.intent ?? freshIntent(cwd),
    files: stored?.files ?? threadImageDrafts.get(DRAFT_THREAD_ID) ?? [],
    contextAttachments: stored?.contextAttachments ?? [...getContextAttachmentDraft(DRAFT_THREAD_ID)],
  };
}
