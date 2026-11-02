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

/**
 * The old template prefilled this value before it was used for presentation.
 * Without a recorded choice its origin is ambiguous, not proof of user intent.
 * Retain the raw value for editing, but require an explicit choice to activate it.
 * Other existing custom nicknames retain their behavior.
 */
export function coCreatorNickname(config: Pick<CoCreatorConfig, 'nickname' | 'nicknameSource'>) {
  return config.nickname === '大当家' && config.nicknameSource !== 'user' ? undefined : config.nickname;
}

/** Familiar/role defaults preserve existing installations that predate nickname. */
export function coCreatorDisplay(
  config: Pick<CoCreatorConfig, 'name' | 'nickname' | 'nicknameSource' | 'mentionPatterns'>,
) {
  const nickname = coCreatorNickname(config);
  return {
    name: config.name,
    nickname: nickname ?? 'co-creator',
    role: nickname ?? 'operator',
    mention: config.mentionPatterns[0] ?? '@co-creator',
  };
}
