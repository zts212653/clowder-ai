import type { CapabilityTipContext } from '@cat-cafe/shared';
import type { AppServerLifecycleSnapshot, CatInvocationInfo, CatStatusType, ChatMessage } from '@/stores/chat-types';

export const DEFAULT_STREAMING_TIP_CONTEXTS = [
  'thinking',
  'long_running',
] as const satisfies readonly CapabilityTipContext[];
export const REVIEW_STREAMING_TIP_CONTEXTS = [
  'review',
  'long_running',
] as const satisfies readonly CapabilityTipContext[];

export const APP_SERVER_SILENCE_WARNING_MS = 2 * 60_000;

export function getStreamingTipContexts(intentMode: 'execute' | 'ideate' | null | undefined) {
  return intentMode === 'ideate' ? REVIEW_STREAMING_TIP_CONTEXTS : DEFAULT_STREAMING_TIP_CONTEXTS;
}

export function getSilentActiveTurnDeadline(lifecycle: AppServerLifecycleSnapshot | undefined): number | null {
  if (!lifecycle || (lifecycle.stage !== 'turn_accepted' && lifecycle.stage !== 'active')) return null;
  return lifecycle.lastActivityAt + APP_SERVER_SILENCE_WARNING_MS;
}

export function isSilentActiveTurn(lifecycle: AppServerLifecycleSnapshot | undefined, now = Date.now()): boolean {
  const deadline = getSilentActiveTurnDeadline(lifecycle);
  return deadline !== null && now >= deadline;
}

export function isStreamingTipSuppressed(
  status: CatStatusType | undefined,
  lifecycle?: AppServerLifecycleSnapshot,
  now = Date.now(),
): boolean {
  return status === 'suspected_stall' || status === 'alive_but_silent' || isSilentActiveTurn(lifecycle, now);
}

function isBodylessProcessingResponse(message: ChatMessage): boolean {
  return (
    message.lifecycle?.kind === 'response' &&
    message.lifecycle.status === 'processing' &&
    message.content.trim().length === 0 &&
    !message.contentBlocks?.length &&
    !message.toolEvents?.length
  );
}

/**
 * Select the one exact active response that owns capability tips for a thread.
 *
 * The durable response message is the pending surface: it upgrades in place
 * when output arrives, so tips never require a second synthetic wait bubble.
 * Exact active-run identity prevents a stale hydrated `processing` row from
 * advertising work after its invocation has already disappeared.
 */
export function selectLifecycleTipMessageId(
  messages: readonly ChatMessage[],
  catStatuses: Readonly<Record<string, CatStatusType>>,
  catInvocations: Readonly<Record<string, CatInvocationInfo>>,
): string | null {
  for (const message of messages) {
    if (!isBodylessProcessingResponse(message)) continue;
    const lifecycle = message.lifecycle;
    if (lifecycle?.kind !== 'response') continue;
    const targetId = lifecycle.targetId;
    const activeRun = catInvocations[targetId]?.activeRun;
    if (
      !activeRun ||
      activeRun.responseMessageId !== message.id ||
      activeRun.invocationId !== lifecycle.invocationId ||
      activeRun.targetId !== targetId
    ) {
      continue;
    }
    if (isStreamingTipSuppressed(catStatuses[targetId], catInvocations[targetId]?.appServerLifecycle)) continue;
    return message.id;
  }
  return null;
}
