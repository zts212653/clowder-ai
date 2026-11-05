import { CANONICAL_TOOL_REGISTRY } from './canonical-server-tools.js';
import { projectServerFamily } from './canonical-tool-registry.js';
import type { MemberGatewayCredentialContext, MemberGatewayDeps, MemberToolFamily } from './member-gateway.js';
import { parseSharedInvocationContext, type SharedInvocationContext } from './shared-invocation-context.js';

/** Re-read the original owner before protected work; schema caches never grant authority. */
export function sharedToolAuthorizer(
  deps: MemberGatewayDeps,
  admitted: MemberGatewayCredentialContext,
  sharedContext: SharedInvocationContext,
  families: readonly MemberToolFamily[],
  signal: AbortSignal,
): (name: string) => Promise<void> {
  return async (name) => {
    signal.throwIfAborted();
    const current = await deps.verify({ invocationId: admitted.invocationId, callbackToken: admitted.callbackToken });
    if (!current.ok) throw new Error('Invocation authorization was revoked');
    const fresh = current.context;
    if (
      fresh.invocationId !== admitted.invocationId ||
      fresh.callbackToken !== admitted.callbackToken ||
      fresh.apiBaseUrl !== admitted.apiBaseUrl ||
      fresh.catId !== admitted.catId ||
      fresh.userId !== admitted.userId ||
      fresh.threadId !== admitted.threadId ||
      JSON.stringify(parseSharedInvocationContext(fresh.sharedContext)) !== JSON.stringify(sharedContext)
    )
      throw new Error('Invocation context changed');
    const definition = CANONICAL_TOOL_REGISTRY.find((tool) => tool.name === name);
    if (!definition || !families.includes(definition.serverFamily as MemberToolFamily))
      throw new Error('Tool is unavailable');
    const currentFamilies = await deps.resolveFamilies({ catId: fresh.catId, sharedContext });
    signal.throwIfAborted();
    if (!currentFamilies.includes(definition.serverFamily as MemberToolFamily))
      throw new Error('Tool family was disabled');
    const allowed = fresh.toolsetEnv.allowedToolNames;
    if (allowed && !allowed.includes(name)) throw new Error('Tool authorization was revoked');
    if (
      !projectServerFamily(CANONICAL_TOOL_REGISTRY, definition.serverFamily, fresh.toolsetEnv).some(
        (tool) => tool.name === name,
      )
    )
      throw new Error('Tool profile was restricted');
  };
}
