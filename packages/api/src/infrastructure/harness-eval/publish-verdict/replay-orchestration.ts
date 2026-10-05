/**
 * R7 — Canonical Replay Orchestration.
 *
 * Centralizes ALL `no_new_window` decisions. Success requires canonical proof
 * from a fresh origin/main snapshot with matching source identity. Live-tree
 * state alone is NEVER sufficient for typed success when replay infrastructure
 * (source verification) is present.
 *
 * Two entry points:
 *  - `resolvePrePublishReplay()` — before the publisher starts (Layer 1b + 1a)
 *  - `resolvePostPublishCollision()` — catch block after publisher failure (Layer 2)
 *
 * Both enforce the same authority: no_new_window requires mainReader + source
 * verification for domains with replay infrastructure. Domains without replay
 * infrastructure (A2A etc.) use backward-compatible packet-ID checks.
 *
 * @module
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type {
  FreshMainReader,
  HandlerError,
  ReplayPreflight,
  SourceEquivalenceCheck,
  VerdictSourceRefs,
} from './types.js';

export interface ReplayOrchestrationContext {
  mainReader: FreshMainReader | undefined;
  /** R8: factory for post-collision re-resolution — publisher collision is evidence
   * that origin/main may have advanced after the pre-publish snapshot. */
  createFreshMainReader?: () => FreshMainReader | undefined | Promise<FreshMainReader | undefined>;
  harnessFeedbackRoot: string;
  domainId: string;
  replayPreflight?: ReplayPreflight;
  checkStoredSourceEquivalence?: SourceEquivalenceCheck;
}

export type ReplayDecision =
  | { outcome: 'replay'; canonicalVerdictId: string }
  | { outcome: 'conflict'; error: HandlerError }
  | { outcome: 'proceed' };

/**
 * Pre-publish canonical replay check. Runs BEFORE the publisher starts.
 *
 * Layer 1b: Domain-specific window+source preflight (delegates to injected
 * `replayPreflight` which is already main-first per R6/R7).
 *
 * Layer 1a: Packet-ID replay detection.
 *  - With source verification: requires canonical proof from origin/main.
 *    Live-only existence is not sufficient — publisher handles authoritatively.
 *  - Without source verification: live existence = replay (backward compat).
 */
export async function resolvePrePublishReplay(
  packetId: string,
  sourceRefs: VerdictSourceRefs,
  ctx: ReplayOrchestrationContext,
): Promise<ReplayDecision> {
  // Layer 1b: Domain-specific window+source preflight
  if (ctx.replayPreflight) {
    const result = await ctx.replayPreflight(sourceRefs, {
      harnessFeedbackRoot: ctx.harnessFeedbackRoot,
      domainId: ctx.domainId,
      mainReader: ctx.mainReader,
    });
    if (result?.kind === 'replay') {
      return { outcome: 'replay', canonicalVerdictId: result.storedVerdictId };
    }
    if (result?.kind === 'conflict') {
      return {
        outcome: 'conflict',
        error: {
          status: 409,
          error: 'verdict_window_already_published',
          detail: result.detail,
        },
      };
    }
  }

  // Layer 1a: Packet-ID replay detection
  if (ctx.checkStoredSourceEquivalence) {
    // Domain has source verification — require canonical proof from origin/main.
    // R7: live-only existence is NOT sufficient for typed success.
    return resolvePacketIdWithSourceVerification(packetId, sourceRefs, {
      ...ctx,
      checkStoredSourceEquivalence: ctx.checkStoredSourceEquivalence,
    });
  }

  // No source verification — backward compat: live existence = replay
  const liveVerdictPath = resolve(ctx.harnessFeedbackRoot, 'verdicts', `${packetId}.md`);
  const liveBundleDir = resolve(ctx.harnessFeedbackRoot, 'bundles', packetId);
  if (existsSync(liveVerdictPath) || existsSync(liveBundleDir)) {
    return { outcome: 'replay', canonicalVerdictId: packetId };
  }
  return { outcome: 'proceed' };
}

