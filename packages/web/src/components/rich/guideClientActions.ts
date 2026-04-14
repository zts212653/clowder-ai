/**
 * B-5: Guide-specific callback helpers extracted from InteractiveBlock.
 *
 * InteractiveBlock delegates all guide awareness here so it stays
 * guide-agnostic. The module handles:
 * - Callback endpoint allowlisting for guide actions
 * - Guide offer re-interaction logic (preview keeps block active)
 * - Local guide-start dispatch via Zustand reducer
 */

import type { InteractiveOption, RichInteractiveBlock } from '@/stores/chat-types';
import { useChatStore } from '@/stores/chatStore';

// ── Callback endpoint constants + allowlist ─────────────────

export const GUIDE_START_CALLBACK_PATH = '/api/guide-actions/start';
export const GUIDE_CANCEL_CALLBACK_PATH = '/api/guide-actions/cancel';
export const GUIDE_PREVIEW_CALLBACK_PATH = '/api/guide-actions/preview';

const GUIDE_ACTIONS_CALLBACK_ALLOWLIST = new Set([
  GUIDE_START_CALLBACK_PATH,
  GUIDE_CANCEL_CALLBACK_PATH,
  GUIDE_PREVIEW_CALLBACK_PATH,
]);

/**
 * Validate and normalize a callback endpoint against the guide allowlist.
 * Returns the safe pathname+search string, or null if blocked.
 */
export function resolveSafeInteractiveCallbackEndpoint(endpoint: string): string | null {
  try {
    const url = new URL(endpoint, window.location.origin);
    if (url.origin !== window.location.origin) return null;
    if (!GUIDE_ACTIONS_CALLBACK_ALLOWLIST.has(url.pathname)) return null;
    return `${url.pathname}${url.search}`;
  } catch {
    return null;
  }
}

/**
 * After selecting "preview", keep the interactive block enabled so the user
 * can still click "start" or "cancel" without sending another message.
 */
export function shouldKeepGuideOfferInteractive(
  block: RichInteractiveBlock,
  selectedOption: InteractiveOption | undefined,
): boolean {
  if (!selectedOption || selectedOption.id !== 'preview') return false;
  if (block.messageTemplate !== '引导流程：{selection}') return false;

  const callbackEndpoints = new Set(
    block.options
      .map((option) =>
        option.action?.type === 'callback' ? resolveSafeInteractiveCallbackEndpoint(option.action.endpoint) : null,
      )
      .filter((endpoint): endpoint is string => Boolean(endpoint)),
  );

  return callbackEndpoints.has(GUIDE_START_CALLBACK_PATH) || callbackEndpoints.has(GUIDE_CANCEL_CALLBACK_PATH);
}

/**
 * Guard: only dispatch local guide start if payload has the right shape
 * and the threadId matches the currently active thread.
 */
export function shouldDispatchLocalGuideStart(
  payload: Record<string, unknown>,
): payload is { guideId: string; threadId: string } {
  const { currentThreadId } = useChatStore.getState();
  return (
    typeof payload.guideId === 'string' && typeof payload.threadId === 'string' && payload.threadId === currentThreadId
  );
}

/**
 * After a successful guide-start callback, trigger the Zustand reducer
 * so the overlay opens without waiting for the server socket event.
 */
export async function dispatchGuideStartIfNeeded(
  safeEndpoint: string,
  payload: Record<string, unknown> | undefined,
): Promise<void> {
  if (safeEndpoint !== GUIDE_START_CALLBACK_PATH) return;
  if (!payload || !('guideId' in payload)) return;
  if (!shouldDispatchLocalGuideStart(payload)) return;

  const { useGuideStore } = await import('@/stores/guideStore');
  useGuideStore.getState().reduceServerEvent({
    action: 'start',
    guideId: payload.guideId,
    threadId: payload.threadId,
  });
}
