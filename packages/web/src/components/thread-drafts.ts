export const threadDrafts = new Map<string, string>();
export const threadImageDrafts = new Map<string, File[]>();

export function hasPendingThreadDraft(threadId: string): boolean {
  const textDraft = threadDrafts.get(threadId);
  if (typeof textDraft === 'string' && textDraft.trim().length > 0) return true;

  const imageDrafts = threadImageDrafts.get(threadId);
  return Array.isArray(imageDrafts) && imageDrafts.length > 0;
}
