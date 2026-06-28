/**
 * F208 Phase E: Dossier Distillation API Routes
 *
 * POST /api/dossier/distillations           — create proposal (cat-initiated, AC-E1)
 * GET  /api/dossier/distillations           — list proposals (pending, or by cat)
 * GET  /api/dossier/distillations/:id       — get specific proposal
 * POST /api/dossier/distillations/:id/approve — operator approves (AC-E3)
 * POST /api/dossier/distillations/:id/reject  — operator rejects
 * POST /api/dossier/distillations/:id/apply   — cat applies approved draft (KD-18, manual SHA)
 * POST /api/dossier/distillations/:id/execute-apply — cat applies: validate+write+commit+push (AC-E3)
 *
 * KD-16: Independent from F231 profile-update routes (different semantics).
 * KD-17: evidenceRefs must be non-empty (fail-closed), sourceId for idempotency.
 * KD-18: v1 no auto-commit — operator approve, then cat apply + git commit later.
 *        AC-E3 adds execute-apply: cat explicitly triggers, service writes+commits.
 *
 * State machine:
 *   pending → approved → applied
 *   pending → rejected
 */

import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { CatId, DistillationEvidenceRef, DistillationSourceEvent } from '@cat-cafe/shared';
import { isDistillationSourceEvent } from '@cat-cafe/shared';
import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { DOSSIER_RELATIVE_PATH, prepareDraft } from '../domains/cats/services/distillation/DossierDraftApplier.js';
import type { IDossierDistillationProposalStore } from '../domains/cats/services/stores/ports/DossierDistillationProposalStore.js';
import { resolveOwnerGate } from '../utils/owner-gate.js';
import { resolveStrictUserId } from '../utils/request-identity.js';

const execFileAsync = promisify(execFile);

export interface DistillationRoutesOptions {
  distillationStore: IDossierDistillationProposalStore;
  /** Repo root path (for file read/write + git operations). Defaults to process.cwd(). */
  repoRoot?: string;
}

