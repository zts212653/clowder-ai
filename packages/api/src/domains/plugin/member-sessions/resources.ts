import { type AccountConfig, builtinAccountIdForClient, type CatConfig, type ClientId } from '@cat-cafe/shared';
import { resolveBuiltinClientForProvider } from '../../../config/account-resolver.js';
import { readAccountStoreSnapshot } from '../../../config/account-store-snapshot.js';
import { resolveBoundAccountRefForCat } from '../../../config/cat-account-binding.js';
import { freezeExecutionAccountBinding } from '../../cats/services/agents/invocation/execution-account-binding.js';
import type { AgentService } from '../../cats/services/types.js';
import type { MemberResourceDescription, MemberSessionScope, MemberSessionServices } from './types.js';

type Account = MemberResourceDescription['accounts'][number];
interface ResourceServices {
  readonly projectRoot: string;
  config(catId: string): CatConfig;
  service(catId: string, config: CatConfig): AgentService;
  memory(catId: string, scope: MemberSessionScope): Promise<MemberResourceDescription['memory']>;
  /** The ordinary execution resolver is also used here; credentials never leave this frame. */
  readonly freezeAccount?: typeof freezeExecutionAccountBinding;
  readonly readAccounts?: typeof readAccountStoreSnapshot;
  readonly defaultAccount?: typeof resolveBoundAccountRefForCat;
}
interface Discovery {
  readonly catId: string;
  readonly config: CatConfig;
  readonly service: AgentService;
  readonly supported: boolean;
  readonly defaultAccountRef: string | null | undefined;
}
function unavailable(ref: string, metadata: AccountConfig | undefined, reason: string): Account | undefined {
  // Unknown/rejected metadata must not invent an authentication method.
  return metadata
    ? {
        accountRef: ref,
        displayName: metadata.displayName ?? ref,
        authType: metadata.authType,
        available: false,
        reason,
      }
    : undefined;
}
function accountOption(
  deps: ResourceServices,
  frame: Discovery,
  ref: string,
  metadata: AccountConfig | undefined,
): Account | undefined {
  if (!frame.supported) return unavailable(ref, metadata, 'member_native_carrier_unavailable');
  try {
    const binding = (deps.freezeAccount ?? freezeExecutionAccountBinding)({
      catId: frame.catId,
      catConfig: frame.config,
      model: frame.config.defaultModel,
      workspace: {
        workingDirectory: deps.projectRoot,
        workingProjectRoot: deps.projectRoot,
        usesDefaultWorkspace: false,
      },
      ...(ref === frame.defaultAccountRef
        ? {}
        : { accountSelection: { accountRef: ref, authType: metadata?.authType ?? 'oauth' } }),
    });
    const account = binding.executionAccount;
    if (!account || account.accountRef !== ref) throw new Error('member_account_changed');
    frame.service.assertScopedMemberAccount?.(account);
    return {
      accountRef: account.accountRef,
      displayName: account.displayName,
      authType: account.authType,
      accountRevision: account.accountRevision,
      available: true,
      ...(!binding.resolvedAccount?.syntheticNative
        ? {
            selection: {
              accountRef: account.accountRef,
              authType: account.authType,
              expectedRevision: account.accountRevision,
            },
          }
        : {}),
    };
  } catch {
    // Resolver errors can contain credential coordinates. Plugins receive only this safe code.
    return unavailable(ref, metadata, 'member_account_unavailable');
  }
}
function accountOptions(deps: ResourceServices, frame: Discovery): readonly Account[] {
  const family = resolveBuiltinClientForProvider(frame.config.clientId);
  if (!family) return [];
  const catalog = (deps.readAccounts ?? readAccountStoreSnapshot)(deps.projectRoot);
  const refs = new Set([...(frame.defaultAccountRef ? [frame.defaultAccountRef] : []), ...catalog.refs]);
  return [...refs].flatMap((ref) => {
    const inspected = catalog.inspect(ref);
    if (inspected.state === 'rejected') return [];
    const metadata = inspected.entry.account;
    if (
      (metadata?.clientId && resolveBuiltinClientForProvider(metadata.clientId as ClientId) !== family) ||
      (!metadata && ref !== frame.defaultAccountRef)
    )
      return [];
    const option = accountOption(deps, frame, ref, metadata);
    return option ? [option] : [];
  });
}

/** Owner discovery is descriptive: no thread, grant, login, child or model is created. */
export function createMemberResourceDescription(
  deps: ResourceServices,
): NonNullable<MemberSessionServices['describeResources']> {
  return async (catId, scope) => {
    const config = structuredClone(deps.config(catId));
    const service = deps.service(catId, config);
    const policy = {
      mode: 'plugin_native' as const,
      pluginInstanceId: scope.pluginInstanceId,
      contributionId: 'capability-preflight',
      memberSession: {
        sessionId: 'capability-preflight',
        generation: 1,
        executionId: 'capability-preflight',
      },
    };
    const supported = service.supportsToolExecutionPolicy?.(policy) === true;
    const carrier = service.freshnessCarrierCapability?.().carrier ?? service.contextCapability?.().carrier;
    const family = resolveBuiltinClientForProvider(config.clientId);
    const defaultAccountRef =
      (deps.defaultAccount ?? resolveBoundAccountRefForCat)(deps.projectRoot, catId, config) ??
      (family ? builtinAccountIdForClient(family) : undefined);
    const accounts = accountOptions(deps, { catId, config, service, supported, defaultAccountRef });
    const memory = (await deps.memory(catId, scope)).map(({ sourceRef, revision, bytes }) => ({
      sourceRef,
      revision,
      bytes,
    }));
    await scope.assertCurrent();
    const available = supported && accounts.some((account) => account.available);
    return {
      schema: 'host.member-resources.v1',
      catId,
      ...(carrier ? { runtime: { clientId: config.clientId, model: config.defaultModel, carrier } } : {}),
      ...(defaultAccountRef ? { defaultAccountRef } : {}),
      available,
      ...(!available ? { reason: supported ? 'member_account_unavailable' : 'member_native_carrier_unavailable' } : {}),
      accounts,
      memory,
    };
  };
}
