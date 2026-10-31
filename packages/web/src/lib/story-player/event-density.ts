/**
 * F252 Phase E PR E-2 — Event Density Computation (AC-E7 partial)
 *
 * Pure function to compute event density across timeline buckets.
 * Used by EventDensityBar to render the heatmap overlay on the progress bar.
 *
 * No side effects, no state — just events + bucketCount → DensityBucket[].
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DensityBucket {
  /** Normalized density [0, 1] relative to the densest bucket */
  density: number;
}

// ---------------------------------------------------------------------------
// Computation
// ---------------------------------------------------------------------------

/**
 * Compute event density across N index-aligned buckets.
 *
 * Each bucket covers an equal slice of the event INDEX range (not time range),
 * aligning with the index-based progress bar and seek coordinates.
 * Density is computed as event rate (events/ms) within each bucket,
 * normalized to [0, 1] relative to the highest-rate bucket.
 *
 * This gives meaningful variation: rapid-fire activity = high density,
 * long idle gaps = low density — while staying coordinate-aligned with
 * the slider, chapters, and click-seek (all index-based).
 *
 * Edge cases:
 * - 0 or 1 events → empty (no timeline span)
 * - bucketCount <= 0 → empty
 * - Unsorted input → handled (sorted internally)
 * - Same-timestamp cluster → density 1.0 (instantaneous = max rate)
 */
export function computeEventDensity(events: Array<{ timestamp: number }>, bucketCount: number): DensityBucket[] {
  if (events.length < 2 || bucketCount <= 0) return [];

  // Sort by timestamp (don't mutate input)
  const sorted = [...events].sort((a, b) => a.timestamp - b.timestamp);
  const totalSpan = sorted[sorted.length - 1].timestamp - sorted[0].timestamp;

  // All events at same timestamp → every bucket at density 1.0
  if (totalSpan === 0) {
    return Array.from({ length: bucketCount }, () => ({ density: 1.0 }));
  }

  // Assign events to index-proportional buckets.
  // Event i → bucket floor(i * bucketCount / events.length), clamped.
  const bucketTimestamps: number[][] = Array.from({ length: bucketCount }, () => []);

  for (let i = 0; i < sorted.length; i++) {
    const b = Math.min(Math.floor((i * bucketCount) / sorted.length), bucketCount - 1);
    bucketTimestamps[b].push(sorted[i].timestamp);
  }

  // Compute rate (events/ms) per bucket. High rate = rapid activity, low = idle gap.
  const rates = bucketTimestamps.map((timestamps) => {
    if (timestamps.length <= 1) return timestamps.length; // 0 or 1: use count as proxy
    const span = timestamps[timestamps.length - 1] - timestamps[0];
    return span > 0 ? timestamps.length / span : timestamps.length; // same-ts cluster: count proxy
  });

  // Normalize to [0, 1] relative to max
  const maxRate = Math.max(...rates);
  if (maxRate === 0) {
    return rates.map(() => ({ density: 0 }));
  }

  return rates.map((r) => ({ density: r / maxRate }));
}
