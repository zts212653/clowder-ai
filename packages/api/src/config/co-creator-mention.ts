import { CO_CREATOR_MENTION_MAX_CHARS } from '@cat-cafe/shared';
import { z } from 'zod';

export { coCreatorContractMention } from '@cat-cafe/shared';

/** Keep saved handles single-line tokens; punctuation aliases remain literal. */
export const coCreatorMentionInputSchema = z
  .string()
  .trim()
  .min(1)
  .transform((value) => (value.startsWith('@') ? value : `@${value}`))
  .pipe(
    z
      .string()
      .max(CO_CREATOR_MENTION_MAX_CHARS)
      .regex(/^@[^\s<>\p{Cc}]+$/u, 'mention must be a single token without markup'),
  );
