/**
 * ConciergeReplyValidator (F229 KD-17 + Phase B)
 *
 * Post-processes duty cat reply text:
 * - Scans for [跳过去 R{n}] and [原地看 R{n}] markers
 * - Scans for <!-- triage-plan --> blocks (Phase B: TriagePlan extraction)
 * - Looks up HandleMap → validates anchor exists
 * - Returns CardBlock actions to inject before message storage
 *
 * Fail-closed: unknown handle → no action (no error).
 * Deduplicates: same (action, label) pair → single action.
 */

import { randomUUID } from 'node:crypto';
import type { TriagePlanIntent, TriagePlanTarget } from '@cat-cafe/shared';
import type { IConciergeHandleMapStore } from './ConciergeHandleMapStore.js';
import type { IConciergeTriagePlanStore } from './ConciergeTriagePlanStore.js';
import { resolveTargetCats, type TargetCatsResolverDeps } from './concierge-target-cats-resolver.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ConciergeAction {
  action: 'concierge_teleport' | 'concierge_peek' | 'concierge_triage_confirm' | 'concierge_triage_cancel';
  label: string;
  /** Marker handle (R1, R2, ...) for inline rendering — undefined in KD-19 fallback. */
  handle?: string;
  /** Marker verb (跳过去, 原地看) for inline rendering — undefined in KD-19 fallback. */
  verb?: string;
  payload: {
    threadId?: string;
    messageId?: string;
    /** TriagePlan confirm/cancel (Phase B) */
    planId?: string;
    intent?: string;
    summary?: string;
    targetCats?: string[];
  };
}

// ---------------------------------------------------------------------------
// Pattern matching
// ---------------------------------------------------------------------------

/** Matches [跳过去 R1], [原地看 R2], etc. */
const MARKER_PATTERN = /\[(跳过去|原地看)\s+(R\d+)\]/g;

const ACTION_MAP: Record<string, 'concierge_teleport' | 'concierge_peek'> = {
  跳过去: 'concierge_teleport',
  原地看: 'concierge_peek',
};

const LABEL_PREFIX: Record<string, string> = {
  跳过去: '跳过去',
  原地看: '原地看',
};

// ---------------------------------------------------------------------------
// Fail-closed guards
// ---------------------------------------------------------------------------

/**
 * Determine if an action should be skipped (fail-closed).
 *
 * - peek without messageId → no-op button (CardBlock.tsx:189 returns early)
 * - teleport for non-thread anchors → frontend can't navigate (only real threadIds)
 */
function shouldSkipAction(
  actionType: 'concierge_teleport' | 'concierge_peek',
  anchor: { messageId?: string; type: string },
): boolean {
  if (actionType === 'concierge_peek' && !anchor.messageId) return true;
  if (actionType === 'concierge_teleport' && anchor.type !== 'thread') return true;
  return false;
}

// ---------------------------------------------------------------------------
// Core
// ---------------------------------------------------------------------------

/**
 * Extract concierge CardBlock actions from duty cat reply text.
 *
 * @param replyText - raw reply text from the duty cat
 * @param threadId - concierge thread ID (HandleMap scope)
 * @param store - HandleMap store for anchor lookups
 * @returns actions array ready to inject into CardBlock (may be empty)
 */
export async function extractConciergeActions(
  replyText: string,
  threadId: string,
  store: IConciergeHandleMapStore,
): Promise<ConciergeAction[]> {
  // 1. Extract all marker matches via matchAll (avoids biome assignment-in-expression warning)
  const matches: Array<{ verb: string; handle: string }> = [];
  for (const m of replyText.matchAll(MARKER_PATTERN)) {
    matches.push({ verb: m[1], handle: m[2] });
  }

  if (matches.length === 0) return [];

  // 2. Deduplicate (verb + handle)
  const seen = new Set<string>();
  const unique: Array<{ verb: string; handle: string }> = [];
  for (const match of matches) {
    const key = `${match.verb}:${match.handle}`;
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(match);
    }
  }

  // 3. Look up each handle and build actions (fail-closed)
  const actions: ConciergeAction[] = [];
  for (const { verb, handle } of unique) {
    const anchor = await store.getHandle(threadId, handle);
    if (!anchor) continue; // fail-closed: unknown handle → skip

    const actionType = ACTION_MAP[verb];
    if (!actionType) continue; // safety guard
    if (shouldSkipAction(actionType, anchor)) continue;

    actions.push({
      action: actionType,
      label: `${LABEL_PREFIX[verb]}：${anchor.title}`,
      handle,
      verb,
      payload: {
        threadId: anchor.threadId,
        ...(anchor.messageId != null ? { messageId: anchor.messageId } : {}),
      },
    });
  }

  return actions;
}

