import { createHash } from 'node:crypto';
import type { CatConfig, ExecutionAccountSnapshot } from '@cat-cafe/shared';
import {
  type RuntimeProviderProfile,
  resolveBuiltinClientForProvider,
  validateRuntimeProviderBinding,
} from '../../../../../config/account-resolver.js';
import { AccountStoreVerdictError } from '../../../../../config/account-store-format.js';
import { resolveBoundAccountRefForCat } from '../../../../../config/cat-account-binding.js';
import { resolveCatRuntimeAccount } from '../../../../../config/cat-runtime-account.js';
import { claudeExecutionAccountSnapshot } from '../../../../../config/claude-token-account.js';
import {
  type CodexAccountLaunchDescriptor,
  resolveCodexAccountLaunch,
} from '../../../../../config/codex-account-launch.js';
import { codexExecutionAccountSnapshot } from '../../../../../config/codex-execution-account.js';
import { resolveActiveProjectRoot } from '../../../../../utils/active-project-root.js';
import type { FrozenExecutionWorkspace } from './execution-workspace.js';

/** A Host-admitted, execution-local choice. It never writes the member catalog. */
export interface ExecutionAccountSelection {
  readonly accountRef: string;
  readonly authType: 'oauth' | 'api_key';
  readonly expectedRevision?: string;
}

export interface FrozenExecutionBinding {
  readonly catConfig?: CatConfig;
  readonly workspace: FrozenExecutionWorkspace;
  readonly projectRoot: string;
  readonly effectiveAccountRef?: string;
  readonly resolvedAccount: RuntimeProviderProfile | null;
  readonly codexAccountLaunch?: CodexAccountLaunchDescriptor;
  readonly executionAccount?: ExecutionAccountSnapshot;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

/** In-memory carrier only: never persist credentials in Queue/TurnExecution provenance. */
export function freezeExecutionAccountBinding(input: {
  catId: string;
  catConfig?: CatConfig;
  model?: string;
  workspace: FrozenExecutionWorkspace;
  accountSelection?: ExecutionAccountSelection;
}): FrozenExecutionBinding {
  const selection = input.accountSelection ? { ...input.accountSelection } : undefined;
  if (
    selection &&
    (!input.catConfig ||
      typeof selection.accountRef !== 'string' ||
      !selection.accountRef ||
      selection.accountRef.length > 256 ||
      selection.accountRef.trim() !== selection.accountRef ||
      !['oauth', 'api_key'].includes(selection.authType) ||
      (selection.expectedRevision !== undefined && !/^[a-f0-9]{64}$/.test(selection.expectedRevision)))
  )
    throw new Error('invalid execution account selection');
  const catConfig = input.catConfig
    ? deepFreeze({
        ...structuredClone(input.catConfig),
        ...(selection ? { accountRef: selection.accountRef, accountBindingMode: 'override' as const } : {}),
      })
    : undefined;
  const provider = catConfig?.clientId;
  const client = provider ? resolveBuiltinClientForProvider(provider) : null;
  const projectRoot = resolveActiveProjectRoot(process.cwd());
  const effectiveAccountRef = resolveBoundAccountRefForCat(projectRoot, input.catId, catConfig);
  let account: RuntimeProviderProfile | null = null;
  try {
    account = client ? resolveCatRuntimeAccount(projectRoot, input.catId, client, catConfig) : null;
    if (effectiveAccountRef && client && !account) throw new Error(`bound account "${effectiveAccountRef}" not found`);
    const error =
      provider && account
        ? validateRuntimeProviderBinding(provider, account, input.model ?? catConfig?.defaultModel)
        : null;
    if (error) throw new Error(error);
  } catch (error) {
    if (
      error instanceof AccountStoreVerdictError ||
      effectiveAccountRef ||
      (error instanceof Error && /bound provider profile|model ".+" is not available/.test(error.message))
    )
      throw error;
  }
  if (selection && (!account || account.syntheticNative || account.authType !== selection.authType))
    throw new Error('selected account authentication is unavailable or changed');
  if (account?.authType === 'api_key' && !account.apiKey)
    throw new Error(
      `account "${account.id}" is configured as api_key but has no API key set — add the key in Hub > account settings`,
    );
  const resolvedAccount = account ? deepFreeze(structuredClone(account)) : null;
  const codexAccountLaunch =
    provider === 'openai' && resolvedAccount
      ? resolveCodexAccountLaunch(resolvedAccount, { cwd: input.workspace.workingProjectRoot })
      : undefined;
  const executionAccount =
    resolvedAccount && codexAccountLaunch
      ? codexExecutionAccountSnapshot(resolvedAccount, codexAccountLaunch)
      : provider === 'anthropic' && resolvedAccount?.claude
        ? claudeExecutionAccountSnapshot(resolvedAccount)
        : resolvedAccount
          ? Object.freeze({
              accountRef: resolvedAccount.id,
              displayName: resolvedAccount.displayName ?? resolvedAccount.id,
              authType: resolvedAccount.authType,
              accountRevision: createHash('sha256')
                .update(JSON.stringify({ provider, account: resolvedAccount }))
                .digest('hex'),
            })
          : undefined;
  if (selection?.expectedRevision !== undefined && selection.expectedRevision !== executionAccount?.accountRevision)
    throw new Error('selected execution account revision changed');
  return Object.freeze({
    catConfig,
    workspace: input.workspace,
    projectRoot,
    effectiveAccountRef,
    resolvedAccount,
    ...(codexAccountLaunch ? { codexAccountLaunch } : {}),
    ...(executionAccount ? { executionAccount } : {}),
  });
}
