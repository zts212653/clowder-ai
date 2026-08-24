import type { ContextCoordinate } from '../types.js';
import type { ContextPresentation, SourceTier } from './context-presentation.js';

export interface ContextModeProjection {
  readonly coordinate: ContextCoordinate;
  readonly contextEpoch: number;
  readonly contextMode: 'cold' | 'hot';
  readonly transition: string;
  readonly reason: string;
}

export type PresentationCounts = Readonly<Record<SourceTier, number>>;

export interface ContextSurfaceProjection extends ContextModeProjection {
  readonly deltaSize: 'small' | 'large';
  /** Counts only projections that actually reached a surface; `omit` never increments a tier. */
  readonly presentationCounts: PresentationCounts;
}

export const EMPTY_PRESENTATION_COUNTS: PresentationCounts = Object.freeze({
  T0: 0,
  T1: 0,
  T2: 0,
  invalid: 0,
});

export function countPresentedTiers(presentations: readonly ContextPresentation[]): PresentationCounts {
  const counts: Record<SourceTier, number> = { ...EMPTY_PRESENTATION_COUNTS };
  for (const presentation of presentations) {
    if (presentation.presentation !== 'omit') counts[presentation.sourceTier] += 1;
  }
  return counts;
}

export function mergePresentationCounts(...counts: readonly PresentationCounts[]): PresentationCounts {
  return counts.reduce<Record<SourceTier, number>>(
    (merged, current) => ({
      T0: merged.T0 + current.T0,
      T1: merged.T1 + current.T1,
      T2: merged.T2 + current.T2,
      invalid: merged.invalid + current.invalid,
    }),
    { ...EMPTY_PRESENTATION_COUNTS },
  );
}

export function projectContextMode(input: {
  readonly coordinate: ContextCoordinate;
  readonly decision: {
    readonly contextEpoch: number;
    readonly contextMode: 'cold' | 'hot';
    readonly transition: string;
    readonly normalizedDisposition: { readonly reason: string };
  };
}): ContextModeProjection {
  return {
    coordinate: input.coordinate,
    contextEpoch: input.decision.contextEpoch,
    contextMode: input.decision.contextMode,
    transition: input.decision.transition,
    reason: input.decision.normalizedDisposition.reason,
  };
}

export function withSurfaceShape(
  projection: ContextModeProjection,
  deltaSize: 'small' | 'large',
  presentationCounts: PresentationCounts = EMPTY_PRESENTATION_COUNTS,
): ContextSurfaceProjection {
  return { ...projection, deltaSize, presentationCounts };
}
