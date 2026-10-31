import { resolveProviderSemanticMessage as resolveSharedProviderSemanticMessage } from '@cat-cafe/shared';
import { recordDebugEvent } from '@/debug/invocationEventDebug';

export type {
  ProviderSemanticMessageMode,
  ProviderSemanticMessageResolution,
  ProviderSemanticProjection,
  ProviderSemanticProjectorOverrides,
  ProviderSemanticSurface,
} from '@cat-cafe/shared';

export { projectProviderSemanticEvent } from '@cat-cafe/shared';

export function resolveProviderSemanticMessage(candidate: unknown) {
  const resolution = resolveSharedProviderSemanticMessage(candidate);
  if (resolution.action === 'suppress') {
    recordDebugEvent({
      event: 'semantic_suppressed',
      action: 'suppress',
      reason: resolution.reason,
      sourcePath: 'provider-semantic-registry',
      ...(resolution.reason === 'invalid_event' ? { level: 'warn' } : {}),
    });
  }
  return resolution;
}
