/**
 * Redis key patterns for SessionChainStore.
 * F24: Session Chain + Context Health.
 *
 * Note: cat-cafe: prefix is auto-added by ioredis keyPrefix.
 * All keys here are bare (without prefix).
 */

export const SessionChainKeys = {
  /** Hash: session record fields */
  detail: (id: string) => `session:${id}`,
  /** Sorted Set: cat+thread session chain (score = seq) */
  chain: (catId: string, threadId: string) => `session-chain:${catId}:${threadId}`,
  /** Set: thread → cat+thread chain keys (fast cross-cat lookup) */
  byThread: (threadId: string) => `session-chain-by-thread:${threadId}`,
  /** String: cat+thread → active session ID (fast lookup) */
  active: (catId: string, threadId: string) => `session-active:${catId}:${threadId}`,
  /** String: user+cat+thread → active session ID (#1329 managed ownership). */
  activeOwner: (userId: string, catId: string, threadId: string) =>
    `session-active:${catId}:${threadId}:owner:${encodeURIComponent(userId)}`,
  /** String: CLI session ID → record ID index */
  byCli: (cliSessionId: string) => `session-cli:${cliSessionId}`,
  /**
   * F198 Bug #3: chainKey → record ID index. Stable conversation anchor for
   * bg carrier (`bg:${threadId}:${catId}`) that survives daemon sessionId
   * rotation. Lets session_init reuse the same record instead of seal+create.
   */
  byChainKey: (chainKey: string) => `session-by-chainkey:${chainKey}`,
};
