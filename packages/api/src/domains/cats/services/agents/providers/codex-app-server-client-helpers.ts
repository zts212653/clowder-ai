import type { AgentCarrierSession } from '../../types.js';
import type { CodexAppServerJsonObject } from './CodexAppServerEventMapper.js';
import { CodexAppServerLifecycle, type CodexAppServerLifecycleSnapshot } from './CodexAppServerLifecycle.js';

interface ThreadParamsInput {
  model?: string;
  cwd?: string;
  sandbox?: 'read-only' | 'workspace-write' | 'danger-full-access';
  approvalPolicy?: 'untrusted' | 'on-failure' | 'on-request' | 'never';
  developerInstructions?: string;
  config?: CodexAppServerJsonObject;
}

export function buildCodexAppServerThreadParams(
  input: ThreadParamsInput,
  extra?: CodexAppServerJsonObject,
): CodexAppServerJsonObject {
  return {
    ...(extra ?? {}),
    ...(input.model ? { model: input.model } : {}),
    ...(input.cwd ? { cwd: input.cwd } : {}),
    ...(input.sandbox ? { sandbox: input.sandbox } : {}),
    ...(input.approvalPolicy ? { approvalPolicy: input.approvalPolicy } : {}),
    ...(input.developerInstructions ? { developerInstructions: input.developerInstructions } : {}),
    ...(input.config ? { config: input.config } : {}),
  };
}

export async function closeCodexAppServerTransport(
  wire: AgentCarrierSession,
  lifecycle: CodexAppServerLifecycle,
  pumpPromise: Promise<void> | null,
  signal: AbortSignal | undefined,
  abortHandler: () => void,
  rejectPending: (error: Error) => void,
  disposition: 'release' | 'evict' = 'release',
): Promise<{ closing: CodexAppServerLifecycleSnapshot; closed: CodexAppServerLifecycleSnapshot }> {
  signal?.removeEventListener('abort', abortHandler);
  lifecycle.clearTimers();
  const closing = lifecycle.transition('closing');
  let cleanupError: Error | null = null;
  try {
    if (disposition === 'evict' && wire.terminate) await wire.terminate();
    else await wire.close();
  } catch (error) {
    cleanupError = error instanceof Error ? error : new Error(String(error));
    lifecycle.recordCleanupFailure();
    if (disposition === 'evict') await wire.close().catch(() => {});
    else await wire.terminate?.().catch(() => {});
  }
  await pumpPromise?.catch(() => {});
  rejectPending(new Error('Codex app-server closed'));
  const closed = lifecycle.transition('closed', cleanupError ? { cleanupError: cleanupError.message } : undefined);
  return { closing, closed };
}
