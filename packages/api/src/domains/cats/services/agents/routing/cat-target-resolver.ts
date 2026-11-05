import type { CatAlternative, CatId, CatRoutingError } from '@cat-cafe/shared';
import { catRegistry } from '@cat-cafe/shared';
import { getRoster, resolveCatSuccessor } from '../../../../../config/cat-config-loader.js';

/** Legacy route carriers use string/CatId arrays; plugin identity remains outside catRegistry. */
export function resolveMessageTarget(
  input: string,
  plugins: readonly { id: string; alias: string }[] = [],
): ReturnType<typeof resolveCatTarget> {
  const member = resolveCatTarget(input);
  if ('ok' in member || member.error.kind !== 'cat_not_found') return member;
  const normalized = input.normalize('NFKC').replace(/^@/, '').toLowerCase();
  const plugin = plugins.find((p) => p.id === input) ?? plugins.find((p) => p.alias === normalized);
  return plugin ? { ok: plugin.id as CatId } : member;
}

function buildAlts(excludeId: string | null, preferFamily?: string): CatAlternative[] {
  const roster = getRoster();
  const configs = catRegistry.getAllConfigs();
  const successor = excludeId ? resolveCatSuccessor(excludeId) : null;
  return Object.entries(roster)
    .filter(([id, e]) => id !== '__none__' && id !== excludeId && e.available && catRegistry.has(id))
    .map(([id, e]) => ({
      catId: id as CatId,
      mention:
        configs[id]?.mentionPatterns.find((pattern) => pattern === `@${id}`) ??
        configs[id]?.mentionPatterns[0] ??
        `@${id}`,
      displayName: configs[id]?.displayName ?? id,
      family: e.family,
    }))
    .sort((a, b) => {
      const fd = +(a.family !== preferFamily) - +(b.family !== preferFamily);
      const la = roster[a.catId]?.lead ? 0 : 1;
      const lb = roster[b.catId]?.lead ? 0 : 1;
      return +(b.catId === successor) - +(a.catId === successor) || fd || la - lb || a.catId.localeCompare(b.catId);
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
  if (!catId || catId === '__none__')
    return { error: { kind: 'cat_not_found', mention: mentionOrId, alternatives: buildAlts(null) } };
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
