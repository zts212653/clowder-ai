/**
 * F296 B3a gate 1: collision-free encoding for presentation ledger keys.
 *
 * B2b joined the five coordinates with U+001F. That byte can legitimately appear
 * *inside* a coordinate — `subjectKey` is externally shaped (`pr:owner/repo#42`,
 * `subject:<ns>:<opaque>` with a producer-controlled opaque half) and a version
 * string is whatever the producer says it is. So two different projections could
 * encode to one key, and the ledger would suppress a projection the cat never
 * saw. A delimiter can only be safe if the payload is guaranteed not to contain
 * it, and here it is not.
 *
 * The fix is to stop needing a delimiter: each field is length-prefixed
 * (`<len>:<field>`), which is injective by construction — the decoder reads the
 * length, then takes exactly that many code units, so no payload can forge a
 * boundary. `decodeLedgerFields` exists so that injectivity is *provable* in a
 * test rather than argued in a comment.
 *
 * Lengths are UTF-16 code units (what `String.prototype.slice` counts), so
 * encode/decode are exact for any string, including lone surrogates.
 */

import type { PresentationKind, SourceRevision } from './context-presentation.js';

export interface PresentationLedgerKey {
  readonly scopeKey: string;
  readonly contextEpoch: number;
  readonly subjectKey: string;
  readonly asOf: SourceRevision;
  readonly presentation: PresentationKind;
}

const LENGTH_DELIMITER = ':';
const LENGTH_PATTERN = /^(?:0|[1-9][0-9]*)$/;

/** `<len>:<field>` per field, concatenated. Injective for arbitrary strings. */
export function encodeLedgerFields(fields: readonly string[]): string {
  return fields.map((field) => `${field.length}${LENGTH_DELIMITER}${field}`).join('');
}

/** Inverse of {@link encodeLedgerFields}. Throws rather than half-decoding. */
export function decodeLedgerFields(encoded: string): string[] {
  const fields: string[] = [];
  let cursor = 0;

  while (cursor < encoded.length) {
    const delimiter = encoded.indexOf(LENGTH_DELIMITER, cursor);
    if (delimiter < 0) {
      throw new Error(`ledger_key_malformed: missing length delimiter at offset ${cursor}`);
    }
    const rawLength = encoded.slice(cursor, delimiter);
    if (!LENGTH_PATTERN.test(rawLength)) {
      throw new Error(`ledger_key_malformed: bad length prefix ${JSON.stringify(rawLength)}`);
    }
    const start = delimiter + 1;
    const end = start + Number(rawLength);
    // A truncated key must fail loudly: silently returning the short tail would
    // produce a *valid-looking* key for a different projection.
    if (end > encoded.length) {
      throw new Error(`ledger_key_truncated: declared ${rawLength} at offset ${start}`);
    }
    fields.push(encoded.slice(start, end));
    cursor = end;
  }

  return fields;
}

const VERSION_PREFIX = 'v:';
const AS_OF_PREFIX = 't:';

/**
 * A revision is one field. The two-character kind prefix keeps `version:"1700"`
 * and `as_of:1700` distinct — they are different claims about freshness.
 */
function revisionToken(asOf: SourceRevision): string {
  return asOf.kind === 'version' ? `${VERSION_PREFIX}${asOf.value}` : `${AS_OF_PREFIX}${asOf.value}`;
}

function parseRevisionToken(token: string): SourceRevision {
  if (token.startsWith(VERSION_PREFIX)) return { kind: 'version', value: token.slice(VERSION_PREFIX.length) };
  if (token.startsWith(AS_OF_PREFIX)) {
    const value = Number(token.slice(AS_OF_PREFIX.length));
    if (!Number.isFinite(value)) throw new Error(`ledger_key_malformed: bad as_of ${JSON.stringify(token)}`);
    return { kind: 'as_of', value };
  }
  throw new Error(`ledger_key_malformed: unknown revision kind ${JSON.stringify(token)}`);
}

const PRESENTATION_KINDS: ReadonlySet<string> = new Set<PresentationKind>(['directive', 'state', 'pointer', 'omit']);

/**
 * The scope half of the key: `scopeKey` + `contextEpoch`.
 *
 * Split out from the entry half so a store can put every entry of one
 * generation in one container — which is what makes a superseded epoch's
 * entries identifiable later, instead of scattered under opaque flat keys.
 * Concatenating the two halves yields exactly {@link presentationLedgerKey}.
 */
export function presentationLedgerScopeKey(scope: {
  readonly scopeKey: string;
  readonly contextEpoch: number;
}): string {
  return encodeLedgerFields([scope.scopeKey, String(scope.contextEpoch)]);
}

/** The entry half: `subjectKey` + revision + presentation. */
export function presentationLedgerEntryField(entry: {
  readonly subjectKey: string;
  readonly asOf: SourceRevision;
  readonly presentation: PresentationKind;
}): string {
  return encodeLedgerFields([entry.subjectKey, revisionToken(entry.asOf), entry.presentation]);
}

/**
 * Content-free by construction: only coordinates go in, so the key cannot leak
 * candidate text into storage or telemetry.
 */
export function presentationLedgerKey(key: PresentationLedgerKey): string {
  return presentationLedgerScopeKey(key) + presentationLedgerEntryField(key);
}

export function decodePresentationLedgerKey(encoded: string): PresentationLedgerKey {
  const fields = decodeLedgerFields(encoded);
  if (fields.length !== 5) {
    throw new Error(`ledger_key_malformed: expected 5 coordinates, got ${fields.length}`);
  }
  const [scopeKey, rawEpoch, subjectKey, revision, presentation] = fields as [string, string, string, string, string];
  const contextEpoch = Number(rawEpoch);
  if (!Number.isInteger(contextEpoch)) {
    throw new Error(`ledger_key_malformed: bad epoch ${JSON.stringify(rawEpoch)}`);
  }
  if (!PRESENTATION_KINDS.has(presentation)) {
    throw new Error(`ledger_key_malformed: bad presentation ${JSON.stringify(presentation)}`);
  }
  return {
    scopeKey,
    contextEpoch,
    subjectKey,
    asOf: parseRevisionToken(revision),
    presentation: presentation as PresentationKind,
  };
}