export const distillationRoutes: FastifyPluginAsync<DistillationRoutesOptions> = async (app: FastifyInstance, opts) => {
  const store = opts.distillationStore;
  const repoRoot = opts.repoRoot ?? process.cwd();

  // ─── POST /api/dossier/distillations ── create proposal ───────────
  app.post('/api/dossier/distillations', async (request, reply) => {
    const body = request.body as Record<string, unknown> | null;
    if (!body) {
      reply.status(400);
      return { error: 'Request body is required' };
    }

    // Validate required fields
    const {
      sourceEvent,
      sourceId,
      targetCatId,
      targetFields,
      beforeSnapshot,
      afterDraft,
      rationale,
      evidenceRefs,
      baseHash,
    } = body as Record<string, unknown>;

    if (!sourceEvent || !isDistillationSourceEvent(sourceEvent)) {
      reply.status(400);
      return { error: 'sourceEvent is required and must be a valid distillation source event' };
    }
    if (!sourceId || typeof sourceId !== 'string') {
      reply.status(400);
      return { error: 'sourceId is required' };
    }
    if (!targetCatId || typeof targetCatId !== 'string') {
      reply.status(400);
      return { error: 'targetCatId is required' };
    }
    if (!Array.isArray(targetFields) || targetFields.length === 0) {
      reply.status(400);
      return { error: 'targetFields is required and must be a non-empty array' };
    }
    if (typeof beforeSnapshot !== 'string') {
      reply.status(400);
      return { error: 'beforeSnapshot is required' };
    }
    if (!afterDraft || typeof afterDraft !== 'string') {
      reply.status(400);
      return { error: 'afterDraft is required' };
    }
    if (!rationale || typeof rationale !== 'string') {
      reply.status(400);
      return { error: 'rationale is required' };
    }
    if (!baseHash || typeof baseHash !== 'string') {
      reply.status(400);
      return { error: 'baseHash is required' };
    }

    // KD-17 fail-closed: evidenceRefs must be non-empty, each ref structurally valid
    if (!Array.isArray(evidenceRefs) || evidenceRefs.length === 0) {
      reply.status(400);
      return { error: 'evidenceRefs must be a non-empty array (KD-17 fail-closed)' };
    }
    const VALID_REF_TYPES = new Set(['observation', 'review', 'trajectory', 'cvo-comment']);
    for (const ref of evidenceRefs as Array<Record<string, unknown>>) {
      if (!ref || typeof ref.type !== 'string' || !VALID_REF_TYPES.has(ref.type)) {
        reply.status(400);
        return { error: 'Each evidenceRef must have a valid type (observation|review|trajectory|cvo-comment)' };
      }
      if (typeof ref.id !== 'string' || ref.id.length === 0) {
        reply.status(400);
        return { error: 'Each evidenceRef must have a non-empty id' };
      }
    }

    // Auth gate BEFORE idempotency — unauthenticated callers must not
    // reach the idempotent-read path (cloud review P1, defense-in-depth).
    const createdBy = resolveStrictUserId(request);
    if (!createdBy) {
      reply.status(401);
      return { error: 'Authentication required to create distillation proposals' };
    }

    // Idempotency: check if sourceId already exists
    const existing = await store.getBySourceId(sourceId as string);
    if (existing) {
      reply.status(200); // 200 not 201 — idempotent hit
      return { proposal: existing };
    }

    const proposal = await store.create({
      sourceEvent: sourceEvent as DistillationSourceEvent,
      sourceId: sourceId as string,
      targetCatId: targetCatId as CatId,
      targetFields: targetFields as string[],
      beforeSnapshot: beforeSnapshot as string,
      afterDraft: afterDraft as string,
      rationale: rationale as string,
      evidenceRefs: evidenceRefs as DistillationEvidenceRef[],
      baseHash: baseHash as string,
      createdBy,
    });

    reply.status(201);
    return { proposal };
  });

  // ─── GET /api/dossier/distillations ── list proposals ─────────────
  app.get('/api/dossier/distillations', async (request) => {
    const query = request.query as { catId?: string; status?: string; limit?: string };
    const limit = query.limit ? Math.min(Math.max(1, Number.parseInt(query.limit, 10) || 100), 100) : 100;

    if (query.catId) {
      const proposals = await store.listByCat(query.catId as CatId, limit);
      return { proposals };
    }

    // Default: list pending proposals
    const proposals = await store.listPending(limit);
    return { proposals };
  });

  // ─── GET /api/dossier/distillations/:proposalId ── get one ────────
  app.get('/api/dossier/distillations/:proposalId', async (request, reply) => {
    const { proposalId } = request.params as { proposalId: string };
    const proposal = await store.get(proposalId);
    if (!proposal) {
      reply.status(404);
      return { error: 'Proposal not found' };
    }
    return { proposal };
  });

  // ─── POST /api/dossier/distillations/:id/approve ── operator approves ──
  app.post('/api/dossier/distillations/:proposalId/approve', async (request, reply) => {
    const { proposalId } = request.params as { proposalId: string };
    const approvedBy = resolveStrictUserId(request);
    if (!approvedBy) {
      reply.status(401);
      return { error: 'Authentication required to approve proposals' };
    }

    // operator gate: only the configured owner can approve proposals (KD-18, same as dossier-observations.ts)
    const ownerError = resolveOwnerGate(approvedBy, {
      errorMessage: 'Only the operator can approve distillation proposals',
    });
    if (ownerError) {
      reply.status(ownerError.status);
      return { error: ownerError.error };
    }

    // Defense-in-depth: creator cannot approve their own proposal
    const existing = await store.get(proposalId);
    if (!existing) {
      reply.status(404);
      return { error: 'Proposal not found' };
    }
    if (existing.createdBy === approvedBy) {
      reply.status(403);
      return { error: 'Cannot approve your own proposal (separation of duties)' };
    }

    const proposal = await store.markApproved(proposalId, approvedBy);
    if (!proposal) {
      reply.status(409);
      return { error: 'Proposal is not in pending status (may already be approved/rejected)' };
    }
    return { proposal };
  });

  // ─── POST /api/dossier/distillations/:id/reject ── operator rejects ────
  app.post('/api/dossier/distillations/:proposalId/reject', async (request, reply) => {
    const { proposalId } = request.params as { proposalId: string };
    const rejectedBy = resolveStrictUserId(request);
    if (!rejectedBy) {
      reply.status(401);
      return { error: 'Authentication required to reject proposals' };
    }

    // operator gate: only the configured owner can reject proposals (KD-18)
    const ownerError = resolveOwnerGate(rejectedBy, {
      errorMessage: 'Only the operator can reject distillation proposals',
    });
    if (ownerError) {
      reply.status(ownerError.status);
      return { error: ownerError.error };
    }

    // Defense-in-depth: creator cannot reject their own proposal
    const existing = await store.get(proposalId);
    if (!existing) {
      reply.status(404);
      return { error: 'Proposal not found' };
    }
    if (existing.createdBy === rejectedBy) {
      reply.status(403);
      return { error: 'Cannot reject your own proposal (separation of duties)' };
    }

    const body = (request.body as { rejectionReason?: string } | null) ?? {};

    const proposal = await store.markRejected(proposalId, rejectedBy, body.rejectionReason);
    if (!proposal) {
      reply.status(409);
      return { error: 'Proposal is not in pending status (may already be approved/rejected)' };
    }
    return { proposal };
  });

  // ─── POST /api/dossier/distillations/:id/apply ── cat applies ─────
  app.post('/api/dossier/distillations/:proposalId/apply', async (request, reply) => {
    const { proposalId } = request.params as { proposalId: string };
    const body = (request.body as { commitSha?: string } | null) ?? {};

    if (!body.commitSha || typeof body.commitSha !== 'string') {
      reply.status(400);
      return { error: 'commitSha is required' };
    }

    const appliedBy = resolveStrictUserId(request);
    if (!appliedBy) {
      reply.status(401);
      return { error: 'Authentication required to apply proposals' };
    }

    // Ownership gate: only the target cat can apply distillation to their profile
    const existing = await store.get(proposalId);
    if (!existing) {
      reply.status(404);
      return { error: 'Proposal not found' };
    }
    if (existing.targetCatId !== appliedBy) {
      reply.status(403);
      return { error: 'Only the target cat can apply distillation to their profile' };
    }

    const proposal = await store.markApplied(proposalId, appliedBy, body.commitSha);
    if (!proposal) {
      reply.status(409);
      return { error: 'Proposal is not in approved status (must be approved before apply)' };
    }
    return { proposal };
  });

  // ─── POST /api/dossier/distillations/:id/execute-apply ── AC-E3 full pipeline ──
  // Cat explicitly triggers: validate baseHash → write file → git commit+push → mark applied.
  // KD-18: "operator approve 后由持球猫 apply" — this is the cat's explicit action.
  app.post('/api/dossier/distillations/:proposalId/execute-apply', async (request, reply) => {
    const { proposalId } = request.params as { proposalId: string };

    // Auth: caller must be authenticated
    const appliedBy = resolveStrictUserId(request);
    if (!appliedBy) {
      reply.status(401);
      return { error: 'Authentication required to execute-apply proposals' };
    }

    // Fetch proposal
    const existing = await store.get(proposalId);
    if (!existing) {
      reply.status(404);
      return { error: 'Proposal not found' };
    }

    // Ownership gate: only the target cat can apply to their own profile
    if (existing.targetCatId !== appliedBy) {
      reply.status(403);
      return { error: 'Only the target cat can apply distillation to their profile' };
    }

    // Status gate (redundant with prepareDraft, but fail fast with clear HTTP error)
    if (existing.status !== 'approved') {
      reply.status(409);
      return { error: `Proposal is not in approved status (current: '${existing.status}')` };
    }

    // Read current dossier file
    const dossierPath = join(repoRoot, DOSSIER_RELATIVE_PATH);
    let currentContent: string;
    try {
      currentContent = await readFile(dossierPath, 'utf8');
    } catch (err: unknown) {
      reply.status(500);
      return { error: `Failed to read dossier file: ${(err as Error).message}` };
    }

    // Validate + compute modified content
    const outcome = prepareDraft(existing, currentContent);
    if (!outcome.ok) {
      const status = outcome.error.code === 'BASE_HASH_MISMATCH' ? 409 : 422;
      reply.status(status);
      return { error: outcome.error.message, code: outcome.error.code };
    }

    // Write modified file (keep original for rollback on git failure)
    try {
      await writeFile(dossierPath, outcome.result.modifiedContent, 'utf8');
    } catch (err: unknown) {
      reply.status(500);
      return { error: `Failed to write dossier file: ${(err as Error).message}` };
    }

    // Git commit + push (two-phase: rollback on commit failure, partial success on push failure)
    let commitSha: string;
    const gitOpts = { cwd: repoRoot };

    // Phase 1: git add + commit — if this fails, rollback file so retry won't hit BASE_HASH_MISMATCH
    try {
      await execFileAsync('git', ['add', DOSSIER_RELATIVE_PATH], gitOpts);
      await execFileAsync('git', ['commit', '-m', outcome.result.commitMessage], gitOpts);
      const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], gitOpts);
      commitSha = stdout.trim();
    } catch (err: unknown) {
      // Rollback: restore original file content + unstage from index.
      // IMPORTANT: use `git reset HEAD --` (not `git checkout --`) because if `git add`
      // succeeded before `git commit` failed, the index holds the modified content and
      // `git checkout --` would overwrite our restored file from the dirty index.
      try {
        await writeFile(dossierPath, currentContent, 'utf8');
        await execFileAsync('git', ['reset', 'HEAD', '--', DOSSIER_RELATIVE_PATH], gitOpts).catch(() => {});
      } catch {
        /* best-effort rollback */
      }
      reply.status(500);
      return {
        error: `Git commit failed, file rolled back: ${(err as Error).message}`,
        code: 'GIT_FAILURE',
        fileWritten: false,
        targetPath: outcome.result.targetPath,
      };
    }

    // Phase 2: push — commit already landed, so mark applied even if push fails
    try {
      await execFileAsync('git', ['push', 'origin', 'HEAD'], gitOpts);
    } catch (err: unknown) {
      // Commit landed but push failed — mark applied with commitSha (caller can retry push)
      const applied = await store.markApplied(proposalId, appliedBy, commitSha);
      reply.status(500);
      return {
        error: `Commit succeeded but push failed: ${(err as Error).message}`,
        code: 'PUSH_FAILURE',
        fileWritten: true,
        committed: true,
        commitSha,
        proposal: applied ?? { ...existing, status: 'applied', appliedBy, appliedCommitSha: commitSha },
        targetPath: outcome.result.targetPath,
      };
    }

    // Mark as applied in store
    const applied = await store.markApplied(proposalId, appliedBy, commitSha);
    if (!applied) {
      // Edge case: status changed between our check and markApplied (race).
      // File is committed — report success with a warning.
      return {
        proposal: { ...existing, status: 'applied', appliedBy, appliedCommitSha: commitSha },
        warning: 'Store transition raced — commit was pushed but store status may be stale',
        commitSha,
      };
    }

    return { proposal: applied, commitSha };
  });
};
