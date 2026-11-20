import type { ClaudeSdkQueryFn } from './ClaudeSdkAgentService.js';

export interface ClaudeSdkSendContext {
  readonly catId: string;
  readonly model: string;
  readonly invocationId?: string;
  readonly sessionId?: string;
  readonly retentionSourceInvocationId?: string;
}

type SendGuard = (context: ClaudeSdkSendContext) => void;
let privateHostSendGuard: SendGuard | undefined;

/** A private Host may add a synchronous boundary check; ordinary Hosts install none. */
export function installClaudeSdkSendGuard(guard: SendGuard): () => void {
  if (privateHostSendGuard) throw new Error('claude_sdk_send_guard_already_installed');
  privateHostSendGuard = guard;
  return () => {
    if (privateHostSendGuard === guard) privateHostSendGuard = undefined;
  };
}

export function assertClaudeSdkSendCurrent(context: ClaudeSdkSendContext): void {
  const decision: unknown = privateHostSendGuard?.(context);
  if (decision !== undefined) {
    if (decision instanceof Promise) void decision.catch(() => {});
    throw new Error('claude_sdk_send_guard_must_be_synchronous');
  }
}

/** Keep the SDK/native binding outside API startup when this carrier is unused.
 * ESM owns module caching; no parallel service or query lifecycle is introduced.
 */
export async function loadClaudeSdkQuery(
  signal: AbortSignal,
  load: () => Promise<{ query: ClaudeSdkQueryFn }> = () => import('@anthropic-ai/claude-agent-sdk'),
): Promise<ClaudeSdkQueryFn | undefined> {
  if (signal.aborted) return undefined;
  const sdk = await load();
  return signal.aborted ? undefined : sdk.query;
}
