/**
 * F296 B3a gate 4 (second half): derive a producer's revision from its content.
 *
 * The ledger dedupes on `subjectKey + asOf + epoch + presentation`. If a producer
 * rewrites what it says while holding `asOf` fixed, *any* ledger — in-memory,
 * Redis, perfect — classifies the new content as already delivered, and the cat
 * never sees it. Making the ledger shared and persistent (gate 4) makes that bug
 * more durable, not less, so the two halves ship together.
 *
 * "Producers must remember to bump their revision" is a rule people forget. This
 * makes forgetting unrepresentable instead: the revision *is* a digest of the
 * content, so content that changed cannot carry a revision that did not.
 *
 * The digest is also what keeps the ledger key content-free — a coordinate the
 * key can safely carry, rather than a copy of the payload.
 *
 * ## Why unsupported input throws (kimi review, PR #3783)
 *
 * The first cut canonicalised objects with `Object.entries` alone. A `Date` has
 * no own enumerable properties, so every Date collapsed to `{}` and any two of
 * them shared a revision — as did any two Maps, Sets or class instances. That is
 * this module's whole reason for existing, failing silently, in its catastrophic
 * direction: new content read as already delivered, so the cat never sees it.
 * And a Date is exactly what a producer most naturally puts in a payload.
 *
 * So: honour `toJSON` (which covers Date), and for any other exotic container
 * **throw**. A loud rejection at the producer is recoverable; a silent collision
 * is not, and the producer would never learn about it.
 */

import { createHash } from 'node:crypto';
import type { SourceRevision } from './context-presentation.js';

/** Bounds `toJSON` chains and catches cycles, which would otherwise hang. */
const MAX_DEPTH = 64;

function unsupported(value: unknown): never {
  const label =
    typeof value === 'function' ? 'function' : (Object.getPrototypeOf(value)?.constructor?.name ?? 'null-prototype');
  throw new Error(
    `content_revision_unsupported: cannot canonicalise ${label}; give the producer a plain projection or a toJSON`,
  );
}

/**
 * Canonical serialisation: object keys sorted, everything else
 * structure-preserving.
 *
 * Key order is a serializer detail, not content — without this, swapping a
 * producer's object-literal order would re-present every subject in the thread.
 * Array order IS content and is preserved.
 */
function canonicalize(value: unknown, depth = 0): string {
  if (depth > MAX_DEPTH) {
    throw new Error('content_revision_too_deep: payload is cyclic or nested beyond the canonicalisation bound');
  }
  if (value === null) return 'null';

  switch (typeof value) {
    case 'undefined':
      return 'undefined';
    case 'boolean':
    case 'string':
      return JSON.stringify(value) as string;
    case 'number':
      // JSON.stringify maps every non-finite number to `null`, which collided
      // NaN, ±Infinity and an actual null onto one revision.
      return Number.isFinite(value) ? (JSON.stringify(value) as string) : `number:${String(value)}`;
    case 'bigint':
      return `bigint:${value.toString()}`;
    case 'function':
    case 'symbol':
      return unsupported(value);
    default:
      break;
  }

  if (Array.isArray(value)) return `[${value.map((entry) => canonicalize(entry, depth + 1)).join(',')}]`;

  // `toJSON` is the ecosystem's own answer to "how do I serialise this", and it
  // is what makes Date work. Honouring it beats special-casing built-ins.
  const toJSON = (value as { toJSON?: unknown }).toJSON;
  if (typeof toJSON === 'function') {
    return canonicalize((value as { toJSON: () => unknown }).toJSON(), depth + 1);
  }

  // Anything that is not a plain object has state we cannot see. Collapsing it
  // to `{}` is the silent-collision bug; refusing is the honest failure.
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return unsupported(value);

  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entryValue]) => entryValue !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return `{${entries.map(([key, entryValue]) => `${JSON.stringify(key)}:${canonicalize(entryValue, depth + 1)}`).join(',')}}`;
}

/** Truncated SHA-256: collision-resistant far beyond one thread's subject set. */
const DIGEST_LENGTH = 32;

/**
 * Build a `version` revision that changes exactly when the content changes.
 *
 * Producers that already have a real authoritative version (a PR head SHA, a
 * store row version) should keep using it — this is for producers whose "state"
 * is assembled rather than versioned.
 *
 * @throws when the payload contains something that cannot be canonicalised
 *   without risking a silent collision (see the module header).
 */
export function contentRevision(content: unknown): SourceRevision {
  const digest = createHash('sha256').update(canonicalize(content), 'utf8').digest('hex');
  return { kind: 'version', value: digest.slice(0, DIGEST_LENGTH) };
}
