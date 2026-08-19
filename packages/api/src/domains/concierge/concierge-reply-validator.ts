/**
 * ConciergeReplyValidator (F229 KD-17 → KD-27)
 *
 * Post-processes duty cat reply text:
 * - Scans for [跳过去 R{n}] and [原地看 R{n}] markers
 * - Scans for <!-- triage-plan --> blocks (Phase B: TriagePlan extraction)
 * - Resolves handles from per-invocation flowing handle table (KD-23)
 * - Returns CardBlock actions to inject before message storage
 *
 * KD-23: Handle table is passed directly — no shared store. Cross-turn
 * references fail-closed automatically (table is per-invocation).
 *
 * Fail-closed: unknown handle → no action (no error).
 * Deduplicates: same (action, label) pair → single action.
 */

import { randomUUID } from 'node:crypto';
import type { TriagePlanIntent, TriagePlanTarget } from '@cat-cafe/shared';
import type { IConciergeTriagePlanStore } from './ConciergeTriagePlanStore.js';
import {
  computeConciergeHandleDigest,
  formatConciergeHandleBindingTitle,
  type HandleAnchor,
  type HandleEntry,
  normalizeConciergeHandleTitle,
} from './concierge-search-context.js';
import { resolveTargetCats, type TargetCatsResolverDeps } from './concierge-target-cats-resolver.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ConciergeAction {
  action: 'concierge_teleport' | 'concierge_peek' | 'concierge_triage_confirm' | 'concierge_triage_cancel';
  label: string;
  /** Marker handle (R1, R2, ...) for inline rendering — undefined for card-only actions. */
  handle?: string;
  /** Marker verb (跳过去, 原地看) for inline rendering — undefined for card-only actions. */
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

/**
 * Matches only the complete handle/title/anchor-digest binding used for new
 * actions. Legacy or malformed marker-shaped text is detected separately by
 * its reserved prefix so a mixed valid/malformed reply invalidates the whole
 * marker set instead of accepting only its valid-looking subset.
 */
const MARKER_PATTERN = /\[(跳过去|原地看)\s+(R\d+)\s*[|｜]\s*([^|｜\]\r\n]+?)\s*[|｜]\s*([a-f0-9]{12})\]/gi;

const ACTION_MAP: Record<string, 'concierge_teleport' | 'concierge_peek'> = {
  跳过去: 'concierge_teleport',
  原地看: 'concierge_peek',
};

const LABEL_PREFIX: Record<string, string> = {
  跳过去: '跳过去',
  原地看: '原地看',
};

// ---------------------------------------------------------------------------
// Handle lookup (KD-23: local array lookup, no store)
// ---------------------------------------------------------------------------

/**
 * Find a handle anchor by label in the per-invocation handle table.
 * O(n) but n ≤ 20 (MAX_HANDLES), so fine.
 */
function findHandle(handles: HandleEntry[], label: string): HandleAnchor | null {
  const entry = handles.find((h) => h.label === label);
  return entry?.anchor ?? null;
}

function findBoundHandle(
  handles: HandleEntry[],
  label: string,
  boundTitle: string | undefined,
  boundDigest: string | undefined,
): HandleAnchor | null {
  if (!boundTitle || !boundDigest) return null;
  const anchor = findHandle(handles, label);
  if (!anchor) return null;
  const canonicalTitle = formatConciergeHandleBindingTitle(anchor.title);
  const titleMatches =
    boundTitle.trim() === canonicalTitle &&
    normalizeConciergeHandleTitle(boundTitle) === normalizeConciergeHandleTitle(anchor.title);
  const digestMatches = boundDigest.toLowerCase() === computeConciergeHandleDigest(label, anchor);
  return titleMatches && digestMatches ? anchor : null;
}

// ---------------------------------------------------------------------------
// Verb auto-correction (BUG-UX-9 fix)
// ---------------------------------------------------------------------------

type ActionVerb = '跳过去' | '原地看';

