import type { CoCreatorConfig } from './types/cat-breed.js';

export const CO_CREATOR_MENTION_MAX_CHARS = 64;

/** Legacy handles must remain literal and bounded wherever tool/prompt text embeds them. */
export function coCreatorContractMention(mention: string): string | undefined {
  if (mention.length > CO_CREATOR_MENTION_MAX_CHARS) return undefined;
  if (/^@[\p{L}\p{M}\p{N}_.()+-]+$/u.test(mention)) return mention;
  const literal = JSON.stringify(mention).replace(
    /[<>&\u2028\u2029]/g,
    (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
  return literal.length <= 128 ? literal : undefined;
}

/** Familiar/role defaults preserve existing installations that predate nickname. */
export function coCreatorDisplay(config: Pick<CoCreatorConfig, 'name' | 'nickname' | 'mentionPatterns'>) {
  return {
    name: config.name,
    nickname: config.nickname ?? 'co-creator',
    role: config.nickname ?? 'operator',
    mention: config.mentionPatterns[0] ?? '@co-creator',
  };
}
