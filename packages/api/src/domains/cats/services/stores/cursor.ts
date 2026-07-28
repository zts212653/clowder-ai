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
 *   - v1 vs v2: v2 is always considered "later" than v1.
 *     Rationale: v2 issuance requires visibilitySeq, which is only assigned
 *     by the append path post-#1200. v1 cursors are legacy tokens from before
 *     visibility tracking. In the monotonic cursor-advance domain, a v2 cursor
 *     always represents a position in the tracked era, which postdates all
 *     untracked (v1) positions. The Lua CAS (redis.ts) resolves v1→seq via
 *     HGET for stronger ordering; this TypeScript comparison is the in-memory
 *     fallback that uses the version boundary as a safe proxy.
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

  // Cross-format: v2 always > v1 (version-boundary heuristic, see docstring)
  return pa.version === 2 ? 1 : -1;
}

// --------------------------------------------------------------------------
// computeVisibilityContiguousAdvance — safe seenCursor advancement (§8.5)
// --------------------------------------------------------------------------

/**
 * Compute the furthest safe seenCursor advancement from a page of messages.
 *
 * seenCursor is a scalar prefix promise: "I have seen all messages up to seq N."
 * Advancing past a gap (unseen message between two seen ones) would create a
 * false "seen" claim that permanently suppresses freshness for the skipped message.
 *
 * Algorithm:
 *   1. Extract messages with visibilitySeq, sorted ascending
 *   2. Starting from currentSeq (parsed from current cursor), walk forward
 *   3. Only advance through messages where seq === expectedNext (no gaps)
 *   4. Return the cursor for the last contiguous message, or null if no advance
 *
 * Conservative by design: stops at ANY gap, even if the gap is an invisible
 * message (whisper to another cat). This prevents false seen claims at the cost
 * of slower cursor advancement when invisible messages create gaps.
 *
 * @param messages - Page of messages returned to the cat (already visibility-filtered)
 * @param currentCursor - Current seenCursor value (undefined = never advanced)
 * @returns New cursor value to advance to, or null if no safe advance possible
 */
export function computeVisibilityContiguousAdvance(
  messages: ReadonlyArray<{ id: string; visibilitySeq?: number }>,
  currentCursor: string | undefined,
): string | null {
  // Extract messages with visibilitySeq, sorted by seq ascending
  const withSeq = messages
    .filter((m): m is { id: string; visibilitySeq: number } => m.visibilitySeq != null)
    .sort((a, b) => a.visibilitySeq - b.visibilitySeq);

  if (withSeq.length === 0) return null;

  // Parse current cursor's seq (0 if no cursor = start of thread)
  let currentSeq = 0;
  if (currentCursor) {
    const parsed = parseCursor(currentCursor);
    if (parsed?.version === 2) {
      currentSeq = parsed.seq;
    }
    // v1 cursor: we don't know its seq position, so we can't establish
    // contiguity. Return null (no safe advance from a v1 cursor).
    // The cursor will be "upgraded" to v2 when the routing boundary
    // (route-serial/route-parallel) writes a v2 seenCursor.
    else if (parsed?.version === 1) {
      return null;
    }
  }

  // Walk through messages in visibility order, advancing through contiguous seqs
  let advanceTo: { id: string; visibilitySeq: number } | null = null;
  for (const msg of withSeq) {
    if (msg.visibilitySeq <= currentSeq) continue; // already seen
    if (msg.visibilitySeq === currentSeq + 1) {
      // Contiguous: advance
      advanceTo = msg;
      currentSeq = msg.visibilitySeq;
    } else {
      // Gap detected: stop — there's an unseen message between currentSeq and this msg
      break;
    }
  }

  if (!advanceTo) return null;
  return cursorFor(advanceTo);
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
