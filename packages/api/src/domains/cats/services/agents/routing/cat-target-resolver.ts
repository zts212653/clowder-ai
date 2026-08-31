import type { CatAlternative, CatId, CatRoutingError } from '@cat-cafe/shared';
import { catRegistry } from '@cat-cafe/shared';
import { getRoster } from '../../../../../config/cat-config-loader.js';

function buildAlts(excludeId: string | null, preferFamily?: string): CatAlternative[] {
  const roster = getRoster();
  const configs = catRegistry.getAllConfigs();
  return Object.entries(roster)
    .filter(([id, e]) => id !== excludeId && e.available && catRegistry.has(id))
    .map(([id, e]) => ({
      catId: id as CatId,
      mention: configs[id]?.mentionPatterns[0] ?? `@${id}`,
      displayName: configs[id]?.displayName ?? id,
      family: e.family,
    }))
    .sort((a, b) => {
      const fd = +(a.family !== preferFamily) - +(b.family !== preferFamily);
      const la = roster[a.catId]?.lead ? 0 : 1;
      const lb = roster[b.catId]?.lead ? 0 : 1;
      return fd || la - lb || a.catId.localeCompare(b.catId);
    });
}

/**
 * F257 #1 — routing token view: token → holders, merged from THREE intent
 * sources (sol review F2/F5 rework):
 *
 *   1. mentionPatterns — explicit route aliases
 *   2. `@<nickname>`   — a nickname is a routing identity: @砚砚 means "the cat
 *      nicknamed 砚砚", so EVERY nickname holder holds the token, regardless of
 *      who happens to list it as a pattern (dev-628ea4d1: pattern view alone
 *      routed @砚砚 to codex while five cats carried the nickname)
 *   3. `@<catId>`      — canonical reserved namespace: every cat always owns one
 *      explicit handle the parser recognizes, so ambiguity warnings can always
 *      offer a retryable disambiguation
 *
 * A token with >1 holder is ambiguous — routing refuses to guess. Shared by
 * resolveCatTarget / AgentRouter / a2a-mentions so all three routing surfaces
 * see the identical holder view.
 */
export function groupRoutingTokenHolders(): Map<string, CatId[]> {
  const holdersByToken = new Map<string, CatId[]>();
  const add = (token: string, catId: CatId) => {
    const key = token.trim().toLowerCase();
    if (!key || key === '@') return;
    const holders = holdersByToken.get(key) ?? [];
    if (!holders.includes(catId)) holders.push(catId);
    holdersByToken.set(key, holders);
  };
  for (const [id, cfg] of Object.entries(catRegistry.getAllConfigs())) {
    const catId = id as CatId;
    for (const p of cfg.mentionPatterns) add(p, catId);
    if (cfg.nickname) add(`@${cfg.nickname}`, catId);
    add(`@${id}`, catId);
  }
  return holdersByToken;
}

/**
 * F257 #1 (dev-628ea4d1): disambiguation candidates for a multi-holder token.
 * Each candidate must carry a handle that the SAME parser resolves uniquely
 * (sol F5: a suggested handle the parser doesn't recognize sends the retry to
 * the default cat). Preference: an unambiguous explicit pattern → canonical
 * @catId (always present in the token view; unique unless another cat squats
 * on it, which the view itself then surfaces as ambiguous).
 */
export function buildAmbiguousCandidates(holderIds: readonly string[]): CatAlternative[] {
  const roster = getRoster();
  const configs = catRegistry.getAllConfigs();
  const holdersByToken = groupRoutingTokenHolders();
  const isUnique = (token: string) => (holdersByToken.get(token.trim().toLowerCase()) ?? []).length === 1;
  return holderIds.map((id) => {
    const cfg = configs[id];
    const uniqueHandle = [...(cfg?.mentionPatterns ?? []), `@${id}`].find(isUnique);
    return {
      catId: id as CatId,
      mention: uniqueHandle ?? `@${id}`,
      displayName: cfg?.displayName ?? id,
      family: roster[id]?.family ?? '',
    };
  });
}

export function resolveCatTarget(mentionOrId: string): { ok: CatId } | { error: CatRoutingError } {
  const input = (mentionOrId.startsWith('@') ? mentionOrId.slice(1) : mentionOrId).toLowerCase();
  const configs = catRegistry.getAllConfigs();
  let catId: string | undefined = catRegistry.has(input) ? input : undefined;
  if (!catId) {
    // F257 #1: consult the unified token view (patterns ∪ nicknames ∪ canonical)
    // — a token held by more than one cat refuses resolution rather than
    // silently picking one (sol F2: nickname collisions must surface here too).
    const holders = groupRoutingTokenHolders().get(`@${input}`) ?? [];
    if (holders.length > 1) {
      return {
        error: { kind: 'mention_ambiguous', mention: mentionOrId, candidates: buildAmbiguousCandidates(holders) },
      };
    }
    catId = holders[0] as string | undefined;
  }
  if (!catId) return { error: { kind: 'cat_not_found', mention: mentionOrId, alternatives: buildAlts(null) } };
  // KD-9: two-step check — isCatAvailable not used (it returns true for not-in-roster)
  // cats not in roster = available (backward compat); only explicit available:false = disabled
  const entry = getRoster()[catId];
  if (entry && entry.available === false) {
    return {
      error: {
        kind: 'cat_disabled',
        catId: catId as CatId,
        displayName: configs[catId]?.displayName ?? catId,
        alternatives: buildAlts(catId, entry.family),
      },
    };
  }
  return { ok: catId as CatId };
}
