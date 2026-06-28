/**
 * F236 Track-2 — per-event model with correlation keys + open-rate rollup.
 *
 * Track-1 (anchor-telemetry.ts) records aggregate chars + volume tallies — no
 * join keys, so it CANNOT derive a per-tool drill↔preview open-rate. Track-2
 * stores per-event records with correlation keys (itemId = messageId / taskId)
 * in an in-memory ring buffer (24h retention, eviction on write) so the rollup
 * can join drill events back to the preview that surfaced that item.
 *
 * Design: per-RESPONSE preview events (not per-item) keep event count
 * manageable; itemIds array enables item-level open-rate. Drill→preview
 * join uses itemId; when the same item appears in multiple preview tools,
 * the most recent preview wins attribution.
 *
 * Split from anchor-telemetry.ts (cloud R3 P1: 350-line file cap).
 */

import type { AnchorDrillTool, AnchorPreviewTool, AnchorTelemetrySnapshot } from './anchor-telemetry.js';
import { getAnchorTelemetrySnapshot } from './anchor-telemetry.js';

const EVICTION_TTL_MS = 24 * 60 * 60 * 1000; // 24h

// --- Track-2 types ---

export interface AnchorPreviewEventInput {
  tool: AnchorPreviewTool;
  /** Item IDs (messageId / taskId) surfaced in this preview response. */
  itemIds: string[];
  /** Total chars of the returned (anchored/preview) payload. */
  returnedChars: number;
  /** Total chars of the original (full) payload before anchor truncation. */
  originalChars: number;
  /** Test-only: override timestamp for deterministic eviction tests. */
  _testTimestamp?: number;
}

export interface AnchorPreviewEvent {
  id: string;
  timestamp: number;
  tool: AnchorPreviewTool;
  itemIds: string[];
  itemCount: number;
  returnedChars: number;
  originalChars: number;
}

export interface AnchorDrillEventInput {
  tool: AnchorDrillTool;
  /** The single item ID being drilled (full body requested). */
  itemId: string;
  /** Total chars served in the full drill response. */
  fullDrillChars: number;
  /** Test-only: override timestamp for deterministic eviction tests. */
  _testTimestamp?: number;
}

export interface AnchorDrillEvent {
  id: string;
  timestamp: number;
  tool: AnchorDrillTool;
  itemId: string;
  fullDrillChars: number;
}

// --- Track-2 internal state (ring buffer) ---

let previewEvents: AnchorPreviewEvent[] = [];
let drillEvents: AnchorDrillEvent[] = [];
let eventCounter = 0;

// --- Eviction helpers ---

function evictOldPreviewEvents(): void {
  const cutoff = Date.now() - EVICTION_TTL_MS;
  previewEvents = previewEvents.filter((e) => e.timestamp >= cutoff);
}

function evictOldDrillEvents(): void {
  const cutoff = Date.now() - EVICTION_TTL_MS;
  drillEvents = drillEvents.filter((e) => e.timestamp >= cutoff);
}

// --- Track-2 recording ---

/**
 * Record a per-response preview event with correlation keys.
 * Evicts events older than 24h before appending (INV-2).
 */
export function recordAnchorPreviewEvent(input: AnchorPreviewEventInput): void {
  // Cloud R5 P2: empty polls (0 items) create rollup noise — skip silently.
  if (input.itemIds.length === 0) return;
  evictOldPreviewEvents();
  const event: AnchorPreviewEvent = {
    id: String(++eventCounter),
    timestamp: input._testTimestamp ?? Date.now(),
    tool: input.tool,
    itemIds: [...input.itemIds],
    itemCount: input.itemIds.length,
    returnedChars: input.returnedChars,
    originalChars: input.originalChars,
  };
  previewEvents.push(event);
}

/**
 * Record a per-item drill event with correlation key.
 * Evicts events older than 24h before appending (INV-2).
 */
export function recordAnchorDrillEvent(input: AnchorDrillEventInput): void {
  evictOldDrillEvents();
  const event: AnchorDrillEvent = {
    id: String(++eventCounter),
    timestamp: input._testTimestamp ?? Date.now(),
    tool: input.tool,
    itemId: input.itemId,
    fullDrillChars: input.fullDrillChars,
  };
  drillEvents.push(event);
}

// --- Track-2 snapshot ---

export interface AnchorEventSnapshot {
  previewEvents: AnchorPreviewEvent[];
  drillEvents: AnchorDrillEvent[];
}

/** Return a deep copy of the event log (copy-on-read, INV-5). */
export function getAnchorEventSnapshot(): AnchorEventSnapshot {
  return {
    previewEvents: previewEvents.map((e) => ({ ...e, itemIds: [...e.itemIds] })),
    drillEvents: drillEvents.map((e) => ({ ...e })),
  };
}

// --- Track-2 rollup (double-sided net benefit) ---

export interface AnchorToolRollup {
  previewResponses: number;
  previewedItems: number;
  drills: number;
  drilledUniqueItems: number;
  /** drilledUniqueItems / previewedItems (0 when no previewed items). */
  openRateByItem: number;
  returnedChars: number;
  originalChars: number;
  /** originalChars − returnedChars. */
  charsSaved: number;
  /** Sum of fullDrillChars from drills attributed to this tool. */
  drillChars: number;
  /** charsSaved − drillChars: the DOUBLE-SIDED net benefit (砚砚 KD). */
  netBenefit: number;
}

