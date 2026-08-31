/**
 * F257 #2 — L0 manifest → session trace adapter.
 *
 * Converts the per-segment L1-L7 manifest emitted by the ACTUAL L0 compiler
 * (`getL0ManifestViaSubprocess`) into a session `PipelineResult`, so the existing
 * trace bridge (`buildFromPipeline` → `eventsToSegments`) persists it as per-segment
 * `ObservedSegment`s — no second persistence format.
 *
 * Why this and not the (rejected) `collectNativeL0SessionTrace`: that reran the API
 * hook pipeline (a separate code path) and could report OVERRIDDEN L content the
 * override-blind native compiler never delivered. This adapter's input IS the compiled
 * artifact, so hash/char/token describe exactly what the provider received. Version is
 * the only field not in the artifact; it resolves from the hook registry (same source
 * the segment lifeline uses), defaulting to 1 for the always-on L hooks.
 */

import type { TraceEvent, TraceEventFired } from '@cat-cafe/shared';
import { estimateTokens } from '../../utils/token-counter.js';
import type { L0SegmentContent } from '../cats/services/agents/providers/l0-compiler.js';
import type { PipelineResult } from './HookPipeline.js';
import { getCachedRegistry } from './PipelinePromptBuilder.js';
import { hashContent } from './trace-collector.js';

/** The native L0 identity is exactly these segments, in this order (compiler-emitted). */
const CANONICAL_L_SEGMENTS = ['L1', 'L2', 'L3', 'L4', 'L5', 'L6', 'L7'] as const;

/**
 * F257 #2 (2b R2 P1-1): validate the manifest as ONE atomic L1-L7 artifact.
 * Returns null when valid, else a human-readable reason.
 *
 * The native L0 identity is delivered as a whole, so the trace must trust it atomically:
 * a partial / empty / reordered / foreign / duplicate / blank-content manifest means the
 * producer (compiler / CLI) regressed, and recording it as healthy `fired` data would
 * recreate the original incident (Console shows an apparently-injected iron-law segment
 * that was actually dropped or empty). Any violation → reject the WHOLE manifest into the
 * visible producer-failure path, never a partial success.
 */
export function validateL0Manifest(manifest: readonly L0SegmentContent[]): string | null {
  if (manifest.length !== CANONICAL_L_SEGMENTS.length) {
    return `expected exactly ${CANONICAL_L_SEGMENTS.length} L segments, got ${manifest.length}`;
  }
  for (let i = 0; i < CANONICAL_L_SEGMENTS.length; i++) {
    const seg = manifest[i];
    if (!seg || seg.segmentId !== CANONICAL_L_SEGMENTS[i]) {
      // Catches missing / duplicate / foreign / reordered in one canonical-order check.
      return `segment[${i}] must be ${CANONICAL_L_SEGMENTS[i]}, got "${seg?.segmentId}"`;
    }
    if (typeof seg.content !== 'string' || seg.content.trim().length === 0) {
      return `${seg.segmentId} has blank content`;
    }
  }
  return null;
}

/**
 * Build a session-stage `PipelineResult` from the real L0 compiler manifest, or null when
 * the manifest fails atomic validation (see validateL0Manifest) — callers then emit a
 * visible "L not observed" signal instead of persisting a partial/false healthy trace.
 */
export function l0ManifestToSessionResult(manifest: readonly L0SegmentContent[]): PipelineResult | null {
  if (validateL0Manifest(manifest) !== null) return null;
  const registry = getCachedRegistry();
  const timestamp = Date.now();

  const patches = manifest.map((seg, i) => ({
    hookId: seg.segmentId,
    content: seg.content,
    order: (i + 1) * 100,
  }));

  const events: TraceEvent[] = manifest.map(
    (seg): TraceEventFired => ({
      hookId: seg.segmentId,
      stage: 'session-init',
      timestamp,
      status: 'fired',
      version: registry?.getHook(seg.segmentId)?.manifest.version ?? 1,
      contentHash: hashContent(seg.content),
      tokenEstimate: estimateTokens(seg.content),
      // F257 Console 判据④：native L0 content IS the actual rendered artifact.
      content: seg.content,
      contentSourceKind: 'native-l0',
      templateRef: seg.segmentId,
      templateVars: null,
    }),
  );

  return { patches, events };
}
