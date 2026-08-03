import type { CapabilityTipContext } from '@cat-cafe/shared';
import type { AppServerLifecycleSnapshot, CatStatusType } from '@/stores/chat-types';

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
