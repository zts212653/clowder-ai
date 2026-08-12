import { deriveAutoThreadTitle, type IThreadStore } from '../domains/cats/services/stores/ports/ThreadStore.js';

type RecallTitleStore = Pick<IThreadStore, 'get' | 'compareAndSetTitle'>;

export interface DerivedTitleSuppression {
  expectedTitle: string;
  replacementTitle: string;
}

export async function prepareDerivedTitleSuppression(
  threadStore: RecallTitleStore,
  threadId: string,
  messageContent: string,
): Promise<DerivedTitleSuppression | null> {
  const expectedTitle = deriveAutoThreadTitle(messageContent);
  if (!expectedTitle) return null;
  const thread = await threadStore.get(threadId);
  if (!thread) throw new Error(`Thread ${threadId} is unavailable during true recall`);
  if (thread.title !== expectedTitle) return null;
  const replacementTitle = `Thread ${threadId.slice(0, 12)}`;
  const changed = await threadStore.compareAndSetTitle(threadId, expectedTitle, replacementTitle);
  return changed ? { expectedTitle, replacementTitle } : null;
}

export async function restoreDerivedTitleSuppression(
  threadStore: RecallTitleStore,
  threadId: string,
  suppression: DerivedTitleSuppression,
): Promise<boolean> {
  return threadStore.compareAndSetTitle(threadId, suppression.replacementTitle, suppression.expectedTitle);
}
