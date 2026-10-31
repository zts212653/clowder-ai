import { createHash } from 'node:crypto';
import { builtinAccountFamilyForRef, type CatCafeConfig } from '@cat-cafe/shared';
import { resolveByAccountRef, validateRuntimeProviderBinding } from './account-resolver.js';
import { toAllCatConfigs } from './cat-config-loader.js';
import { claudeExecutionAccountSnapshot } from './claude-token-account.js';
import type { CodexBindingSelection } from './codex-account-binding.js';
import { isLocalAccountMember, readLocalAccountSelection } from './local-account-selection.js';

/** Same explicit preview/commit contract as Codex; no login or credential writes. */
export function planClaudeAccountBinding(root: string, catalog: CatCafeConfig, selection: CodexBindingSelection) {
  const cats = toAllCatConfigs(catalog);
  const previous = readLocalAccountSelection(catalog, 'anthropic');
  const local = (id: string) => !!cats[id] && isLocalAccountMember(cats[id], 'anthropic');
  if (selection.scope !== 'local' && (!selection.catId || !local(selection.catId)))
    throw new Error('claude_local_member_required');
  const profile = resolveByAccountRef(root, selection.accountRef);
  if (
    !profile ||
    (profile.authType === 'oauth' && !profile.claude && builtinAccountFamilyForRef(profile.id) !== 'anthropic')
  )
    throw new Error('claude_account_required');
  const admission = validateRuntimeProviderBinding('anthropic', profile);
  if (admission) throw new Error(admission);
  const active = (id: string) => catalog.version !== 2 || catalog.roster[id]?.available !== false;
  const family = (id: string) =>
    catalog.version === 2 ? (catalog.roster[id]?.family ?? cats[id].breedId) : cats[id].breedId;
  const targets = Object.keys(cats)
    .filter(
      (id) =>
        local(id) &&
        (selection.scope === 'local'
          ? active(id) &&
            (selection.includeOverrides || previous.members.find((m) => m.id === id)?.bindingMode === 'follow')
          : selection.scope === 'cat'
            ? id === selection.catId
            : family(id) === family(selection.catId ?? '')),
    )
    .sort();
  for (const id of targets) {
    const error = validateRuntimeProviderBinding('anthropic', profile, cats[id].defaultModel);
    if (error) throw new Error(error);
  }
  const snapshot = claudeExecutionAccountSnapshot(profile);
  return {
    previewToken: createHash('sha256')
      .update(JSON.stringify({ catalog, selection, targets, revision: snapshot.accountRevision }))
      .digest('hex'),
    accountRef: profile.id,
    nextRequestOnly: true,
    identityVerified: false,
    selectionState: previous.state,
    targets: targets.map((id) => ({
      catId: id,
      name: cats[id].nickname || cats[id].displayName,
      previousAccountRef: cats[id].accountRef ?? 'claude',
    })),
    exceptions:
      selection.scope === 'local'
        ? previous.members
            .filter((m) => m.available && !targets.includes(m.id))
            .map((m) => ({ catId: m.id, name: m.name, previousAccountRef: m.accountRef }))
        : [],
  };
}
