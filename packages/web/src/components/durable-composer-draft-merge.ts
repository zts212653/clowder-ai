import type { ContextAttachment } from '@cat-cafe/shared';
import { mergeHydratedDraft } from './durable-composer-draft-helpers';

export function mergeContextAttachments(
  authoritative: readonly ContextAttachment[],
  local: readonly ContextAttachment[],
): ContextAttachment[] {
  return [...new Map([...authoritative, ...local].map((attachment) => [attachment.id, attachment])).values()];
}

export function rebaseAuthoritativeText(serverText: string, baseText: string | undefined, localText: string): string {
  if (baseText === undefined || localText === baseText) return serverText;
  if (localText.startsWith(baseText)) return `${serverText}${localText.slice(baseText.length)}`;
  return mergeHydratedDraft(serverText, localText);
}
