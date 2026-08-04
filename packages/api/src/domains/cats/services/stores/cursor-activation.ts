/**
 * Cursor v2 Activation Gate (#1269 contract)
 *
 * Single env var controls whether v2 cursors are emitted.
 * One gate point: `isV2CursorActive()`.
 *
 * When OFF (default): `cursorFor()` always returns v1 (raw message ID).
 * When ON: `cursorFor()` returns v2 for messages with visibilitySeq.
 *
 * The gate is deployment-scoped (env var), not per-request.
 * OFF → ON is safe: existing v1 cursors are consumed by lazy resolve.
 * ON → OFF rollback: v2 cursors in Redis remain parseable; new cursors
 * degrade to v1; comparison handles mixed formats via indeterminate (0).
 */

/**
 * Check whether visibility-based v2 cursors are active.
 * Reads `VISIBILITY_CURSOR_V2` env var. Only `'on'` activates.
 */
export function isV2CursorActive(): boolean {
  return process.env.VISIBILITY_CURSOR_V2 === 'on';
}