export interface AnchorTelemetryRollup {
  perTool: Record<string, AnchorToolRollup>;
  /** Drills whose itemId matched no preview event in the window. */
  orphanDrills: number;
  /** Track-1 aggregate snapshot included for cross-reference. */
  track1Snapshot: AnchorTelemetrySnapshot;
}

export interface AnchorRollupWindow {
  windowStartMs: number;
  windowEndMs: number;
}

/**
 * Compute the per-tool open-rate rollup over a time window.
 *
 * Algorithm:
 *  1. Filter preview + drill events by [windowStartMs, windowEndMs).
 *  2. Build itemId → preview-tool map (most recent preview wins, INV-6).
 *  3. Attribute each drill to the preview tool that last surfaced the drilled
 *     item. Drills with no matching preview are counted as orphanDrills.
 *  4. Compute per-tool stats including double-sided net benefit.
 */
export function getAnchorTelemetryRollup(window: AnchorRollupWindow): AnchorTelemetryRollup {
  const windowPreviews = previewEvents.filter(
    (e) => e.timestamp >= window.windowStartMs && e.timestamp < window.windowEndMs,
  );
  const windowDrills = drillEvents.filter(
    (e) => e.timestamp >= window.windowStartMs && e.timestamp < window.windowEndMs,
  );

  // Step 2: Accumulate preview-side stats per tool (independent of drill attribution).
  const toolStats = new Map<
    string,
    {
      previewResponses: number;
      previewedItemIds: Set<string>;
      drills: number;
      drilledItemIds: Set<string>;
      returnedChars: number;
      originalChars: number;
      drillChars: number;
    }
  >();

  const getOrCreateStats = (tool: string) => {
    let stats = toolStats.get(tool);
    if (!stats) {
      stats = {
        previewResponses: 0,
        previewedItemIds: new Set(),
        drills: 0,
        drilledItemIds: new Set(),
        returnedChars: 0,
        originalChars: 0,
        drillChars: 0,
      };
      toolStats.set(tool, stats);
    }
    return stats;
  };

  for (const preview of windowPreviews) {
    const stats = getOrCreateStats(preview.tool);
    stats.previewResponses++;
    for (const itemId of preview.itemIds) stats.previewedItemIds.add(itemId);
    stats.returnedChars += preview.returnedChars;
    stats.originalChars += preview.originalChars;
  }

  // Step 3: Timeline-interleaved drill attribution (砚砚 R1 P1-2 + R2 P1-1).
  //
  // Process preview and drill events in timestamp order. Maintain a running
  // itemToTool map: when processing a drill, the map only contains previews
  // that happened BEFORE the drill → correct temporal causality.
  //
  // - Drill before any preview of that item → orphan
  // - Drill between preview1(tool-A) and preview2(tool-B) → attributed to tool-A
  // - Drill after preview2 → attributed to tool-B (most-recent-preview-wins)
  //
  // Tie-break: at equal timestamps, use the monotonic event ID (shared counter
  // across preview + drill arrays) as the definitive ordering. This respects
  // actual recording order rather than assuming preview always precedes drill
  // at the same ms (cloud R4 P2: Date.now() collisions are plausible for
  // back-to-back callback requests).
  const timeline: Array<{ kind: 'preview' | 'drill'; ts: number; idx: number; eventId: number }> = [
    ...windowPreviews.map((e, i) => ({ kind: 'preview' as const, ts: e.timestamp, idx: i, eventId: Number(e.id) })),
    ...windowDrills.map((e, i) => ({ kind: 'drill' as const, ts: e.timestamp, idx: i, eventId: Number(e.id) })),
  ];
  timeline.sort((a, b) => {
    if (a.ts !== b.ts) return a.ts - b.ts;
    // Same ms: monotonic event ID captures actual recording order
    return a.eventId - b.eventId;
  });

  const itemToTool = new Map<string, string>();
  let orphanDrills = 0;

  for (const entry of timeline) {
    if (entry.kind === 'preview') {
      const preview = windowPreviews[entry.idx];
      for (const itemId of preview.itemIds) {
        itemToTool.set(itemId, preview.tool);
      }
    } else {
      const drill = windowDrills[entry.idx];
      const tool = itemToTool.get(drill.itemId);
      if (!tool) {
        orphanDrills++;
      } else {
        const stats = getOrCreateStats(tool);
        stats.drills++;
        stats.drilledItemIds.add(drill.itemId);
        stats.drillChars += drill.fullDrillChars;
      }
    }
  }

  // Step 4: Build result
  const perTool: Record<string, AnchorToolRollup> = {};
  for (const [tool, stats] of toolStats) {
    const charsSaved = stats.originalChars - stats.returnedChars;
    const previewedItems = stats.previewedItemIds.size;
    perTool[tool] = {
      previewResponses: stats.previewResponses,
      previewedItems,
      drills: stats.drills,
      drilledUniqueItems: stats.drilledItemIds.size,
      openRateByItem: previewedItems > 0 ? stats.drilledItemIds.size / previewedItems : 0,
      returnedChars: stats.returnedChars,
      originalChars: stats.originalChars,
      charsSaved,
      drillChars: stats.drillChars,
      netBenefit: charsSaved - stats.drillChars,
    };
  }

  return {
    perTool,
    orphanDrills,
    track1Snapshot: getAnchorTelemetrySnapshot(),
  };
}

// --- Track-2 test reset ---

/** Test-only — reset Track-2 event log state between cases. NEVER call from prod code. */
export function resetAnchorEventLogForTest(): void {
  previewEvents = [];
  drillEvents = [];
  eventCounter = 0;
}