/** Cap on fallback action count — avoid flooding the card with buttons when HandleMap is full. */
const FALLBACK_MAX_ACTIONS = 8;

/**
 * Build concierge CardBlock actions with KD-19 fallback (AC-A3 robustness).
 *
 * Marker-first: if the duty cat used [跳过去/原地看 Rn] markers, honor its curation
 * (sonnet-class compliance) and return only those actions.
 *
 * Fallback: if the duty cat produced NO usable marker actions (gemini-class
 * non-compliance — knows the protocol but ignores it, per KD-19 alpha comparison),
 * surface ALL thread-type handles from the HandleMap as a "related records"
 * clickable list. AC-A3 (the goldfish-memory use case) must not depend on duty
 * cat marker compliance.
 *
 * Non-thread handles (feature/doc) are skipped — only real threads are navigable.
 * Markers remain a bonus (in-body precise highlight is a Phase B enhancement).
 */
export async function buildConciergeActions(
  replyText: string,
  threadId: string,
  store: IConciergeHandleMapStore,
  triageDeps?: TriagePlanExtractionDeps,
): Promise<ConciergeAction[]> {
  // Phase B: check for triage-plan markers first (higher priority than handle markers)
  if (triageDeps) {
    const triageActions = await extractTriagePlanActions(replyText, threadId, store, triageDeps);
    if (triageActions.length > 0) {
      // Combine triage actions with any handle-based actions (triage first)
      const handleActions = await extractConciergeActions(replyText, threadId, store);
      return [...triageActions, ...handleActions];
    }
  }

  const markerActions = await extractConciergeActions(replyText, threadId, store);
  if (markerActions.length > 0) return markerActions;

  const handles = await store.getAllHandles(threadId);
  const actions: ConciergeAction[] = [];
  for (const { anchor } of handles) {
    if (anchor.type !== 'thread') continue; // only real threads are navigable
    actions.push({
      action: 'concierge_teleport',
      label: `跳过去：${anchor.title}`,
      payload: {
        threadId: anchor.threadId,
        ...(anchor.messageId != null ? { messageId: anchor.messageId } : {}),
      },
    });
    if (anchor.messageId) {
      actions.push({
        action: 'concierge_peek',
        label: `原地看：${anchor.title}`,
        payload: { threadId: anchor.threadId, messageId: anchor.messageId },
      });
    }
  }
  return actions.slice(0, FALLBACK_MAX_ACTIONS);
}

// ---------------------------------------------------------------------------
// Phase B: TriagePlan extraction from <!-- triage-plan --> markers
// ---------------------------------------------------------------------------

/** Matches <!-- triage-plan --> ... <!-- /triage-plan --> blocks */
const TRIAGE_PLAN_PATTERN = /<!--\s*triage-plan\s*-->([\s\S]*?)<!--\s*\/triage-plan\s*-->/;

/**
 * Strip <!-- triage-plan --> markers from reply text before storage (cloud P2 fix).
 * Users should not see raw HTML comment markers in the concierge panel.
 * Also collapses resulting blank-line clusters to a single blank line.
 */
export function stripTriagePlanMarkers(text: string): string {
  const stripped = text.replace(TRIAGE_PLAN_PATTERN, '');
  // Collapse 3+ consecutive newlines (from marker removal) to double-newline
  return stripped.replace(/\n{3,}/g, '\n\n').trim();
}

const VALID_INTENTS = new Set<TriagePlanIntent>(['relay', 'go', 'propose_thread', 'investigate']);

