/**
 * F236 Phase E — AnchorEvalBridgeConsumer
 *
 * Transform + lifecycle helpers for F236 PostToolUse hook eval jsonl entries.
 *
 * - **Pure transform**: `evalEntriesToPreviewEvents()` / `evalEntriesToDrillEvents()` — no I/O, no state
 * - **Lifecycle helpers**: `ingestEvalEntries()` / `cleanupSessionFiles()` — wrap
 *   the TranscriptTailer → transform → record pattern so the carrier doesn't
 *   inline try/catch/loop boilerplate (cloud R4 P1: file-size)
 *
 * The hook subprocess (`f236-anchor-posttool.mjs`) writes eval events to
 * `/tmp/cat-cafe-anchor-eval-{invocationId}.jsonl` with Track-2 compatible
 * fields. Two kinds of entries:
 * - **preview** (default): anchored output returned to cat → recordAnchorPreviewEvent()
 * - **drill** (kind='drill'): bounded Read pass-through after a locator → recordAnchorDrillEvent() + recordAnchorFullDrill()
 *
 * Data flow:
 *   hook subprocess → eval jsonl → TranscriptTailer → THIS CONSUMER → record{Preview,Drill}Event()
 */

import { rmSync } from 'node:fs';
import {
  type AnchorDrillEventInput,
  type AnchorPreviewEventInput,
  recordAnchorDrillEvent,
  recordAnchorPreviewEvent,
} from '../../../../../routes/anchor-event-log.js';
import type { AnchorDrillTool, AnchorPreviewTool } from '../../../../../routes/anchor-telemetry.js';
import { recordAnchorFullDrill } from '../../../../../routes/anchor-telemetry.js';
import type { TranscriptTailer } from './TranscriptTailer.js';

/** Bounded set of valid AnchorPreviewTool values — runtime validation for untrusted jsonl input. */
const VALID_PREVIEW_TOOLS: ReadonlySet<string> = new Set<AnchorPreviewTool>([
  'pending-mentions',
  'thread-context',
  'list-tasks',
  'get-message',
  'cc-read',
  'cc-grep',
  'cc-glob',
]);

/** Bounded set of valid cc AnchorDrillTool values — only cc tools emit drill via jsonl. */
const VALID_CC_DRILL_TOOLS: ReadonlySet<string> = new Set<AnchorDrillTool>(['cc-read', 'cc-grep', 'cc-glob']);

/**
 * Transform F236 hook eval jsonl entries to AnchorPreviewEventInput[].
 *
 * Pure function — no I/O, no state. Safe for incremental tailing.
 * Entries that fail validation are silently skipped (best-effort, same
 * contract as HookSidechannelConsumer).
 * Entries with `kind: 'drill'` are skipped here — use evalEntriesToDrillEvents().
 *
 * Required fields: `tool` (string, must be a valid AnchorPreviewTool), `itemIds` (array).
 * Optional fields: `originalChars`, `returnedChars`, `modeResolved`, `modeSource`, `catId`.
 * The `ts` field from the hook is NOT carried over — recordAnchorPreviewEvent()
 * uses Date.now() for its own timestamp (or _testTimestamp for tests).
 */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: validate-and-transform loop over unknown[] entries — same pattern as hookEntriesToAgentMessages
export function evalEntriesToPreviewEvents(entries: unknown[]): AnchorPreviewEventInput[] {
  const out: AnchorPreviewEventInput[] = [];

  for (const raw of entries) {
    if (typeof raw !== 'object' || raw === null) continue;
    const entry = raw as Record<string, unknown>;

    // Skip drill entries (handled by evalEntriesToDrillEvents)
    if (entry.kind === 'drill') continue;

    // Required: tool must be a valid AnchorPreviewTool (defense-in-depth for untrusted /tmp input)
    if (typeof entry.tool !== 'string' || !VALID_PREVIEW_TOOLS.has(entry.tool)) continue;

    // Required: itemIds must be array
    if (!Array.isArray(entry.itemIds)) continue;

    const input: AnchorPreviewEventInput = {
      tool: entry.tool as AnchorPreviewEventInput['tool'],
      itemIds: entry.itemIds.filter((id): id is string => typeof id === 'string'),
      returnedChars: typeof entry.returnedChars === 'number' ? entry.returnedChars : 0,
      originalChars: typeof entry.originalChars === 'number' ? entry.originalChars : 0,
    };

    // Optional Track-2 adoption eval fields
    if (entry.modeResolved === 'anchor' || entry.modeResolved === 'full') {
      input.modeResolved = entry.modeResolved;
    }
    if (entry.modeSource === 'explicit' || entry.modeSource === 'default' || entry.modeSource === 'legacy_equivalent') {
      input.modeSource = entry.modeSource;
    }
    if (typeof entry.catId === 'string') {
      input.catId = entry.catId;
    }

    out.push(input);
  }

  return out;
}