/**
 * Resolve the actual action type and display verb, auto-correcting when the
 * duty cat picked the wrong verb for the anchor's capabilities.
 *
 * BUG-UX-12: thread anchors → ALWAYS teleport, regardless of what the duty cat
 * requested or whether the anchor has a messageId. Concierge actions pointing to
 * threads are semantically jumps — "原地看" confuses users.
 * (operator feedback: "这些按钮本质的含义不是跳转吗？！")
 *
 * Resolution rules:
 * - thread type → always teleport (BUG-UX-12, supersedes BUG-UX-9 partial fix)
 * - non-thread → null (fail-closed: frontend can only navigate to real threadIds)
 */
function resolveAction(
  _requestedType: 'concierge_teleport' | 'concierge_peek',
  anchor: { messageId?: string; type: string },
): { actionType: 'concierge_teleport' | 'concierge_peek'; displayVerb: ActionVerb } | null {
  // BUG-UX-12: thread anchors → always teleport
  if (anchor.type === 'thread') {
    return { actionType: 'concierge_teleport', displayVerb: '跳过去' };
  }

  // Non-thread anchors are not navigable — frontend can only route to real threadIds.
  return null;
}

// ---------------------------------------------------------------------------
// Core
// ---------------------------------------------------------------------------

/**
 * Extract concierge CardBlock actions from duty cat reply text.
 *
 * KD-23: Takes handle table directly — no store interaction.
 * Cross-turn stale handles fail-closed automatically (table is per-invocation).
 *
 * @param replyText - raw reply text from the duty cat
 * @param handles - per-invocation handle table from buildConciergeSearchContext
 * @returns actions array ready to inject into CardBlock (may be empty)
 */
export function extractConciergeActions(replyText: string, handles: HandleEntry[]): ConciergeAction[] {
  return scanConciergeActions(replyText, handles).actions;
}

type MarkerScan =
  | { state: 'none'; actions: [] }
  | { state: 'valid'; actions: ConciergeAction[] }
  | { state: 'invalid'; actions: [] };

interface MarkerMatch {
  verb: string;
  handle: string;
  boundTitle?: string;
  boundDigest?: string;
}

function parseMarkerMatches(
  replyText: string,
): { state: 'none' | 'invalid'; matches: [] } | { state: 'found'; matches: MarkerMatch[] } {
  const matches: MarkerMatch[] = [];
  for (const match of replyText.matchAll(MARKER_PATTERN)) {
    matches.push({
      verb: match[1],
      handle: match[2].toUpperCase(),
      ...(match[3] ? { boundTitle: match[3] } : {}),
      ...(match[4] ? { boundDigest: match[4] } : {}),
    });
  }

  // A complete binding must not authorize a bare or malformed marker elsewhere
  // in the same reply. Remove every complete marker, then fail the whole set if
  // any reserved prefix remains for the frontend to interpret.
  const unparsedMarkerText = replyText.replace(new RegExp(MARKER_PATTERN.source, MARKER_PATTERN.flags), '');
  const hasMarkerPrefix = unparsedMarkerText.includes('[跳过去') || unparsedMarkerText.includes('[原地看');
  if (hasMarkerPrefix) return { state: 'invalid', matches: [] };
  if (matches.length > 0) return { state: 'found', matches };

  return { state: 'none', matches: [] };
}

function resolveMarkerAction(match: MarkerMatch, handles: HandleEntry[]): ConciergeAction | null {
  const anchor = findBoundHandle(handles, match.handle, match.boundTitle, match.boundDigest);
  if (!anchor) return null;

  const requestedType = ACTION_MAP[match.verb];
  if (!requestedType) return null;

  const resolved = resolveAction(requestedType, anchor);
  if (!resolved) return null;

  return {
    action: resolved.actionType,
    label: `${LABEL_PREFIX[resolved.displayVerb]}：${anchor.title}`,
    handle: match.handle,
    verb: match.verb,
    payload: {
      threadId: anchor.threadId,
      ...(anchor.messageId != null ? { messageId: anchor.messageId } : {}),
    },
  };
}

