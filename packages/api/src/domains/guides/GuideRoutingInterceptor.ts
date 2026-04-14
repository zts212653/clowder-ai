/**
 * B-2: Guide Routing Interceptor — decouples guide logic from routing core.
 *
 * Three phases, called at well-defined points by route-serial / route-parallel:
 * 1. prepareGuideContext()  — resolve existing state + match new candidates (before loop)
 * 2. guideContextForCat()   — decide per-cat injection (inside loop)
 * 3. ackGuideCompletion()   — write completionAcked (after cat output)
 *
 * Routing core stays guide-agnostic: no guide imports, no state machine knowledge.
 */

import type { GuideStateV1 } from '../cats/services/stores/ports/ThreadStore.js';
import type { GuideStateBridge, IGuideSessionStore } from './GuideSessionRepository.js';
import { sessionToLegacyState } from './GuideSessionRepository.js';
import { canAccessGuideState, hasHiddenForeignNonTerminalGuideState } from './guide-state-access.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Matches InvocationContext.guideCandidate in SystemPromptBuilder. */
export interface GuideCandidate {
  id: string;
  name: string;
  estimatedTime: string;
  status: 'offered' | 'awaiting_choice' | 'active' | 'completed';
  isNewOffer?: boolean;
  userSelection?: string;
}

/** Thread shape required by guide interceptor (subset of full thread record). */
interface GuideThread {
  id: string;
  createdBy: string;
  guideState?: GuideStateV1;
}

/** Internal state produced by prepare(), consumed by inject/ack. */
export interface GuideRoutingContext {
  candidate?: GuideCandidate;
  offerOwner?: string;
  offerSelectionFallback?: string;
  completionOwner?: string;
  completionFallback?: string;
  hiddenForeign: boolean;
}

// ---------------------------------------------------------------------------
// Ownership helpers (moved from route-serial / route-parallel)
// ---------------------------------------------------------------------------

function shouldHandleCompleted(
  completionOwner: string | undefined,
  targetCatIds: ReadonlySet<string>,
  fallback: string | undefined,
  catId: string,
): boolean {
  if (!completionOwner) return true;
  if (completionOwner === catId) return true;
  if (!targetCatIds.has(completionOwner)) return fallback === catId;
  return false;
}

