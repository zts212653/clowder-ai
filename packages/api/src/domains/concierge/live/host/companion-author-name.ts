import { catRegistry } from '@cat-cafe/shared';

/** A historical label belongs to the message author, never today's selected companion. */
export function companionAuthorName(catId: string | null | undefined): string {
  if (!catId) return '你';
  const cat = catRegistry.tryGet(catId)?.config;
  return (cat?.nickname?.trim() || cat?.displayName || catId).slice(0, 256);
}
