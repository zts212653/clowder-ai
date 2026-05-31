import type { CatData } from '@/hooks/useCatData';
import { catColorVar } from '@/lib/cat-slug';
import { GROUP_MENTION_COLOR } from '@/lib/color-defaults';

export interface CatOption {
  id: string;
  label: string;
  desc: string;
  insert: string;
  color: string; // CSS color (var or hex) for inline style
  avatar: string;
  /** Group mention (e.g. @thread, @all) — renders group icon instead of cat avatar */
  isGroup?: boolean;
}

/** Static group mention shortcuts — shown at top of autocomplete.
 *  Aligned with backend AgentRouter.parseGroupMentions patterns. */
const STATIC_GROUP_MENTIONS: CatOption[] = [
  {
    id: 'thread',
    label: '@thread',
    desc: '本帖全体参与猫猫',
    insert: '@thread ',
    color: GROUP_MENTION_COLOR,
    avatar: '',
    isGroup: true,
  },
  {
    id: 'all',
    label: '@all',
    desc: '全体猫猫',
    insert: '@all ',
    color: GROUP_MENTION_COLOR,
    avatar: '',
    isGroup: true,
  },
];

/** Build breed-scoped group mention options (e.g. @全体布偶猫) from cat data.
 *  Only generates options for breeds with 2+ available cats. */
function buildBreedGroupOptions(cats: CatData[]): CatOption[] {
  const breedMap = new Map<string, { displayName: string; color: string; count: number }>();
  for (const cat of cats) {
    if (!cat.breedId || !isAvailable(cat)) continue;
    const existing = breedMap.get(cat.breedId);
    if (existing) {
      existing.count++;
    } else {
      breedMap.set(cat.breedId, {
        displayName: cat.breedDisplayName ?? cat.displayName,
        color: catColorVar(cat.id, 'primary'),
        count: 1,
      });
    }
  }
  return [...breedMap.entries()]
    .filter(([, info]) => info.count >= 2)
    .map(([breedId, info]) => ({
      id: `breed:${breedId}`,
      label: `@全体${info.displayName}`,
      desc: `${info.displayName}全体 (${info.count}只)`,
      insert: `@全体${info.displayName} `,
      color: info.color,
      avatar: '',
      isGroup: true,
    }));
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
  const breedGroups = buildBreedGroupOptions(cats);
  const individuals = cats
    .filter((cat) => cat.mentionPatterns.length > 0 && isAvailable(cat))
    .map((cat) => ({
      id: cat.id,
      label: formatCatLabel(cat),
      desc: cat.roleDescription,
      insert: `@${cat.mentionPatterns[0].replace(/^@/, '')} `,
      color: catColorVar(cat.id, 'primary'),
      avatar: cat.avatar,
    }));
  // Group mentions (@thread, @all, @全体xx猫) are low-frequency — put them
  // at the bottom so individual cats occupy the prime visible slots.
  // Users can still reach groups via arrow-up or by typing the filter text.
  return [...individuals, ...STATIC_GROUP_MENTIONS, ...breedGroups];
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