/**
 * Layer 1a with source verification: packet-ID must exist on origin/main
 * AND source identity must match. Without mainReader, proceed to publisher.
 */
async function resolvePacketIdWithSourceVerification(
  packetId: string,
  sourceRefs: VerdictSourceRefs,
  ctx: ReplayOrchestrationContext & { checkStoredSourceEquivalence: SourceEquivalenceCheck },
): Promise<ReplayDecision> {
  if (!ctx.mainReader) {
    // Cannot verify canonical state — proceed to publisher.
    // Publisher creates its own fresh worktree from origin/main.
    return { outcome: 'proceed' };
  }

  // R10: Check canonical presence on origin/main as a single tagged proof.
  // Verdict file and bundle lifecycle are separate artifacts; either one
  // existing means main has partial-or-complete canonical state.
  const mainHasVerdict = (await ctx.mainReader.readFile(`verdicts/${packetId}.md`)) !== null;
  const mainHasBundle = (await ctx.mainReader.readFile(`bundles/${packetId}/lifecycle-root.json`)) !== null;

  if (!mainHasVerdict && !mainHasBundle) {
    // Not on main at all — proceed to publisher regardless of live state.
    // Live-only is an in-flight/abandoned artifact, not canonical proof.
    return { outcome: 'proceed' };
  }

  if (!mainHasBundle) {
    // R10: Verdict exists on canonical main but bundle is incomplete/orphan.
    // Source identity verification requires a complete bundle; a verdict-only
    // artifact is insufficient proof. Fail closed — the publisher would also
    // detect this as verdict_already_exists_on_main.
    return {
      outcome: 'conflict',
      error: {
        status: 409,
        error: 'verdict_already_exists',
        detail: `Packet ${packetId} verdict exists on canonical main but bundle is incomplete — cannot verify source identity`,
      },
    };
  }

  // Complete canonical artifact — verify source identity
  return verifySourceIdentity(packetId, sourceRefs, ctx);
}

/**
 * R11: Post-collision canonical presence guard. When the publisher throws a
 * collision error, it proves main has the verdict. If the fresh reader can't
 * see any canonical artifact (verdict file OR lifecycle-root.json), the reader
 * is unreliable and we must fail closed — never let the equivalence checker
 * fall through to live source identity.
 */
async function readerCanSeeCanonicalArtifact(reader: FreshMainReader, verdictId: string): Promise<boolean> {
  return (
    (await reader.readFile(`verdicts/${verdictId}.md`)) !== null ||
    (await reader.readFile(`bundles/${verdictId}/lifecycle-root.json`)) !== null
  );
}

/**
 * R9: Resolve the reader for post-collision re-resolution.
 *
 * Distinguishes three cases to close the null-ambiguity gap:
 * - No factory provided → use pre-publish mainReader (backward compat)
 * - Factory provided, returns reader → use fresh reader
 * - Factory provided, returns undefined (fetch failure) → return undefined
 *   (fail closed — main advanced but we can't read it; stale reader is
 *   not trustworthy evidence for success decisions)
 */
async function resolveCollisionReader(ctx: ReplayOrchestrationContext): Promise<FreshMainReader | undefined> {
  if (!ctx.createFreshMainReader) {
    // No factory — pre-publish reader is the best available (backward compat)
    return ctx.mainReader;
  }
  // Factory exists — its result is authoritative. undefined = fetch failure → fail closed.
  return ctx.createFreshMainReader();
}

/**
 * R12: Shared collision verification — resolves a fresh reader, checks canonical
 * presence (R11 guard), and verifies source identity. Extracted from the
 * duplicated 2a/2b branches to reduce cognitive complexity.
 *
 * Returns replay when source matches, null to fall through to 409.
 */
