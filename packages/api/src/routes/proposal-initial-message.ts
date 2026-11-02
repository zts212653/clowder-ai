import { catRegistry } from '@cat-cafe/shared';
import { stripProposalLeadingMentions } from '@cat-cafe/shared/proposal-message';
import { normalizeCatIdMentionsInText, primaryMentionHandleForCatId } from '../utils/cat-mention-handle.js';

/** Strip only the leading routing salutation, leaving quoted and in-body mentions untouched. */
export function proposalMessageBody(text: string): string {
  const handles = catRegistry
    .getAllIds()
    .flatMap((id) => {
      const config = catRegistry.tryGet(id)?.config;
      return [
        `@${id}`,
        ...(config?.mentionPatterns ?? []).map((handle) => (handle.startsWith('@') ? handle : `@${handle}`)),
      ];
    })
    .sort((a, b) => b.length - a.length);
  return stripProposalLeadingMentions(normalizeCatIdMentionsInText(text), handles);
}

/** Legacy callers with no assignment list still rely on the router's explicit-message fallback. */
export function normalizeProposedMessage(
  text: string | undefined,
  preferredCats: readonly string[] | undefined,
): string | undefined {
  if (!text) return undefined;
  return preferredCats?.length ? proposalMessageBody(text) : normalizeCatIdMentionsInText(text);
}

export function assignedProposalMessage(
  text: string | undefined,
  preferredCats: readonly string[],
): string | undefined {
  const body = preferredCats.length ? proposalMessageBody(text ?? '') : (text ?? '');
  const mentions = preferredCats.map((id) => primaryMentionHandleForCatId(id) ?? `@${id}`).join('\n');
  return [mentions, body].filter(Boolean).join('\n\n') || undefined;
}
