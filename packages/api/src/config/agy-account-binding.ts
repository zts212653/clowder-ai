import { createHash } from 'node:crypto';
import type { CatCafeConfig } from '@cat-cafe/shared';
import { resolveByAccountRef, validateRuntimeProviderBinding } from './account-resolver.js';
import { inspectAgyLogin } from './agy-account.js';
import { toAllCatConfigs } from './cat-config-loader.js';
import type { CodexBindingSelection } from './codex-account-binding.js';
import { isLocalAccountMember, readLocalAccountSelection } from './local-account-selection.js';

/** Reuse F320 preview/commit; only Native consumes this official CLI file login. */
export function planAgyAccountBinding(root: string, catalog: CatCafeConfig, selection: CodexBindingSelection) {
  const cats = toAllCatConfigs(catalog);
  const previous = readLocalAccountSelection(catalog, 'google');
  const local = (id: string) =>
    !!cats[id] &&
    isLocalAccountMember(cats[id], 'google') &&
    cats[id].agyProfile?.carrier === 'native' &&
    cats[id].carrier !== 'acp';
  if (selection.scope !== 'local' && (!selection.catId || !local(selection.catId)))
    throw new Error('AGY Native member required');
  const account = resolveByAccountRef(root, selection.accountRef);
  if (!account?.agy || account.client !== 'google' || account.authType !== 'oauth')
    throw new Error('AGY personal OAuth account required');
  const status = inspectAgyLogin(account.agy.credentialHome);
  if (status !== 'ready' && status !== 'refreshable')
    throw new Error('AGY 账号未登录或登录文件读不到，请先完成官方登录');
  const active = (id: string) => catalog.version !== 2 || catalog.roster[id]?.available !== false;
  const family = (id: string) =>
    catalog.version === 2 ? (catalog.roster[id]?.family ?? cats[id].breedId) : cats[id].breedId;
  const follows = (id: string) => previous.members.find((member) => member.id === id)?.bindingMode === 'follow';
  const targets = Object.keys(cats)
    .filter(
      (id) =>
        local(id) &&
        (selection.scope === 'local'
          ? active(id) && (selection.includeOverrides || follows(id))
          : selection.scope === 'cat'
            ? id === selection.catId
            : family(id) === family(selection.catId ?? '')),
    )
    .sort();
  for (const id of targets) {
    const error = validateRuntimeProviderBinding('google', account, cats[id].defaultModel);
    if (error) throw new Error(error);
  }
  return {
    previewToken: createHash('sha256').update(JSON.stringify({ catalog, selection, targets, account })).digest('hex'),
    accountRef: account.id,
    nextRequestOnly: true,
    identityVerified: false,
    selectionState: previous.state,
    targets: targets.map((id) => ({
      catId: id,
      name: cats[id].nickname || cats[id].displayName,
      previousAccountRef: cats[id].accountRef ?? 'gemini',
    })),
    exceptions:
      selection.scope === 'local'
        ? previous.members
            .filter((member) => member.available && !targets.includes(member.id))
            .map((member) => ({ catId: member.id, name: member.name, previousAccountRef: member.accountRef }))
        : [],
  };
}