async function verifyCollisionSourceIdentity(
  verdictId: string,
  sourceRefs: VerdictSourceRefs,
  ctx: ReplayOrchestrationContext & { checkStoredSourceEquivalence: SourceEquivalenceCheck },
): Promise<ReplayDecision | null> {
  const freshReader = await resolveCollisionReader(ctx);
  if (!freshReader) return null;
  // R11: collision proves main has the verdict. If a factory-created fresh
  // reader can't see any canonical artifact, the reader is unreliable.
  // Without a factory (backward compat), skip this guard.
  if (ctx.createFreshMainReader && !(await readerCanSeeCanonicalArtifact(freshReader, verdictId))) return null;
  try {
    const isEquiv = await ctx.checkStoredSourceEquivalence(verdictId, sourceRefs, {
      harnessFeedbackRoot: ctx.harnessFeedbackRoot,
      mainReader: freshReader,
    });
    if (isEquiv) return { outcome: 'replay', canonicalVerdictId: verdictId };
  } catch {
    // Can't verify → fall through to error mapping
  }
  return null;
}

/**
 * Post-publish collision intercept. Called in catch block when publisher
 * detects a collision on its own fresh worktree from origin/main.
 *
 * Returns a ReplayDecision when the collision can be resolved as replay,
 * or null to fall through to standard error mapping (→ 409).
 *
 * R8: publisher collision is evidence that origin/main may have advanced
 * after the pre-publish snapshot. Re-resolve with a fresh mainReader
 * before making replay/conflict decisions. Pre-publish reader is stale.
 *
 * R9: when the factory exists but returns undefined (fetch failure), fail
 * closed — do NOT fall back to stale pre-publish reader.
 */
export async function resolvePostPublishCollision(
  errorMessage: string,
  packetId: string,
  sourceRefs: VerdictSourceRefs,
  ctx: ReplayOrchestrationContext,
): Promise<ReplayDecision | null> {
  // 2a: verdict_already_exists_on_main — same packet ID on origin/main
  if (errorMessage.startsWith('verdict_already_exists_on_main')) {
    if (!ctx.checkStoredSourceEquivalence) {
      // No source verification — same packet ID = exact replay (backward compat)
      return { outcome: 'replay', canonicalVerdictId: packetId };
    }
    return verifyCollisionSourceIdentity(packetId, sourceRefs, {
      ...ctx,
      checkStoredSourceEquivalence: ctx.checkStoredSourceEquivalence,
    });
  }

  // 2b: verdict_window_already_published — window collision (different packet ID)
  if (errorMessage.startsWith('verdict_window_already_published')) {
    const match = errorMessage.match(/conflicts with existing verdict (.+)$/);
    const existingId = match?.[1]?.trim();
    if (!existingId || !ctx.checkStoredSourceEquivalence) return null;
    return verifyCollisionSourceIdentity(existingId, sourceRefs, {
      ...ctx,
      checkStoredSourceEquivalence: ctx.checkStoredSourceEquivalence,
    });
  }

  return null; // not a replay-related error
}

/**
 * Verify source identity for a known canonical packet on origin/main.
 * Same source → replay. Different/unverifiable → conflict (409).
 */
async function verifySourceIdentity(
  verdictId: string,
  sourceRefs: VerdictSourceRefs,
  ctx: {
    mainReader?: FreshMainReader;
    checkStoredSourceEquivalence?: SourceEquivalenceCheck;
    harnessFeedbackRoot: string;
  },
): Promise<ReplayDecision> {
  if (!ctx.checkStoredSourceEquivalence || !ctx.mainReader) {
    return {
      outcome: 'conflict',
      error: {
        status: 409,
        error: 'verdict_window_already_published',
        detail: `Packet ${verdictId} exists on origin/main but source identity cannot be verified`,
      },
    };
  }
  try {
    const isEquiv = await ctx.checkStoredSourceEquivalence(verdictId, sourceRefs, {
      harnessFeedbackRoot: ctx.harnessFeedbackRoot,
      mainReader: ctx.mainReader,
    });
    if (isEquiv) {
      return { outcome: 'replay', canonicalVerdictId: verdictId };
    }
  } catch {
    // Can't verify → fail closed (409)
  }
  return {
    outcome: 'conflict',
    error: {
      status: 409,
      error: 'verdict_window_already_published',
      detail: `Packet ${verdictId} exists on origin/main with different or unverifiable source identity`,
    },
  };
}