/** Parse a field line like "**意图**: relay" → "relay" */
function parseTriageField(block: string, fieldName: string): string | undefined {
  const pattern = new RegExp(`\\*\\*${fieldName}\\*\\*\\s*[:：]\\s*(.+)`, 'm');
  const match = block.match(pattern);
  return match?.[1]?.trim();
}

export interface TriagePlanExtractionDeps {
  triagePlanStore: IConciergeTriagePlanStore;
  userId: string;
  sourceMessageId: string;
  targetCatsResolverDeps?: TargetCatsResolverDeps;
}

function parseHandleReference(value: string | undefined): string | undefined {
  const normalized = value?.trim().toUpperCase();
  return normalized && /^R\d+$/.test(normalized) ? normalized : undefined;
}

function parseExplicitTargetCats(value: string | undefined): string[] | undefined {
  if (!value) return undefined;
  const cats = value
    .split(/[\s,，、]+/)
    .map((item) => item.trim().replace(/^@/, ''))
    .filter(Boolean);
  return cats.length > 0 ? Array.from(new Set(cats)) : undefined;
}

async function resolveTriageTarget(
  intent: TriagePlanIntent,
  targetRaw: string | undefined,
  targetCatsRaw: string | undefined,
  conciergeThreadId: string,
  handleMapStore: IConciergeHandleMapStore,
  deps: TriagePlanExtractionDeps,
): Promise<{ target: TriagePlanTarget; label: string } | null> {
  if (intent === 'relay') {
    return resolveRelayTarget(targetRaw, targetCatsRaw, conciergeThreadId, handleMapStore, deps);
  }
  if (intent === 'go') {
    return resolveGoTarget(targetRaw, conciergeThreadId, handleMapStore);
  }
  return resolveQueryTarget(targetRaw);
}

async function resolveGoTarget(
  targetRaw: string | undefined,
  conciergeThreadId: string,
  handleMapStore: IConciergeHandleMapStore,
): Promise<{ target: TriagePlanTarget; label: string } | null> {
  const anchor = await lookupThreadAnchor(targetRaw, conciergeThreadId, handleMapStore);
  return anchor ? { target: { threadId: anchor.threadId, threadTitle: anchor.title }, label: anchor.title } : null;
}

async function resolveRelayTarget(
  targetRaw: string | undefined,
  targetCatsRaw: string | undefined,
  conciergeThreadId: string,
  handleMapStore: IConciergeHandleMapStore,
  deps: TriagePlanExtractionDeps,
): Promise<{ target: TriagePlanTarget; label: string } | null> {
  const anchor = await lookupThreadAnchor(targetRaw, conciergeThreadId, handleMapStore);
  if (!anchor) return null;

  const explicitCats = parseExplicitTargetCats(targetCatsRaw);
  const resolved = deps.targetCatsResolverDeps
    ? await resolveTargetCats(explicitCats, anchor.threadId, deps.targetCatsResolverDeps)
    : { targetCats: explicitCats ?? [], needsSelection: !(explicitCats && explicitCats.length > 0) };
  if (resolved.needsSelection) {
    if (resolved.targetCats.length === 0) return null;
    return {
      target: { threadId: anchor.threadId, threadTitle: anchor.title, candidateCats: resolved.targetCats },
      label: anchor.title,
    };
  }
  if (resolved.targetCats.length === 0) return null;

  return {
    target: { threadId: anchor.threadId, threadTitle: anchor.title, targetCats: resolved.targetCats },
    label: anchor.title,
  };
}

async function lookupThreadAnchor(
  targetRaw: string | undefined,
  conciergeThreadId: string,
  handleMapStore: IConciergeHandleMapStore,
): Promise<{ threadId: string; title: string } | null> {
  const handle = parseHandleReference(targetRaw);
  if (!handle) return null;

  const anchor = await handleMapStore.getHandle(conciergeThreadId, handle);
  return anchor?.type === 'thread' && anchor.threadId ? { threadId: anchor.threadId, title: anchor.title } : null;
}

function resolveQueryTarget(targetRaw: string | undefined): { target: TriagePlanTarget; label: string } | null {
  return targetRaw ? { target: { query: targetRaw }, label: targetRaw } : null;
}

