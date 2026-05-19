/**
 * F194 Phase Z9 AC-Z24 — projection observability probe.
 *
 * Pure function that takes raw `ChatMessage[]` and produces a diagnostic row
 * per assistant record: identity fields + projection key + content hash +
 * missingTurnStamp flag. Used to differentiate (a) "missing key collapses to
 * parent → multi-turn same-cat merged" vs (b) "projection path leak —
 * same-key records still split" when alpha re-test still shows bubbles split.
 *
 * Companion to `projectCanonicalBubbles`. Same group key derivation:
 *   `projectionKey = ${catId}::${turnInvocationId ?? extra.stream.invocationId}`
 *
 * Why not call into `projectCanonicalBubbles` directly: that one collapses
 * records into bubbles; we need per-record visibility (what each record's
 * effective key is) so we can spot the collapse pattern. Keep them parallel.
 */

import type { ChatMessage } from './chat-types';

export interface ProjectionDiagnosticRow {
  recordId: string;
  catId: string | undefined;
  origin: ChatMessage['origin'];
  parentInvocationId: string | undefined;
  turnInvocationId: string | undefined;
  projectionKey: string;
  contentHash: string;
  /** Z9 telemetry: backend should always stamp turn for assistant records.
   *  When false (turn explicitly stamped), bubble identity is canonical;
   *  when true, group key fell back to parent → potential multi-turn merge. */
  missingTurnStamp: boolean;
  timestamp: number;
}

interface DiagnosticInput {
  records: ChatMessage[];
}

function hashContent(content: string): string {
  // FNV-1a 32-bit hash → 8 hex chars. Deterministic, no crypto dependency.
  let h = 0x811c9dc5;
  for (let i = 0; i < content.length; i += 1) {
    h ^= content.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

export function buildProjectionDiagnostic({ records }: DiagnosticInput): ProjectionDiagnosticRow[] {
  const rows: ProjectionDiagnosticRow[] = [];
  for (const m of records) {
    if (m.type !== 'assistant') continue;
    const parentInvocationId = m.extra?.stream?.invocationId;
    const turnInvocationId = m.extra?.stream?.turnInvocationId;
    const effectiveKey = turnInvocationId ?? parentInvocationId ?? '';
    const projectionKey = `${m.catId ?? ''}::${effectiveKey}`;
    rows.push({
      recordId: m.id,
      catId: m.catId,
      origin: m.origin,
      parentInvocationId,
      turnInvocationId,
      projectionKey,
      contentHash: hashContent(m.content ?? ''),
      missingTurnStamp: !turnInvocationId,
      timestamp: m.timestamp ?? 0,
    });
  }
  return rows;
}