/**
 * Resolve all inline markers as one integrity unit.
 *
 * If any marker is unknown, bare, title-mismatched, or non-navigable, reject
 * the whole marker set. A partially trusted reply must never produce a button
 * for a different real thread.
 */
function scanConciergeActions(replyText: string, handles: HandleEntry[]): MarkerScan {
  const parsed = parseMarkerMatches(replyText);
  if (parsed.state !== 'found') return { state: parsed.state, actions: [] };

  // Look up each handle, resolve action, and deduplicate by resolved action+handle
  // (BUG-UX-9: dedup AFTER resolution — [跳过去 R1] and [原地看 R1] on the same
  // thread-only handle both resolve to teleport; dedup by verb would keep both)
  const seen = new Set<string>();
  const actions: ConciergeAction[] = [];
  for (const match of parsed.matches) {
    const action = resolveMarkerAction(match, handles);
    if (!action) return { state: 'invalid', actions: [] };

    // Dedup by resolved action type + handle (not raw verb + handle)
    const dedupeKey = `${action.action}:${match.handle}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    actions.push(action);
  }

  return { state: 'valid', actions };
}

/**
 * Build concierge CardBlock actions from explicit, integrity-bound intent.
 *
 * KD-23: Takes handle table directly — no store interaction.
 *
 * KD-26: the handle table is prefetch context, not a recommendation list. A
 * marker-free reply therefore produces no navigation actions. This preserves
 * action provenance when the duty cat finds better threads through later tool
 * calls: unrelated prefetch candidates must never impersonate those results.
 *
 * KD-27: a marker-free reply may receive one separately verified tool anchor.
 * That anchor comes from a successful, identity-matched get_thread_context
 * result in the same invocation; it is never derived from the prefetch table.
 */
export async function buildConciergeActions(
  replyText: string,
  handles: HandleEntry[],
  triageDeps?: TriagePlanExtractionDeps,
  verifiedToolAnchor?: HandleAnchor,
): Promise<ConciergeAction[]> {
  const visibleReplyText = stripTriagePlanMarkers(replyText);

  // Phase B: check for triage-plan markers first (higher priority than handle markers)
  if (triageDeps) {
    const triageActions = await extractTriagePlanActions(replyText, handles, triageDeps);
    if (triageActions.length > 0) {
      // Combine triage actions with any handle-based actions (triage first)
      const handleActions = extractConciergeActions(visibleReplyText, handles);
      return [...triageActions, ...handleActions];
    }
  }

  const markerScan = scanConciergeActions(visibleReplyText, handles);
  if (markerScan.state === 'valid') return markerScan.actions;
  if (markerScan.state === 'none' && verifiedToolAnchor) {
    const resolved = resolveAction('concierge_teleport', verifiedToolAnchor);
    if (!resolved) return [];
    return [
      {
        action: resolved.actionType,
        label: `${LABEL_PREFIX[resolved.displayVerb]}：${verifiedToolAnchor.title}`,
        payload: {
          threadId: verifiedToolAnchor.threadId,
          ...(verifiedToolAnchor.messageId != null ? { messageId: verifiedToolAnchor.messageId } : {}),
        },
      },
    ];
  }
  return [];
}

// ---------------------------------------------------------------------------
// Phase B: TriagePlan extraction from <!-- triage-plan --> markers
// ---------------------------------------------------------------------------

/** Matches <!-- triage-plan --> ... <!-- /triage-plan --> blocks */
const TRIAGE_PLAN_PATTERN = /<!--\s*triage-plan\s*-->([\s\S]*?)<!--\s*\/triage-plan\s*-->/;
const TRIAGE_PLAN_BLOCKS_PATTERN = /<!--\s*triage-plan\s*-->[\s\S]*?<!--\s*\/triage-plan\s*-->/gi;
const DANGLING_TRIAGE_PLAN_PATTERN = /<!--\s*triage-plan\s*-->[\s\S]*$/i;

/**
 * Strip every complete or dangling <!-- triage-plan --> control block before
 * ordinary action scanning or storage. Users should not see raw control data,
 * and hidden markers must never authorize ordinary actions.
 * Also collapses resulting blank-line clusters to a single blank line.
 */
export function stripTriagePlanMarkers(text: string): string {
  const stripped = text.replace(TRIAGE_PLAN_BLOCKS_PATTERN, '').replace(DANGLING_TRIAGE_PLAN_PATTERN, '');
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

function parseBoundHandleReference(
  value: string | undefined,
): { handle: string; title: string; digest: string } | undefined {
  const normalized = value?.trim();
  if (!normalized) return undefined;
  const bindingText = normalized.match(/^\[(?:跳过去|原地看)\s+(.+)\]$/)?.[1] ?? normalized;
  const match = bindingText.match(/^(R\d+)\s*[|｜]\s*([^|｜]+?)\s*[|｜]\s*([a-f0-9]{12})$/i);
  if (!match) return undefined;
  const title = match[2].trim();
  return title ? { handle: match[1].toUpperCase(), title, digest: match[3].toLowerCase() } : undefined;
}

function parseExplicitTargetCats(value: string | undefined): string[] | undefined {
  if (!value) return undefined;
  const cats = value
    .split(/[\s,，、]+/)
    .map((item) => item.trim().replace(/^@/, ''))
    .filter(Boolean);
  return cats.length > 0 ? Array.from(new Set(cats)) : undefined;
}

function resolveTriageTarget(
  intent: TriagePlanIntent,
  targetRaw: string | undefined,
  targetCatsRaw: string | undefined,
  handles: HandleEntry[],
  deps: TriagePlanExtractionDeps,
): Promise<{ target: TriagePlanTarget; label: string } | null> {
  if (intent === 'relay') {
    return resolveRelayTarget(targetRaw, targetCatsRaw, handles, deps);
  }
  if (intent === 'go') {
    return Promise.resolve(resolveGoTarget(targetRaw, handles));
  }
  return Promise.resolve(resolveQueryTarget(targetRaw));
}

function resolveGoTarget(
  targetRaw: string | undefined,
  handles: HandleEntry[],
): { target: TriagePlanTarget; label: string } | null {
  const anchor = lookupThreadAnchor(targetRaw, handles);
  return anchor ? { target: { threadId: anchor.threadId, threadTitle: anchor.title }, label: anchor.title } : null;
}

async function resolveRelayTarget(
  targetRaw: string | undefined,
  targetCatsRaw: string | undefined,
  handles: HandleEntry[],
  deps: TriagePlanExtractionDeps,
): Promise<{ target: TriagePlanTarget; label: string } | null> {
  const anchor = lookupThreadAnchor(targetRaw, handles);
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

/**
 * Look up a thread anchor by R-handle reference from the per-invocation table.
 * KD-23: direct array lookup, no store.
 */
function lookupThreadAnchor(
  targetRaw: string | undefined,
  handles: HandleEntry[],
): { threadId: string; title: string } | null {
  const binding = parseBoundHandleReference(targetRaw);
  if (!binding) return null;

  const anchor = findBoundHandle(handles, binding.handle, binding.title, binding.digest);
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
 * KD-23: Takes handle table directly for R-handle resolution.
 *
 * Parses `<!-- triage-plan -->` markers, creates a proposed TriagePlan in the store,
 * and returns confirm/cancel card actions for injection.
 *
 * @returns actions array with confirm + cancel buttons (empty if no triage-plan marker found)
 */
export async function extractTriagePlanActions(
  replyText: string,
  handles: HandleEntry[],
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

  const resolvedTarget = await resolveTriageTarget(intent, targetRaw, targetCatsRaw, handles, deps);
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