function buildTriageConfirmActions(
  planId: string,
  intent: TriagePlanIntent,
  target: TriagePlanTarget,
  label: string,
  summary: string,
): ConciergeAction[] {
  if (intent === 'relay' && target.candidateCats?.length && !target.targetCats?.length) {
    return target.candidateCats.map((catId) => ({
      action: 'concierge_triage_confirm',
      label: `确认传话给 @${catId}：${label}`.trim(),
      payload: {
        planId,
        intent,
        summary,
        ...(target.threadId ? { threadId: target.threadId } : {}),
        targetCats: [catId],
      },
    }));
  }

  const confirmLabel =
    intent === 'relay'
      ? `确认传话：${label}`.trim()
      : intent === 'go'
        ? `确认跳转：${label}`.trim()
        : intent === 'propose_thread'
          ? `确认开新调查：${label}`.trim()
          : `确认调查：${label}`.trim();

  return [
    {
      action: 'concierge_triage_confirm',
      label: confirmLabel,
      payload: {
        planId,
        intent,
        summary,
        ...(target.threadId ? { threadId: target.threadId } : {}),
        // Note: do NOT include targetCats here for uniquely-resolved targets.
        // The plan already stores target.targetCats in Redis; the server uses it directly.
        // Including it causes the frontend to echo it back, triggering 422 because
        // validateSelectedTargetCats checks candidateCats (empty for unique resolution).
        // Only the multi-candidate branch (line 325-337 above) needs targetCats in payload.
      },
    },
  ];
}

export function extractTriagePlanIdsFromActions(actions: ConciergeAction[]): string[] {
  const ids = new Set<string>();
  for (const action of actions) {
    if (
      (action.action === 'concierge_triage_confirm' || action.action === 'concierge_triage_cancel') &&
      action.payload.planId
    ) {
      ids.add(action.payload.planId);
    }
  }
  return [...ids];
}

/**
 * Extract TriagePlan from duty cat reply text (Phase B).
 *
 * Parses `<!-- triage-plan -->` markers, creates a proposed TriagePlan in the store,
 * and returns confirm/cancel card actions for injection.
 *
 * @returns actions array with confirm + cancel buttons (empty if no triage-plan marker found)
 */
export async function extractTriagePlanActions(
  replyText: string,
  conciergeThreadId: string,
  handleMapStore: IConciergeHandleMapStore,
  deps: TriagePlanExtractionDeps,
): Promise<ConciergeAction[]> {
  const match = replyText.match(TRIAGE_PLAN_PATTERN);
  if (!match) return [];

  const block = match[1];
  const intentRaw = parseTriageField(block, '意图');
  const targetRaw = parseTriageField(block, '目标');
  const targetCatsRaw = parseTriageField(block, '目标猫');
  const originalText = parseTriageField(block, '原文');
  const summary = parseTriageField(block, '操作');

  // Fail-closed: invalid intent → no actions
  if (!intentRaw || !VALID_INTENTS.has(intentRaw as TriagePlanIntent)) return [];
  const intent = intentRaw as TriagePlanIntent;

  const resolvedTarget = await resolveTriageTarget(
    intent,
    targetRaw,
    targetCatsRaw,
    conciergeThreadId,
    handleMapStore,
    deps,
  );
  if (!resolvedTarget) return [];

  // Create TriagePlan in store (INV T1: proposed before card)
  const planId = randomUUID();
  const now = Date.now();
  await deps.triagePlanStore.create({
    id: planId,
    userId: deps.userId,
    sourceMessageId: deps.sourceMessageId,
    originalText: originalText || '',
    intent,
    target: resolvedTarget.target,
    status: 'proposed',
    createdAt: now,
    updatedAt: now,
  });

  return [
    ...buildTriageConfirmActions(
      planId,
      intent,
      resolvedTarget.target,
      resolvedTarget.label,
      summary || resolvedTarget.label,
    ),
    {
      action: 'concierge_triage_cancel',
      label: '取消',
      payload: {
        planId,
      },
    },
  ];
}
