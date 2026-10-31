import { builtinAccountIdForClient, type CatCafeConfig, type CatConfig, type ClientId } from '@cat-cafe/shared';
import { toAllCatConfigs } from './cat-config-loader.js';

export function isLocalAccountMember(cat: CatConfig, clientId: string): boolean {
  return cat.id !== 'gpt-pro' && cat.clientId === clientId && !!cat.cli;
}

/** Read-only legacy consensus; only a confirmed write persists a tool selection. */
export function readLocalAccountSelection(catalog: CatCafeConfig, clientId: ClientId) {
  const cats = Object.values(toAllCatConfigs(catalog)).filter((cat) => isLocalAccountMember(cat, clientId));
  const active = cats.filter((cat) => catalog.version !== 2 || catalog.roster[cat.id]?.available !== false);
  const ref = (cat: CatConfig) => cat.accountRef ?? builtinAccountIdForClient(clientId);
  const refs = new Set(active.map(ref));
  const stored = catalog.selectedAccountRefs?.[clientId];
  const accountRef = stored ?? (refs.size === 1 ? [...refs][0] : undefined);
  const state = stored ? 'selected' : refs.size > 1 ? 'mixed' : accountRef ? 'consensus' : 'empty';
  return {
    state,
    ...(accountRef ? { accountRef } : {}),
    members: cats.map((cat) => ({
      id: cat.id,
      name: cat.nickname || cat.displayName,
      avatar: cat.avatar,
      breedId: cat.breedId,
      searchText: [cat.name, cat.displayName, cat.nickname, cat.breedDisplayName, cat.id].filter(Boolean).join(' '),
      accountRef: ref(cat),
      available: active.includes(cat),
      bindingMode:
        cat.accountBindingMode === 'override'
          ? 'override'
          : (cat.accountBindingMode === 'follow' && !active.includes(cat)) || (accountRef && ref(cat) === accountRef)
            ? 'follow'
            : 'unresolved',
    })),
  };
}
