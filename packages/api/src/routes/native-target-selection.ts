import type { AgentRegistry } from '../domains/cats/services/agents/registry/AgentRegistry.js';
import type { ISessionChainStore } from '../domains/cats/services/stores/ports/SessionChainStore.js';
import { listNativeSessionTargets } from './native-session-target.js';

interface NativeTargetChoiceInput {
  readonly agentRegistry: AgentRegistry;
  readonly sessionChainStore: ISessionChainStore;
  readonly threadId: string;
  readonly userId: string;
  readonly capability: 'requestNativeGoal' | 'requestNativeReview';
}

export async function listNativeTargetChoices(input: NativeTargetChoiceInput): Promise<Array<{ catId: string }>> {
  const targets = await listNativeSessionTargets(input);
  return targets.map(({ catId }) => ({ catId }));
}

export async function nativeSelectionRequired(
  input: NativeTargetChoiceInput & { readonly requestedCatId?: string },
): Promise<Array<{ catId: string }> | null> {
  if (input.requestedCatId) return null;
  const nativeTargets = await listNativeTargetChoices(input);
  return nativeTargets.length > 1 ? nativeTargets : null;
}
