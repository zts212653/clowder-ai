import type { CallbackPrincipal } from '@cat-cafe/shared';
import type {
  CurrentPageRequest,
  OwnerPageActionDeps,
  OwnerPageActionView,
  OwnerPageCallEntry,
} from '../owner-page-action-contract.js';
import { projectOwnerPageInvocation } from './owner-page-action-invocation-view.js';

export async function readCurrentOwnerPageRequest(
  deps: OwnerPageActionDeps,
  calls: Map<string, OwnerPageCallEntry>,
  requestMessageId: string,
): Promise<CurrentPageRequest | null> {
  const observed = await deps.sessions.observeCall(deps.ownerUserId);
  if (!observed) return null;
  const entry = calls.get(observed.callId);
  if (!entry || entry.call.status().state !== 'talking') return null;
  const read = await entry.call.boundaryContexts.inspectPageActionRequest(requestMessageId);
  if (
    !read ||
    read.scope.userId !== observed.userId ||
    read.scope.threadId !== observed.threadId ||
    read.scope.catId !== observed.catId ||
    read.scope.callId !== observed.callId ||
    read.scope.generation !== observed.generation
  )
    return null;
  return { call: entry.call, ...read };
}

export async function ownerPageInvocationView(
  deps: OwnerPageActionDeps,
  calls: Map<string, OwnerPageCallEntry>,
  enabled: boolean,
  principal: Extract<CallbackPrincipal, { kind: 'invocation' }>,
  readView: () => Promise<OwnerPageActionView>,
) {
  if (!enabled && principal.userId === deps.ownerUserId) return { kind: 'unavailable' } as const;
  const observed = await deps.sessions.observeCall(deps.ownerUserId);
  const entry = observed && calls.get(observed.callId);
  if (
    !entry ||
    principal.userId !== deps.ownerUserId ||
    !entry.call.householdToolsEnabled ||
    !entry.call.contextScope(principal)
  )
    throw new Error('Current Live invocation required');
  const view = await readView();
  if (
    view.kind === 'available' &&
    (view.callId !== entry.call.id || view.generation !== entry.call.contextScope(principal)?.generation)
  )
    throw new Error('Current Live invocation changed');
  return projectOwnerPageInvocation(view);
}

export async function listOwnerPageChoices(deps: OwnerPageActionDeps, current: CurrentPageRequest | null) {
  const signal = current?.call.boundaryContexts.pageActionPreviewSignal();
  if (!deps.currentPages || !current || !signal || signal.aborted)
    throw new Error('Current owner page request required');
  return deps.currentPages.list(current, AbortSignal.any([signal, AbortSignal.timeout(5_000)]));
}