/**
 * Transform F236 hook eval jsonl drill entries to AnchorDrillEventInput[].
 *
 * Pure function — no I/O, no state. Only processes entries with `kind: 'drill'`.
 * Required fields: `kind` ('drill'), `tool` (valid cc drill tool), `itemId` (string), `fullDrillChars` (number).
 */
export function evalEntriesToDrillEvents(entries: unknown[]): AnchorDrillEventInput[] {
  const out: AnchorDrillEventInput[] = [];

  for (const raw of entries) {
    if (typeof raw !== 'object' || raw === null) continue;
    const entry = raw as Record<string, unknown>;

    if (entry.kind !== 'drill') continue;
    if (typeof entry.tool !== 'string' || !VALID_CC_DRILL_TOOLS.has(entry.tool)) continue;
    if (typeof entry.itemId !== 'string') continue;

    out.push({
      tool: entry.tool as AnchorDrillTool,
      itemId: entry.itemId,
      fullDrillChars: typeof entry.fullDrillChars === 'number' ? entry.fullDrillChars : 0,
      ...(entry.stale === true ? { stale: true } : {}),
    });
  }

  return out;
}

/**
 * Compute the eval jsonl file path for a given invocation ID.
 * Returns null if no invocation ID is provided.
 *
 * Must match the path convention in f236-anchor-posttool.mjs:resolveEvalFilePath().
 */
export function resolveEvalJsonlPath(invocationId: string | undefined): string | null {
  if (!invocationId) return null;
  return `/tmp/cat-cafe-anchor-eval-${invocationId}.jsonl`;
}

/**
 * Compute the mode file path for a given invocation ID.
 * Returns null if no invocation ID is provided.
 *
 * Must match the path convention in f236-anchor-posttool.mjs:resolveModeFilePath()
 * and callback-tools.ts:resolveAnchorModeFilePath().
 */
export function resolveModeFilePath(invocationId: string | undefined): string | null {
  if (!invocationId) return null;
  return `/tmp/cat-cafe-anchor-mode-${invocationId}`;
}

/**
 * Compute the file state tracking path for a given invocation ID.
 * Returns null if no invocation ID is provided.
 *
 * Must match the path convention in f236-anchor-posttool.mjs:resolveStateFilePath().
 */
export function resolveStateFilePath(invocationId: string | undefined): string | null {
  if (!invocationId) return null;
  return `/tmp/cat-cafe-anchor-filestate-${invocationId}.json`;
}

// ─── Lifecycle helpers (carrier file-size extraction, cloud R4 P1) ──────────

/**
 * Read new eval entries from the tailer, transform, and record as events.
 * Processes both preview entries (→ recordAnchorPreviewEvent) and
 * drill entries (→ recordAnchorDrillEvent + recordAnchorFullDrill).
 * Non-fatal: swallows errors so the carrier output loop is never interrupted.
 *
 * @param tailer  The TranscriptTailer polling the eval jsonl file
 * @param opts    Pass `{ includeTrailingPartial: true }` for final drain
 */
export async function ingestEvalEntries(
  tailer: TranscriptTailer,
  opts?: { includeTrailingPartial?: boolean },
): Promise<void> {
  try {
    const entries = await tailer.readNew(opts);
    if (entries.length > 0) {
      // Preview events
      const previewInputs = evalEntriesToPreviewEvents(entries);
      for (const input of previewInputs) {
        recordAnchorPreviewEvent(input);
      }
      // Drill events (cc-native bounded Read pass-through after anchor locator)
      const drillInputs = evalEntriesToDrillEvents(entries);
      for (const input of drillInputs) {
        recordAnchorDrillEvent(input);
        recordAnchorFullDrill({ tool: input.tool, fullDrillChars: input.fullDrillChars });
      }
    }
  } catch {
    // Eval bridge failure is non-fatal — never break the carrier output loop
  }
}

/**
 * Best-effort cleanup of F236 session files (eval jsonl + mode file + state file).
 * No-op for null paths. Swallows errors.
 */
export function cleanupSessionFiles(
  evalJsonlPath: string | null,
  modeFilePath: string | null,
  stateFilePath?: string | null,
): void {
  for (const path of [evalJsonlPath, modeFilePath, stateFilePath]) {
    if (path) {
      try {
        rmSync(path, { force: true });
      } catch {
        /* best-effort cleanup */
      }
    }
  }
}
