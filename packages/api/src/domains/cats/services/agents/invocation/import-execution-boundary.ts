import type { CatId, SessionRecord } from '@cat-cafe/shared';
import type { AgentService } from '../../types.js';
import { InvocationServiceScope } from './invocation-service-scope.js';
import { type InvocationDeps, prepareInvocationExecutionBinding } from './invoke-single-cat.js';

/** Use the same selected client/account/workspace as the first resumed turn, without sending input. */
export async function captureImportedSessionBoundary(
  deps: InvocationDeps,
  input: { catId: CatId; threadId: string; userId: string; service: AgentService },
): Promise<NonNullable<SessionRecord['hostExecutionBoundary']>> {
  const services = new InvocationServiceScope();
  try {
    const service = services.pin(input.service);
    const binding = await prepareInvocationExecutionBinding(deps, { ...input, service, ownerAuthProvenance: 'strict' });
    if (!binding.hostExecutionBoundary) throw new Error('import_execution_boundary_unavailable');
    return binding.hostExecutionBoundary;
  } finally {
    await services.dispose();
  }
}
