/**
 * F257 #4 (sol R4 P2) — web read-model reachability for the signature-lint verdict.
 *
 * The server now persists/broadcasts `extra.signatureLint`, but the web ingestion
 * chain rebuilds `extra` via several divergent allowlists. This proves the two
 * testable pure seams preserve the field:
 *   - `pickSignatureLint` — the shared forwarder spread into the live-callback
 *     side-patches (useAgentMessages W8-W14) and cold-hydration emit (W6).
 *   - `mergeMessageExtra` — the cold-hydration history-merge reconcile (W7, an
 *     UNCITED drop point the §16e sweep surfaced), including the guard invariant
 *     sol flagged: a signatureLint-ONLY extra must NOT collapse to undefined.
 */

import { describe, expect, it } from 'vitest';
import { mergeMessageExtra } from '@/hooks/useChatHistory';
import { pickSignatureLint } from '@/stores/chat-types';

describe('pickSignatureLint — shared live-callback / cold-hydration forwarder', () => {
  it('forwards signed verdict', () => {
    expect(pickSignatureLint({ signatureLint: { signed: true } })).toEqual({ signatureLint: { signed: true } });
  });

  it('forwards unsigned verdict', () => {
    expect(pickSignatureLint({ signatureLint: { signed: false } })).toEqual({ signatureLint: { signed: false } });
  });

  it('returns empty when field absent (no phantom key)', () => {
    expect(pickSignatureLint({})).toEqual({});
    expect(pickSignatureLint({ signatureLint: undefined })).toEqual({});
    expect(pickSignatureLint(undefined)).toEqual({});
    expect(pickSignatureLint(null)).toEqual({});
  });
});

describe('mergeMessageExtra — cold-hydration reconcile preserves signatureLint (W7)', () => {
  it('signatureLint-ONLY extra does NOT collapse to undefined (guard invariant)', () => {
    const merged = mergeMessageExtra({ signatureLint: { signed: false } }, undefined);
    expect(merged).toEqual({ signatureLint: { signed: false } });
  });

  it('preserves signatureLint from the preferred side', () => {
    const merged = mergeMessageExtra({ signatureLint: { signed: true } }, { isExplicitPost: true });
    expect(merged?.signatureLint).toEqual({ signed: true });
    expect(merged?.isExplicitPost).toBe(true);
  });

  it('falls back to signatureLint from the fallback side', () => {
    const merged = mergeMessageExtra(undefined, { signatureLint: { signed: false } });
    expect(merged?.signatureLint).toEqual({ signed: false });
  });

  it('preferred verdict wins over fallback', () => {
    const merged = mergeMessageExtra({ signatureLint: { signed: true } }, { signatureLint: { signed: false } });
    expect(merged?.signatureLint).toEqual({ signed: true });
  });

  it('coexists with other extra fields without clobbering', () => {
    const merged = mergeMessageExtra({ isExplicitPost: true, signatureLint: { signed: false } }, undefined);
    expect(merged).toEqual({ isExplicitPost: true, signatureLint: { signed: false } });
  });
});
