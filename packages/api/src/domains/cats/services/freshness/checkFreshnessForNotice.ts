/**
 * F254 Phase B — checkFreshnessForNotice
 *
 * Wiring helper (like checkFreshnessForPostMessage for Phase A):
 * bridges the callback route to FreshnessNoticeService by assembling
 * all required dependencies.
 *
 * Called from the callback route when the MCP server reports a read-only
 * tool call that passes the local frequency gate.
 */

import type { CatId } from '@cat-cafe/shared';
import type { RedisClient } from '@cat-cafe/shared/utils';
import type { DeliveryCursorStore } from '../stores/ports/DeliveryCursorStore.js';
import type { FreshnessMessageReader, QueuedMessageChecker } from './checkFreshnessForPostMessage.js';
import { FreshnessAttentionEventLog } from './FreshnessAttentionEventLog.js';
import { FreshnessInvocationStateStore } from './FreshnessInvocationStateStore.js';
import type { FreshnessNotice } from './FreshnessNoticeService.js';
import { FreshnessNoticeService } from './FreshnessNoticeService.js';
import { descriptorFromDriver, descriptorFromProviderFallback } from './RuntimeCapabilityDescriptor.js';
import { ThreadUnseenChecker } from './ThreadUnseenChecker.js';

export interface CheckFreshnessForNoticeInput {
  userId: string;
  catId: CatId;
  threadId: string;
  invocationId: string;
  toolName: string;
  isReadOnly: boolean;
  cursorStore: DeliveryCursorStore;
  messageStore: FreshnessMessageReader;
  redis: RedisClient;
  /** Optional visibility filter — must match Phase A's messageFilter (P0) */
  messageFilter?: (msg: Record<string, unknown>) => boolean;
  /**
   * Optional queue checker — detects messages queued by F117 but not yet
   * delivered. Passed through to ThreadUnseenChecker.
   * (Bug fix: operator live test 2026-06-29)
   */
  queueChecker?: QueuedMessageChecker;
  /**
   * F254 AC-C2: Provider name for descriptor derivation. When provided
   * together with a stored carrierTier, the function constructs a
   * RuntimeCapabilityDescriptor and passes it to the notice service.
   * Without provider, descriptor derivation is skipped (backward compat).
   */
  provider?: string;
}

/**
 * One-shot notice check: assembles dependencies and delegates to
 * FreshnessNoticeService.checkAndMaybeNotice().
 *
 * Returns the notice (text + ID) or null.
 */
export async function checkFreshnessForNotice(input: CheckFreshnessForNoticeInput): Promise<FreshnessNotice | null> {
  const { userId, catId, threadId, invocationId, toolName, isReadOnly, cursorStore, messageStore, redis } = input;

  const stateStore = new FreshnessInvocationStateStore(redis);
  const eventLog = new FreshnessAttentionEventLog(redis);
  const unseenChecker = new ThreadUnseenChecker({
    userId,
    cursorStore,
    messageStore,
    messageFilter: input.messageFilter,
    queueChecker: input.queueChecker,
  });

  const service = new FreshnessNoticeService(stateStore, eventLog, unseenChecker);

  // F254 AC-C2/C3: Derive descriptor from stored carrierTier + provider.
  // carrierTier is set by invoke-single-cat at invocation start via
  // FreshnessInvocationStateStore.setCarrierTier(). If not yet stored
  // (pre-wiring or memory-backend), fall back to provider-only derivation
  // for ASYNC_CLOUD_PROVIDERS (gpt52 terminal review P1).
  let descriptor;
  if (input.provider) {
    const state = await stateStore.get(invocationId);
    if (state?.carrierTier) {
      descriptor = descriptorFromDriver(input.provider, state.carrierTier);
    } else {
      descriptor = descriptorFromProviderFallback(input.provider);
    }
  }

  return service.checkAndMaybeNotice({
    invocationId,
    threadId,
    catId,
    toolName,
    isReadOnly,
    descriptor,
  });
}
