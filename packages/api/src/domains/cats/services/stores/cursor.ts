/**
 * #1200 Cursor utilities — v2 token format (§8.3) + canonical coordinate (§8.7).
 *
 * Wire format: `v2:<seq16>:<messageId>`
 *   seq16 = 16-digit zero-padded decimal (MAX_SAFE_INTEGER = 9007199254740991 is 16 digits)
 *   Lex order ≡ (seq, id) pair order for canonical v2 values
 *   'v' (0x76) > any digit → every v2 token lex-exceeds every v1 raw ID
 *
 * v1 = raw message ID (backward compat — resolve via lazy path §8.4)
 *
 * cursorFor() always produces the canonical v2 coordinate when visibilitySeq
 * is known. The #1269 activation gate does NOT live here — it controls only
 * whether previously untouched durable slots initiate v2 encoding (see
 * cursor-activation.ts gateForDurableSlot). This separation ensures CAS
 * comparison/advancement is always v2-coherent regardless of activation mode.
 *
 * Architecture ref: docs/architecture/1200-cursor-order-analysis.md §8.3, §8.4, §8.7
 */

// --------------------------------------------------------------------------
// Types
// --------------------------------------------------------------------------

export interface ParsedCursorV2 {
  readonly version: 2;
  readonly seq: number;
  readonly id: string;
}

export interface ParsedCursorV1 {
  readonly version: 1;
  readonly id: string;
}

export type ParsedCursor = ParsedCursorV2 | ParsedCursorV1;

declare const canonicalVisibilityCursorBrand: unique symbol;

/**
 * A cursor proven to carry the canonical visibility coordinate.
 *
 * Durable encoding may still be gated back to v1 at the Redis boundary, but
 * in-process aggregation slots must never accept an unproven raw message ID.
 */
export type CanonicalVisibilityCursor = string & {
  readonly [canonicalVisibilityCursorBrand]: true;
};

// --------------------------------------------------------------------------
// Constants
// --------------------------------------------------------------------------

const SEQ16_RE = /^\d{16}$/;
const SEQ16_PAD = 16;

// --------------------------------------------------------------------------
// parseCursor — strict parser (§8.3 tightening #3)
// --------------------------------------------------------------------------

/**
 * Parse a cursor token into a structured (version, seq?, id) tuple.
 *
 * Strict: rejects non-16-digit seq, non-canonical padding, out-of-range values,
 * malformed tokens. Fail-closed, never "best effort" (Sol's tightening #3).
 *
 * @returns null for undefined/empty input (no cursor = scan from start).
 * @throws on malformed v2 tokens (invalid format = caller bug or wire tampering).
 */
export function parseCursor(token: string | undefined | null): ParsedCursor | null {
  if (!token) return null;

  if (token.startsWith('v2:')) {
    // v2:<seq16>:<messageId>
    const firstColon = 2; // 'v2'.length
    const secondColon = token.indexOf(':', firstColon + 1);
    if (secondColon === -1) {
      throw new Error(`Malformed v2 cursor: missing id component: ${token}`);
    }

    const seqStr = token.slice(firstColon + 1, secondColon);
    if (!SEQ16_RE.test(seqStr)) {
      throw new Error(`Malformed v2 cursor: seq must be exactly 16 digits, got "${seqStr}"`);
    }

    const seq = Number(seqStr);
    if (!Number.isSafeInteger(seq) || seq < 0) {
      throw new Error(`Malformed v2 cursor: seq out of safe-integer range: ${seq}`);
    }

    const id = token.slice(secondColon + 1);
    if (!id) {
      throw new Error('Malformed v2 cursor: empty messageId');
    }

    return { version: 2, seq, id };
  }

  // Fail-closed: reject unknown v<N>: prefixes — a future version or wire corruption
  // must not silently degrade to v1 raw ID. (#1200 P3 fix)
  const unknownVersionMatch = token.match(/^v(\d+):/);
  if (unknownVersionMatch) {
    throw new Error(`Unknown cursor version v${unknownVersionMatch[1]}: ${token}`);
  }

  // v1: raw message ID (digit-prefix for sortable IDs, any string accepted)
  return { version: 1, id: token };
}

