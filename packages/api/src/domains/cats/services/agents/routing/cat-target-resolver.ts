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

export function resolveCatTarget(mentionOrId: string): { ok: CatId } | { error: CatRoutingError } {
  const input = (mentionOrId.startsWith('@') ? mentionOrId.slice(1) : mentionOrId).toLowerCase();
  const configs = catRegistry.getAllConfigs();
  let catId: string | undefined = catRegistry.has(input) ? input : undefined;
  if (!catId) {
    outer: for (const [id, cfg] of Object.entries(configs)) {
      for (const p of cfg.mentionPatterns) {
        if ((p.startsWith('@') ? p.slice(1) : p).toLowerCase() === input) {
          catId = id;
          break outer;
        }
      }
    }
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
