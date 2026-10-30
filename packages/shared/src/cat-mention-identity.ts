import { type CatDisplayNameData, formatCatDisplayName } from './cat-display-name.js';

export interface CatMentionIdentityData extends CatDisplayNameData {
  readonly id: string;
  readonly mentionPatterns: readonly string[];
  readonly breedId?: string;
  readonly breedDisplayName?: string;
}

/** Human identity only. Stable ids and configured routing aliases remain unchanged. */
export function formatCatIdentityLabel(cat: CatDisplayNameData): string {
  const displayName = formatCatDisplayName(cat);
  const nickname = cat.nickname?.trim();
  const existing = [cat.displayName, displayName, cat.variantLabel].map((part) => part?.trim().toLowerCase());
  return !nickname || existing.includes(nickname.toLowerCase()) ? displayName : `${displayName} · ${nickname}`;
}

const mention = (pattern: string) => `@${pattern.replace(/^@/, '')}`;
const key = (pattern: string) => mention(pattern).toLowerCase();

/**
 * Extra user-authored mention aliases, derived afresh from the current registry.
 * Never shadow a registered alias, another stable id, a duplicate label or a group.
 * These aliases are deliberately not added to the catalog or A2A grammar.
 */
export function buildUserMentionAliases(
  cats: readonly CatMentionIdentityData[],
  reservedMentionPatterns: readonly string[] = [],
): ReadonlyMap<string, string> {
  const owners = new Map<string, Set<string>>();
  const registeredPrefixes: Array<{ alias: string; owner: string }> = [];
  const addOwner = (alias: string, id: string) => {
    const normalized = key(alias);
    const ids = owners.get(normalized) ?? new Set<string>();
    ids.add(id);
    owners.set(normalized, ids);
  };
  const groups = ['@all', '@thread', '@全体', '@本帖', '@co-creator'];
  for (const pattern of reservedMentionPatterns) {
    addOwner(pattern, '');
    registeredPrefixes.push({ alias: key(pattern), owner: '' });
  }
  for (const cat of cats) {
    addOwner(cat.id, cat.id);
    registeredPrefixes.push({ alias: key(cat.id), owner: cat.id });
    for (const pattern of cat.mentionPatterns) {
      addOwner(pattern, cat.id);
      registeredPrefixes.push({ alias: key(pattern), owner: cat.id });
    }
    addOwner(formatCatIdentityLabel(cat), cat.id);
    if (cat.breedId) groups.push(`@all-${cat.breedId}`, `@全体${cat.breedDisplayName ?? cat.displayName}`);
  }
  const aliases = new Map<string, string>();
  for (const cat of cats) {
    const label = formatCatIdentityLabel(cat);
    const alias = mention(label);
    const normalized = key(alias);
    const group = groups.some((pattern) => {
      const prefix = pattern.toLowerCase();
      const next = normalized[prefix.length];
      return normalized.startsWith(prefix) && (!next || !/[a-z0-9_.-]/.test(next));
    });
    // A registered "@name" must keep owning "@name · ordinary prose".
    const shadowsPrefix = registeredPrefixes.some(({ alias: prefix, owner }) => {
      if (owner === cat.id || !normalized.startsWith(prefix)) return false;
      const next = normalized[prefix.length];
      if (next === '.' && /[\p{L}\p{N}]/u.test(normalized[prefix.length + 1] ?? '')) return false;
      return !next || next === '.' || !/[a-z0-9_.-]/.test(next);
    });
    if (
      cat.mentionPatterns.length &&
      !/[@\r\n]/.test(label) &&
      owners.get(normalized)?.size === 1 &&
      !group &&
      !shadowsPrefix
    ) {
      aliases.set(cat.id, alias);
    }
  }
  return aliases;
}

/** One insertion policy shared by the @ menu and the recipient selector. */
export function buildCatMentionIdentities(
  cats: readonly CatMentionIdentityData[],
  reservedMentionPatterns: readonly string[] = [],
) {
  const aliases = buildUserMentionAliases(cats, reservedMentionPatterns);
  const registeredOwners = new Map<string, Set<string>>();
  for (const pattern of reservedMentionPatterns) registeredOwners.set(key(pattern), new Set(['']));
  for (const cat of cats) {
    for (const pattern of cat.mentionPatterns) {
      const normalized = key(pattern);
      const ids = registeredOwners.get(normalized) ?? new Set<string>();
      ids.add(cat.id);
      registeredOwners.set(normalized, ids);
    }
  }
  return new Map(
    cats.map((cat) => {
      const unique = cat.mentionPatterns.filter((pattern) => registeredOwners.get(key(pattern))?.size === 1);
      const canonical = unique.find((pattern) => key(pattern) === key(cat.id));
      const insert = aliases.get(cat.id) ?? canonical ?? unique[0];
      return [cat.id, { label: formatCatIdentityLabel(cat), insert: insert ? `${mention(insert)} ` : null }] as const;
    }),
  );
}