/**
 * Runtime/type guard for in-process visibility-cursor slots.
 *
 * This is intentionally local to canonical boundaries. Global consumers such
 * as freshness and mention filtering still need conservative v1/v2 handling.
 */
export function assertCanonicalVisibilityCursor(
  cursor: string,
  slot: string,
): asserts cursor is CanonicalVisibilityCursor {
  const parsed = parseCursor(cursor);
  if (parsed?.version !== 2) {
    throw new Error(`CANONICAL_VISIBILITY_CURSOR_REQUIRED: slot=${slot} cursor=${cursor}`);
  }
}

// --------------------------------------------------------------------------
// compareCursors — pair-domain comparison (§8.4)
// --------------------------------------------------------------------------

/**
 * Compare two cursor values using pair-domain semantics.
 *
 * Returns:
 *   - negative if a < b (a is "earlier")
 *   - 0        if a === b
 *   - positive if a > b (a is "later")
 *
 * Domain rules:
 *   - v2 vs v2: compare (seq, id) pairs — seq first, id as tiebreaker
 *   - v1 vs v1: lex compare raw message IDs (timestamp-prefixed → lex ≡ time)
 *   - **Cross-format (v1 vs v2)**: returns 0 (indeterminate).
 *     A synchronous comparator cannot resolve v1 → (seq, id) without store
 *     access. Callers MUST canonicalize both inputs before comparison.
 *     After ingress canonicalization (#1200 P2-3), cross-format should not
 *     occur for new data — it indicates a canonicalization gap.
 *     DeliveryCursorStore handles this via its async cursorCanonicalizer.
 *
 * Throws on malformed v2 tokens (via parseCursor).
 */
export function compareCursors(a: string, b: string): number {
  if (a === b) return 0;

  const pa = parseCursor(a);
  const pb = parseCursor(b);
  if (!pa || !pb) return a < b ? -1 : 1; // null = no cursor, shouldn't happen

  // Same format: direct comparison
  if (pa.version === 2 && pb.version === 2) {
    if (pa.seq !== pb.seq) return pa.seq - pb.seq;
    // Tiebreaker: raw message ID (same seq = same message ideally, but be safe)
    return pa.id < pb.id ? -1 : pa.id > pb.id ? 1 : 0;
  }

  if (pa.version === 1 && pb.version === 1) {
    return pa.id < pb.id ? -1 : pa.id > pb.id ? 1 : 0;
  }

  // Cross-format: indeterminate without store access.
  // Callers must canonicalize inputs via async resolver before comparison.
  // Returning 0 = "don't advance" = safe for monotonic cursor semantics.
  // After ingress canonicalization (#1200 P2-3), this path should be dead code.
  return 0;
}

// --------------------------------------------------------------------------
// cursorFor — canonical visibility coordinate (§8.7)
// --------------------------------------------------------------------------

/**
 * Produce the canonical cursor token for a message.
 *
 * Always emits v2 when the visibility position (visibilitySeq) is known,
 * regardless of the #1269 activation gate. This is the **internal canonical
 * coordinate** used by every CAS comparison, position recovery, and
 * advancement path. Gating this function caused rollback-mode CAS to
 * freeze durable v2 positions (maintainer review 2026-08-04).
 *
 * The activation gate controls only **durable slot initiation** — see
 * `gateForDurableSlot()` in cursor-activation.ts.
 *
 * Graded issuance:
 *   - Messages with visibilitySeq → v2 token (canonical position)
 *   - Messages without visibilitySeq → v1 raw ID (degraded)
 */
export function cursorFor(msg: { id: string; visibilitySeq?: number }): string {
  if (msg.visibilitySeq != null) {
    return `v2:${String(msg.visibilitySeq).padStart(SEQ16_PAD, '0')}:${msg.id}`;
  }
  // No visibility position → raw ID (resolve on consumption via §8.4)
  return msg.id;
}