function shouldHandleOffered(
  offerOwner: string | undefined,
  targetCatIds: ReadonlySet<string>,
  fallback: string | undefined,
  catId: string,
  hasSelection: boolean,
  allowFallback = false,
): boolean {
  if (!offerOwner) return true;
  if (offerOwner === catId) return true;
  if ((hasSelection || allowFallback) && !targetCatIds.has(offerOwner)) {
    return fallback === catId;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Phase 1: Prepare — helpers
// ---------------------------------------------------------------------------

async function resolveRegistryEntry(guideId: string): Promise<{ name: string; estimatedTime: string } | undefined> {
  try {
    const { getRegistryEntries } = await import('./guide-registry-loader.js');
    const entry = getRegistryEntries().find((e) => e.id === guideId);
    if (!entry) return undefined;
    return { name: entry.name, estimatedTime: entry.estimated_time };
  } catch {
    return undefined;
  }
}

function needsFallback(offeredBy: string | undefined, targetCatIds: ReadonlySet<string>): boolean {
  return offeredBy !== undefined && !targetCatIds.has(offeredBy);
}

/** Resolve offer/completion ownership into ctx. */
function resolveOwnership(
  gs: GuideStateV1,
  selectionMatch: RegExpMatchArray | null,
  justCompleted: boolean,
  targetCats: readonly string[],
  targetCatIds: ReadonlySet<string>,
  ctx: GuideRoutingContext,
): void {
  if (gs.status === 'offered' || gs.status === 'awaiting_choice') {
    ctx.offerOwner = gs.offeredBy;
    if ((selectionMatch || gs.status === 'awaiting_choice') && needsFallback(gs.offeredBy, targetCatIds)) {
      ctx.offerSelectionFallback = targetCats[0];
    }
  }
  if (justCompleted) {
    ctx.completionOwner = gs.offeredBy;
    if (needsFallback(gs.offeredBy, targetCatIds)) {
      ctx.completionFallback = targetCats[0];
    }
  }
}

/** Build candidate + ownership from existing thread guide state. */
async function resolveExistingCandidate(
  gs: GuideStateV1,
  message: string,
  targetCats: readonly string[],
  targetCatIds: ReadonlySet<string>,
  ctx: GuideRoutingContext,
): Promise<void> {
  const justCompleted = gs.status === 'completed' && !gs.completionAcked;
  const shouldInject = (gs.status !== 'completed' && gs.status !== 'cancelled') || justCompleted;
  if (!shouldInject) return;

  const entry = await resolveRegistryEntry(gs.guideId);
  const selectionMatch = message.match(/^引导流程：(.+)$/);
  ctx.candidate = {
    id: gs.guideId,
    name: entry?.name ?? gs.guideId,
    estimatedTime: entry?.estimatedTime ?? '',
    status: gs.status as GuideCandidate['status'],
    ...(gs.status === 'offered' ? { isNewOffer: false } : {}),
    ...(selectionMatch ? { userSelection: selectionMatch[1] } : {}),
  };

  resolveOwnership(gs, selectionMatch, justCompleted, targetCats, targetCatIds, ctx);
}

/**
 * B-6: Detect explicit guide trigger from message.
 * `/guide <name>` or `引导 <name>` are explicit commands that bypass
 * confidence thresholds and dismiss suppression.
 */
const EXPLICIT_GUIDE_RE = /^(?:\/guide\b|引导(?=\s|$))/i;

export function isExplicitGuideRequest(message: string): boolean {
  return EXPLICIT_GUIDE_RE.test(message.trim());
}

/** Strip explicit command prefix so keyword matching sees the intent. */
export function stripExplicitPrefix(message: string): string {
  return message.trim().replace(EXPLICIT_GUIDE_RE, '').trim();
}

/** Match raw user message against guide registry with B-6 offer policy. */
async function matchNewCandidate(
  message: string,
  targetCats: readonly string[],
  userId: string,
  log: { info: (...args: unknown[]) => void } | undefined,
  ctx: GuideRoutingContext,
  dismissTracker?: import('./GuideDismissTracker.js').IGuideDismissTracker,
): Promise<void> {
  try {
    const { resolveGuideForIntent, getTriggerStrategies, getRegistryEntries } = await import(
      './guide-registry-loader.js'
    );
    const { evaluateGuideOffer } = await import('./GuideOfferPolicy.js');

    const isExplicit = isExplicitGuideRequest(message);
    const intent = isExplicit ? stripExplicitPrefix(message) : message;
    if (!intent) return;

    // B-6: Explicit triggers try direct ID/name match first, then keyword fallback
    let matches = resolveGuideForIntent(intent);
    if (matches.length === 0 && isExplicit) {
      const normalized = intent.toLowerCase().replace(/[-_]/g, ' ').trim();
      const entry = getRegistryEntries().find(
        (e) => e.id.toLowerCase() === intent.toLowerCase() || e.name.toLowerCase() === normalized,
      );
      if (entry) {
        matches = [
          {
            id: entry.id,
            name: entry.name,
            description: entry.description,
            estimatedTime: entry.estimated_time,
            score: entry.keywords.length,
            totalKeywords: entry.keywords.length,
          },
        ];
      }
    }
    if (matches.length === 0) return;

    // B-6: Fetch dismiss counts + trigger strategies, apply policy
    const guideIds = matches.map((m) => m.id);
    const dismissCounts = dismissTracker
      ? await dismissTracker.getDismissCounts(userId, guideIds).catch(() => ({}))
      : {};
    const triggerStrategies = getTriggerStrategies();

    const result = evaluateGuideOffer({
      candidates: matches.map((m) => ({
        id: m.id,
        name: m.name,
        score: m.score,
        totalKeywords: m.totalKeywords,
      })),
      triggerStrategies,
      userId,
      isExplicitTrigger: isExplicit,
      dismissCounts,
    });

    if (result) {
      const top = matches.find((m) => m.id === result.id)!;
      ctx.candidate = {
        id: top.id,
        name: top.name,
        estimatedTime: top.estimatedTime,
        status: 'offered',
        isNewOffer: true,
      };
      ctx.offerOwner = targetCats[0];
      log?.info(
        { guideId: top.id, guideName: top.name, confidence: result.confidence },
        '[F155] guide candidate accepted by offer policy',
      );
    }
  } catch {
    /* best-effort: guide matching failure does not block invocation */
  }
}

// ---------------------------------------------------------------------------
// Phase 1: Prepare
// ---------------------------------------------------------------------------

/**
 * Resolve existing guide state from thread + match new candidates from message.
 * Called once before the routing loop. Accepts the already-fetched thread record
 * so the routing core doesn't re-read.
 */
export async function prepareGuideContext(params: {
  thread: GuideThread | null | undefined;
  guideSessionStore?: IGuideSessionStore;
  targetCats: readonly string[];
  message: string;
  userId: string;
  threadId: string;
  log?: { info: (...args: unknown[]) => void };
  /** B-6: Optional dismiss tracker for offer policy. */
  dismissTracker?: import('./GuideDismissTracker.js').IGuideDismissTracker;
}): Promise<GuideRoutingContext> {
  const { thread, guideSessionStore, targetCats, message, userId, threadId, log, dismissTracker } = params;
  const targetCatIds = new Set(targetCats);
  const ctx: GuideRoutingContext = { hiddenForeign: false };

  // Read guide state from independent store (B-4) or fallback to thread.guideState
  let guideState: GuideStateV1 | undefined;
  if (guideSessionStore) {
    const session = await guideSessionStore.getByThread(threadId).catch(() => null);
    if (session) {
      const legacy = sessionToLegacyState(session);
      ctx.hiddenForeign = hasHiddenForeignNonTerminalGuideState(thread, legacy, userId);
      guideState = canAccessGuideState(thread, legacy, userId) ? legacy : undefined;
    }
  } else if (thread) {
    const threadGuideState = thread.guideState;
    ctx.hiddenForeign = hasHiddenForeignNonTerminalGuideState(thread, threadGuideState, userId);
    guideState = canAccessGuideState(thread, threadGuideState, userId) ? threadGuideState : undefined;
  }

  if (guideState) {
    await resolveExistingCandidate(guideState, message, targetCats, targetCatIds, ctx);
  }

  if (!ctx.candidate && !ctx.hiddenForeign) {
    await matchNewCandidate(message, targetCats, userId, log, ctx, dismissTracker);
  }

  return ctx;
}

// ---------------------------------------------------------------------------
// Phase 2: Per-cat injection
// ---------------------------------------------------------------------------

/**
 * Returns the guide-related fields to spread into InvocationContext for a specific cat.
 * Empty object means this cat should not see guide state.
 */
export function guideContextForCat(
  ctx: GuideRoutingContext,
  catId: string,
  targetCatIds: ReadonlySet<string>,
  threadId: string,
): { guideCandidate: GuideCandidate; threadId: string } | Record<string, never> {
  const c = ctx.candidate;
  if (!c) return {};

  const eligible =
    c.status === 'completed'
      ? shouldHandleCompleted(ctx.completionOwner, targetCatIds, ctx.completionFallback, catId)
      : c.status === 'offered' || c.status === 'awaiting_choice'
        ? shouldHandleOffered(
            ctx.offerOwner,
            targetCatIds,
            ctx.offerSelectionFallback,
            catId,
            Boolean(c.userSelection),
            c.status === 'awaiting_choice',
          )
        : true; // active: always inject

  return eligible ? { guideCandidate: c, threadId } : {};
}

// ---------------------------------------------------------------------------
// Phase 3: Completion ack
// ---------------------------------------------------------------------------

/**
 * After a cat produces visible output, ack guide completion so the one-shot
 * congratulation message isn't re-injected on the next turn.
 */
export async function ackGuideCompletion(params: {
  ctx: GuideRoutingContext;
  catId: string;
  catProducedOutput: boolean;
  targetCatIds: ReadonlySet<string>;
  threadId: string;
  userId: string;
  guideStore: GuideStateBridge;
  threadStore: { get(id: string): GuideThread | null | Promise<GuideThread | null> };
}): Promise<void> {
  const { ctx, catId, catProducedOutput, targetCatIds, threadId, userId, guideStore, threadStore } = params;
  if (!catProducedOutput) return;
  if (ctx.candidate?.status !== 'completed') return;
  if (!shouldHandleCompleted(ctx.completionOwner, targetCatIds, ctx.completionFallback, catId)) return;

  try {
    // Re-verify access at ack time (thread for ownership, guideStore for state)
    const [thread, gs] = await Promise.all([threadStore.get(threadId), guideStore.get(threadId)]);
    if (!thread || !gs) return;
    if (!canAccessGuideState(thread, gs, userId)) return;
    if (gs.guideId === ctx.candidate.id && gs.status === 'completed' && !gs.completionAcked) {
      await guideStore.set(threadId, { ...gs, completionAcked: true });
    }
  } catch {
    /* best-effort: ack failure means next turn re-injects, which is acceptable */
  }
}
