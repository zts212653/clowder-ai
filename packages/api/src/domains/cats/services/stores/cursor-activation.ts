/**
 * Cursor v2 Activation Gate (#1269 contract, revised per maintainer review)
 *
 * Separates two concerns:
 *   1. **Canonical visibility coordinate** (`cursorFor()` in cursor.ts):
 *      Always v2 when visibilitySeq is known. Used for CAS comparison,
 *      position recovery, and advancement. NOT gated — must be v2-coherent
 *      in both activation modes for rollback safety.
 *
 *   2. **Durable slot initiation** (`gateForDurableSlot()` below):
 *      Controls whether a previously untouched durable slot (delivery,
 *      read, seen, mention-ack positions in Redis) initiates v2 encoding.
 *
 * Deployment modes (same build, same artifact):
 *   OFF (default): canonical coordinates are v2 (CAS works correctly).
 *     Untouched durable slots receive v1 via gateForDurableSlot().
 *     Existing v2 slots remain advanceable in v2 form (rollback-safe).
 *   ON: all durable slots initiate and advance in v2 format.
 *   ON → OFF rollback: existing v2 slots keep advancing in v2.
 *     New durable slots revert to v1. No state frozen or downgraded.
 */

/**
 * Check whether visibility-based v2 cursor initiation is active.
 * Reads `VISIBILITY_CURSOR_V2` env var. Only `'on'` activates.
 */
export function isV2CursorActive(): boolean {
  return process.env.VISIBILITY_CURSOR_V2 === 'on';
}

/**
 * Gate v2 initiation for a specific durable slot.
 *
 * Returns the cursor format appropriate for writing to the slot:
 *   - Existing v2 slot → always v2 (rollback-safe, advance in same format)
 *   - Untouched/v1 slot + gate ON → v2 (initiate v2 encoding)
 *   - Untouched/v1 slot + gate OFF → v1 (extract raw ID from canonical v2)
 *
 * @param canonical - The canonical v2 cursor from cursorFor()
 * @param existingSlotCursor - Current value of the durable slot (null if untouched)
 */
export function gateForDurableSlot(canonical: string, existingSlotCursor: string | null): string {
  // Existing v2 → always advance in v2 (rollback-safe)
  if (existingSlotCursor?.startsWith('v2:')) return canonical;
  // Gate ON → initiate v2
  if (isV2CursorActive()) return canonical;
  // Gate OFF + untouched/v1 → extract raw message ID from v2 canonical
  if (canonical.startsWith('v2:')) {
    // v2 format: v2:<seq16>:<messageId> — extract messageId after second colon
    const secondColon = canonical.indexOf(':', 3);
    if (secondColon > 0) return canonical.slice(secondColon + 1);
  }
  // Already v1 or non-v2 — pass through
  return canonical;
}
