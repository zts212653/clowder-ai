/**
 * #1200 Cursor utilities — v2 token format (§8.3) + graded issuance (§8.7).
 *
 * Wire format: `v2:<seq16>:<messageId>`
 *   seq16 = 16-digit zero-padded decimal (MAX_SAFE_INTEGER = 9007199254740991 is 16 digits)
 *   Lex order ≡ (seq, id) pair order for canonical v2 values
 *   'v' (0x76) > any digit → every v2 token lex-exceeds every v1 raw ID
 *
 * v1 = raw message ID (backward compat — resolve via lazy path §8.4)
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

// --------------------------------------------------------------------------
// cursorFor — graded issuance (§8.7)
// --------------------------------------------------------------------------

/**
 * Generate a cursor token for a message.
 *
 * Graded issuance:
 *   - Messages with visibilitySeq → v2 token (canonical position)
 *   - Messages without visibilitySeq → v1 raw ID (degraded)
 *
 * Every comparison point goes through parseCursor + lazy resolve (§8.4),
 * so mixed v1/v2 issuance is safe by construction.
 */
export function cursorFor(msg: { id: string; visibilitySeq?: number }): string {
  if (msg.visibilitySeq != null) {
    return `v2:${String(msg.visibilitySeq).padStart(SEQ16_PAD, '0')}:${msg.id}`;
  }
  // Degraded: no visibility position → raw ID (resolve on consumption)
  return msg.id;
}
