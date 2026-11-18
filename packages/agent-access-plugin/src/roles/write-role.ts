import { createHash } from 'node:crypto';
import type { CatCafeConfig, CatConfig } from '@cat-cafe/shared';
import type {
  AgentAccessDiscoveryHost,
  AgentAccessRoleMutation,
  AgentAccessRoleMutationResult,
  AgentAccessRoleStore,
} from '@clowder-ai/agent-contract';
import { dshLauncherProfileState } from '../discovery/native-dsh-profile.js';
import { MemberCreateConflict, planOwnedRoleCreation } from './member-create-receipt.js';
import { planRoleAccountBinding } from './role-account-binding.js';
import { assertUniqueMentionAliases, planRoleCreation, planRoleDeletion, planRoleUpdate } from './role-mutations.js';
import { toAllCatConfigs } from './role-projection.js';

export function roleConfigurationRevision(
  config: CatCafeConfig,
  catId: string,
  cat: CatConfig | undefined = toAllCatConfigs(config)[catId],
) {
  if (!cat) return undefined;
  const variant = config.breeds.flatMap((breed) =>
    breed.variants.filter((entry) => (entry.catId ?? breed.catId) === catId),
  )[0];
  const roster = config.version === 2 ? config.roster[catId] : undefined;
  return createHash('sha256').update(JSON.stringify({ cat, variant, roster })).digest('hex');
}

/** The Host validates public form payloads before constructing a write command. */
export async function writeRole(
  store: AgentAccessRoleStore,
  discovery: AgentAccessDiscoveryHost,
  request: AgentAccessRoleMutation,
): Promise<AgentAccessRoleMutationResult> {
  const { source, revision } = await store.readCatalog();
  const catalog = JSON.parse(source) as CatCafeConfig;
  if (request.kind === 'bind') {
    const next = planRoleAccountBinding(catalog, request);
    assertUniqueMentionAliases(next);
    const status = await store.commitCatalog(revision, JSON.stringify(next, null, 2) + '\n', { kind: 'bind' });
    return status === 'conflict' ? { status: 'conflict' } : { status: 'bound', catIds: [...request.targetIds] };
  }
  let catId: string;
  let next: CatCafeConfig;
  if (request.kind === 'create') {
    const registered = await store.readRegisteredAliases();
    let creation: ReturnType<typeof planOwnedRoleCreation>;
    try {
      creation = planOwnedRoleCreation(catalog, registered, request.input, request.receipt);
    } catch (error) {
      if (error instanceof MemberCreateConflict) return { status: 'creation_conflict', message: error.message };
      throw error;
    }
    if (creation.replayed) return { status: 'committed', catId: creation.id, replayed: true };
    const { acp, configurationSource, env } = creation.input;
    if (acp && configurationSource === 'native_tool') {
      const { projectRoot } = await discovery.readDetectionContext();
      if (dshLauncherProfileState(acp.command, acp.startupArgs, projectRoot, env?.DSH_HOME) === 'acp_profile_invalid')
        return { status: 'invalid_dsh_profile' };
    }
    catId = creation.id;
    next = planRoleCreation(catalog, creation.input);
  } else {
    catId = request.catId;
    if (roleConfigurationRevision(catalog, catId) !== request.expectedRevision) return { status: 'conflict' };
    next =
      request.kind === 'update'
        ? planRoleUpdate(catalog, catId, request.patch).catalog
        : planRoleDeletion(catalog, catId, await store.readTemplateTombstone(catId));
  }
  assertUniqueMentionAliases(next);
  const result = await store.commitCatalog(revision, JSON.stringify(next, null, 2) + '\n', {
    kind: request.kind,
    catId,
    requireAccountCheck:
      request.kind === 'update' && (request.patch.available === true || request.patch.accountBindingMode !== undefined),
  });
  return result === 'conflict' ? { status: 'conflict' } : { status: 'committed', catId };
}
