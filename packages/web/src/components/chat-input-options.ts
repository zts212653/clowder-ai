import { buildCatMentionIdentities } from '@cat-cafe/shared';
import type { CatData } from '@/hooks/useCatData';
import { formatCatDisplayName } from '@/lib/cat-display-name';
import { catColorVar } from '@/lib/cat-slug';
import { GROUP_MENTION_COLOR } from '@/lib/color-defaults';
import { getCoCreatorMentionPatterns } from '@/lib/mention-highlight';

export interface CatOption {
  id: string;
  label: string;
  desc: string;
  insert: string;
  color: string; // CSS color (var or hex) for inline style
  avatar: string;
  /** Group mention (e.g. @thread, @all) — renders group icon instead of cat avatar */
  isGroup?: boolean;
  /** F247 AC-C-4: Cloud cat (Remote MCP, no local CLI) — renders cloud tag badge */
  isCloud?: boolean;
  /** F247 AC-C-4: Human-readable provider label for cloud tag (e.g. "via ChatGPT Pro") */
  providerLabel?: string;
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
  return `@${formatCatDisplayName(cat)}`;
}

function isAvailable(cat: CatData): boolean {
  return cat.roster?.available !== false;
}

/**
 * F247 AC-C-4: Cloud provider label map.
 * Key: provider prefix matched via startsWith. Value: human-readable label.
 * Extensible — add new cloud providers here when they join.
 */
const CLOUD_PROVIDER_LABELS: ReadonlyArray<[prefix: string, label: string]> = [
  ['openai-chatgpt-pro', 'via ChatGPT Pro'],
];

/** F247 AC-C-4: Detect cloud cat and return provider label, or undefined for local cats. */
function detectCloudProvider(cat: CatData): string | undefined {
  if (!cat.provider) return undefined;
  for (const [prefix, label] of CLOUD_PROVIDER_LABELS) {
    if (cat.provider.startsWith(prefix)) return label;
  }
  return undefined;
}

export function buildCatOptions(
  cats: CatData[],
  includeUnroutable = false,
  reservedMentionPatterns: readonly string[] = getCoCreatorMentionPatterns(),
): CatOption[] {
  const breedGroups = buildBreedGroupOptions(cats);
  const identities = buildCatMentionIdentities(cats, reservedMentionPatterns);
  const individuals = cats
    .filter(
      (cat) =>
        cat.mentionPatterns.length > 0 && isAvailable(cat) && (includeUnroutable || identities.get(cat.id)?.insert),
    )
    .map((cat) => {
      const providerLabel = detectCloudProvider(cat);
      return {
        id: cat.id,
        label: formatCatLabel(cat),
        desc: cat.roleDescription,
        insert: identities.get(cat.id)?.insert ?? '',
        color: catColorVar(cat.id, 'primary'),
        avatar: cat.avatar,
        ...(providerLabel ? { isCloud: true as const, providerLabel } : {}),
      };
    });
  // Group mentions (@thread, @all, @全体xx猫) are low-frequency — put them
  // at the bottom so individual cats occupy the prime visible slots.
  // Users can still reach groups via arrow-up or by typing the filter text.
  return [...individuals, ...STATIC_GROUP_MENTIONS, ...breedGroups];
}

/** Build whisper target options from dynamic cat data.
 *  Includes ALL cats — whisper routing accepts any catId regardless of mentionPatterns. */
export function buildWhisperOptions(cats: CatData[]): CatOption[] {
  const identities = buildCatMentionIdentities(cats, getCoCreatorMentionPatterns());
  return cats.filter(isAvailable).map((cat) => ({
    id: cat.id,
    label: formatCatLabel(cat),
    desc: cat.roleDescription,
    insert: identities.get(cat.id)?.insert ?? '',
    color: cat.color.primary,
    avatar: cat.avatar,
  }));
}

/** Pure detection — returns menu trigger type from current input, or null. */
export function detectMenuTrigger(
  val: string,
  selectionStart: number,
): { type: 'mention'; start: number; filter: string } | null {
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
