import type { MessageContent } from '@cat-cafe/shared';
import { messageSourceParts } from './message-source-parts.js';

/** Text as displayed by the existing content-block renderer. The transport serialization of
 * context attachments is not prose. Preserve each original text/quote/comment without paraphrase. */
export function messageSourceText(content: string, blocks?: readonly MessageContent[]): string {
  return messageSourceParts(content, blocks)
    .map((part) => part.text)
    .join('\n\n');
}
