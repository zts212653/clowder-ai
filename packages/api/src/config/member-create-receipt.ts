import { type CatVariant, catRegistry } from '@cat-cafe/shared';
import { planOwnedRoleCreation } from '@clowder-ai/agent-access/roles/member-create-receipt';
import { createRuntimeCat, type RuntimeCatInput, readRuntimeCatCatalog } from './runtime-cat-catalog.js';

export { MemberCreateConflict, memberCreationReceipt } from '@clowder-ai/agent-access/roles/member-create-receipt';

type Receipt = NonNullable<CatVariant['creationReceipt']>;

/** Must run inside the catalog mutation/file lock. Member + receipt share one atomic rename. */
export function createOwnedRuntimeCat(
  projectRoot: string,
  input: RuntimeCatInput,
  receipt?: Receipt,
  validateNew?: () => void,
): { id: string; replayed: boolean } {
  const catalog = readRuntimeCatCatalog(projectRoot);
  const result = planOwnedRoleCreation(
    catalog,
    Object.values(catRegistry.getAllConfigs()),
    input,
    receipt,
    validateNew,
  );
  if (!result.replayed) createRuntimeCat(projectRoot, result.input);
  return { id: result.id, replayed: result.replayed };
}
