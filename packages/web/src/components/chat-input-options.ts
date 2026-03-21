import type { CatData } from '@/hooks/useCatData';

export interface CatOption {
  id: string;
  label: string;
  desc: string;
  insert: string;
  color: string; // hex color (for inline style)
  avatar: string;
}

/** Build @mention autocomplete options from dynamic cat data.
 *  Filters out cats with no mentionPatterns (not routable via @mention). */
/** Format display label with optional variant disambiguation */
function formatCatLabel(cat: CatData): string {
  return cat.variantLabel ? `@${cat.displayName} (${cat.variantLabel})` : `@${cat.displayName}`;
}

function isAvailable(cat: CatData): boolean {
  return cat.roster?.available !== false;
}

export function buildCatOptions(cats: CatData[]): CatOption[] {
  return cats
    .filter((cat) => cat.mentionPatterns.length > 0 && isAvailable(cat))
    .map((cat) => ({
      id: cat.id,
      label: formatCatLabel(cat),
      desc: cat.roleDescription,
      insert: `@${cat.mentionPatterns[0].replace(/^@/, '')} `,
      color: cat.color.primary,
      avatar: cat.avatar,
    }));
}

/** Build whisper target options from dynamic cat data.
 *  Includes ALL cats — whisper routing accepts any catId regardless of mentionPatterns. */
export function buildWhisperOptions(cats: CatData[]): CatOption[] {
  return cats.filter(isAvailable).map((cat) => ({
    id: cat.id,
    label: formatCatLabel(cat),
    desc: cat.roleDescription,
    insert: cat.mentionPatterns.length > 0 ? `@${cat.mentionPatterns[0].replace(/^@/, '')} ` : '',
    color: cat.color.primary,
    avatar: cat.avatar,
  }));
}

/** Layer 1: game list (currently only werewolf) */
export const GAME_LIST = [
  {
    id: 'werewolf',
    label: '狼人杀',
    desc: '经典推理对抗',
  },
] as const;

/** Layer 2: mode options after selecting a game */
export const WEREWOLF_MODES = [
  { id: 'player', label: '玩家模式', desc: '当一名玩家参与', command: '/game werewolf player' },
  { id: 'god-view', label: '上帝视角', desc: '观战所有角色动态', command: '/game werewolf god-view' },
  { id: 'detective', label: '推理模式', desc: '绑定一只猫的视角推理', command: '/game werewolf detective' },
  { id: 'player-voice', label: '玩家模式（语音）', desc: '语音发言+互动', command: '/game werewolf player voice' },
  { id: 'god-view-voice', label: '上帝视角（语音）', desc: '语音观战体验', command: '/game werewolf god-view voice' },
] as const;

export type GameListItem = (typeof GAME_LIST)[number];
export type GameModeItem = (typeof WEREWOLF_MODES)[number];

/** Pure detection — returns menu trigger type from current input, or null. */
export function detectMenuTrigger(
  val: string,
  selectionStart: number,
): { type: 'game' } | { type: 'mention'; start: number; filter: string } | null {
  const trimmed = val.trimStart();
  if (/^\/g(a(m(e( )?)?)?)?$/i.test(trimmed) && trimmed.length <= 6) {
    return { type: 'game' };
  }
  const textBefore = val.slice(0, selectionStart);
  const atIdx = textBefore.lastIndexOf('@');
  if (atIdx >= 0) {
    const fragment = textBefore.slice(atIdx + 1);
    const charBefore = atIdx > 0 ? val[atIdx - 1] : ' ';
    if (/\s/.test(charBefore!) && fragment.length <= 12 && !/\s/.test(fragment)) {
      return { type: 'mention', start: atIdx, filter: fragment };
    }
  }
  return null;
}
