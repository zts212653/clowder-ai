import { createHash } from 'node:crypto';
import { builtinAccountIdForClient, type CatCafeConfig, type CatConfig } from '@cat-cafe/shared';
import {
  type RuntimeProviderProfile,
  resolveByAccountRef,
  validateRuntimeProviderBinding,
} from './account-resolver.js';
import { toAllCatConfigs } from './cat-config-loader.js';
import { inspectCodexLogin } from './codex-account-identity.js';
import { resolveCodexAccountLaunch } from './codex-account-launch.js';
import { usesNativeCodexThirdPartyProvider } from './codex-native-provider-admission.js';
import { assertCodexSharedStateRoots } from './codex-shared-state.js';
import { isLocalAccountMember, readLocalAccountSelection } from './local-account-selection.js';

export interface CodexBindingSelection {
  accountRef: string;
  catId?: string;
  scope: 'cat' | 'family' | 'local';
  includeOverrides?: boolean;
}

/** Explicit native-default selection requires the same observable login as the account directory. */
export function assertNativeCodexAccountReady(projectRoot: string, profile: RuntimeProviderProfile) {
  if (profile.authType !== 'oauth' || profile.codex) return;
  const launch = resolveCodexAccountLaunch(profile, { cwd: projectRoot });
  const observation = inspectCodexLogin(launch.credentialHome, projectRoot);
  if (observation.status !== 'ready') throw new Error('本机默认号未登录或读不到，请先在官方工具里登录');
  return observation.identity;
}

/** Admit the complete state about to be persisted, independent of the HTTP entry point or binding mode. */
export function assertCodexMemberMutationReady(
  projectRoot: string,
  nextCatalog: CatCafeConfig,
  catId: string,
  previous?: { cat: CatConfig; available: boolean },
  bindingConfirmed = false,
): void {
  const next = toAllCatConfigs(nextCatalog)[catId];
  if (!next) throw new Error(`Cat "${catId}" missing from the candidate catalog`);
  const active = nextCatalog.version !== 2 || nextCatalog.roster[catId]?.available !== false;
  if (!active || !isLocalAccountMember(next, 'openai')) return;
  const accountRef = next.accountRef ?? 'codex';
  if (
    previous?.available &&
    isLocalAccountMember(previous.cat, 'openai') &&
    (previous.cat.accountRef ?? 'codex') === accountRef &&
    !bindingConfirmed
  )
    return; // Read/edit an existing binding without requiring reauthentication.
  const profile = resolveByAccountRef(projectRoot, accountRef);
  if (!profile) throw new Error('Codex account not found');
  const compatibilityError = validateRuntimeProviderBinding('openai', profile, next.defaultModel);
  if (compatibilityError) throw new Error(compatibilityError);
  if (next.configurationSource === 'native_tool' && !next.accountRef && profile.syntheticNative) {
    const launch = resolveCodexAccountLaunch(profile, { cwd: projectRoot });
    // Match CodexAgentService's member argument tokenization. Explicit account
    // selection and account-switch operations retain their existing auth contract.
    const args = (next.cliConfigArgs ?? []).flatMap((arg) => arg.trim().split(/\s+/));
    if (usesNativeCodexThirdPartyProvider(launch.credentialHome, projectRoot, args)) return;
  }
  assertNativeCodexAccountReady(projectRoot, profile);
}
export function planCodexAccountBinding(projectRoot: string, catalog: CatCafeConfig, selection: CodexBindingSelection) {
  const cats = toAllCatConfigs(catalog);
  const local = (id: string) => !!cats[id] && isLocalAccountMember(cats[id], 'openai');
  if (selection.scope !== 'local' && (!selection.catId || !local(selection.catId)))
    throw new Error('Only local Codex members can switch accounts');
  const active = (id: string) => catalog.version !== 2 || catalog.roster[id]?.available !== false;
  const previous = readLocalAccountSelection(catalog, 'openai');
  const follows = (id: string) =>
    previous.members.find((m) => m.id === id)?.bindingMode === 'follow' ||
    (!previous.accountRef && (cats[id].accountRef ?? 'codex') === selection.accountRef);
  const family = (id: string) =>
    catalog.version === 2 ? (catalog.roster[id]?.family ?? cats[id].breedId) : cats[id].breedId;
  const targets = Object.keys(cats)
    .filter(
      (id) =>
        local(id) &&
        (selection.scope === 'local'
          ? active(id) && (selection.includeOverrides || follows(id))
          : selection.scope === 'cat'
            ? id === selection.catId
            : family(id) === family(selection.catId!)),
    )
    .sort();
  const profile = resolveByAccountRef(projectRoot, selection.accountRef);
  if (!profile) throw new Error('Codex account not found');
  const admission = validateRuntimeProviderBinding('openai', profile);
  if (admission) throw new Error(admission);
  for (const id of targets) {
    const error = validateRuntimeProviderBinding('openai', profile, cats[id].defaultModel);
    if (error) throw new Error(error);
  }
  const launch = resolveCodexAccountLaunch(profile, { cwd: projectRoot });
  const nativeIdentity = assertNativeCodexAccountReady(projectRoot, profile);
  if (launch.managed || launch.accountRef === 'codex') assertCodexSharedStateRoots(projectRoot, { launch });
  const previewToken = createHash('sha256')
    .update(
      JSON.stringify({
        catalog,
        targets,
        selection,
        accountRevision: launch.accountRevision,
        ...(nativeIdentity
          ? { nativeIdentity: { userId: nativeIdentity.userId, workspaceId: nativeIdentity.workspaceId } }
          : {}),
      }),
    )
    .digest('hex');
  return {
    previewToken,
    accountRef: selection.accountRef,
    exceptions:
      selection.scope === 'local'
        ? previous.members
            .filter((m) => m.available && !targets.includes(m.id))
            .map((m) => ({
              catId: m.id,
              name: m.name,
              previousAccountRef: m.accountRef,
              previousAccountName: m.accountRef
                ? (resolveByAccountRef(projectRoot, m.accountRef)?.displayName ?? m.accountRef)
                : '未指定账号',
            }))
        : [],
    selectionState: previous.state,
    targets: targets.map((id) => ({
      catId: id,
      name: cats[id].nickname || cats[id].displayName,
      previousAccountRef: cats[id].accountRef ?? builtinAccountIdForClient('openai'),
    })),
    nextRequestOnly: true,
  };
}
