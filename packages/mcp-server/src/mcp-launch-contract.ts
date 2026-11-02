/** Shared by host configuration and the packaged MCP transport boundary. */
export const CAT_CAFE_SPLIT_ENTRYPOINTS = new Map([
  ['cat-cafe-collab', 'collab.js'],
  ['cat-cafe-memory', 'memory.js'],
  ['cat-cafe-signals', 'signals.js'],
  ['cat-cafe-limb', 'limb.js'],
  ['cat-cafe-audio', 'audio.js'],
  ['cat-cafe-finance', 'finance.js'],
]);

/** Invocation-scoped callback environment, never arbitrary host variables. */
export const MCP_CALLBACK_ENV_KEYS = [
  'CAT_CAFE_API_URL',
  'CAT_CAFE_INVOCATION_ID',
  'CAT_CAFE_CALLBACK_TOKEN',
  'CAT_CAFE_USER_ID',
  'CAT_CAFE_CAT_ID',
  'CAT_CAFE_THREAD_ID',
  'CAT_CAFE_SIGNAL_USER',
  'CAT_CAFE_RUN_TYPE',
  'CAT_CAFE_AUDIT_TOPIC',
  'CAT_CAFE_MCP_TRANSPORT',
] as const;

/** Refreshed by persistent carriers rather than frozen into each invocation.
 * A per-invocation placeholder must not let superseded processes read a newer
 * session's credentials (#1099).
 */
export const MCP_SESSION_ENV_KEYS = ['CAT_CAFE_CREDENTIAL_FILE'] as const;
