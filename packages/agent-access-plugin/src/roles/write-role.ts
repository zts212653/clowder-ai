import { createHash } from 'node:crypto';
import type { CatCafeConfig } from '@cat-cafe/shared';
import type {
  AgentAccessRoleMutation,
  AgentAccessRoleMutationResult,
  AgentAccessRoleStore,
} from '@clowder-ai/agent-contract';
import { assertUniqueMentionAliases, planRoleCreation, planRoleDeletion, planRoleUpdate } from './role-mutations.js';
import { toAllCatConfigs } from './role-projection.js';

export function roleConfigurationRevision(config: CatCafeConfig, catId: string) {
  const cat = toAllCatConfigs(config)[catId];
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
  request: AgentAccessRoleMutation,
): Promise<AgentAccessRoleMutationResult> {
  const { source, revision } = await store.readCatalog();
  const catalog = JSON.parse(source) as CatCafeConfig;
  if (request.kind !== 'create' && roleConfigurationRevision(catalog, request.catId) !== request.expectedRevision)
    return { status: 'conflict' };
  const next =
    request.kind === 'create'
      ? planRoleCreation(catalog, request.input)
      : request.kind === 'update'
        ? planRoleUpdate(catalog, request.catId, request.patch).catalog
        : planRoleDeletion(catalog, request.catId, await store.readTemplateTombstone(request.catId));
  assertUniqueMentionAliases(next);
  const result = await store.commitCatalog(revision, JSON.stringify(next, null, 2) + '\n');
  if (result === 'conflict') return { status: 'conflict' };
  return { status: 'committed', catId: request.kind === 'create' ? request.input.catId : request.catId };
}
