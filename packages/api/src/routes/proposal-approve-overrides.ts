/**
 * F128 approve-time override resolution.
 *
 * The approve route lets the user edit a few proposal fields before the thread is created.
 * Two of those edits need a side-effecting check that can fail the request: parentThreadId
 * ownership (403) and projectPath validity (400). Both checks MUST run BEFORE the proposal is
 * claimed, so a rejected override never leaves the proposal stuck in `approving`. Extracted
 * here to keep proposal-routes.ts within the F128 AC-X1 350-line cap and the approve handler's
 * cognitive complexity in check.
 */

import type { CatId, ProposalApproveOverrides, ReportingMode, ThreadProposal } from '@cat-cafe/shared';
import type { IThreadStore } from '../domains/cats/services/stores/ports/ThreadStore.js';
import { validateProjectPath } from '../utils/project-path.js';

/** Parsed approve-body overrides (preferredCats arrives as plain strings from zod). */
export interface ApproveOverridesInput {
  title?: string | undefined;
  parentThreadId?: string | undefined;
  preferredCats?: string[] | undefined;
  initialMessage?: string | null | undefined;
  projectPath?: string | undefined;
  reportingMode?: ReportingMode | undefined;
}

export interface ResolvedApproveOverrides {
  finalTitle: string;
  finalParentThreadId: string;
  finalPreferredCats: CatId[];
  finalInitialMessage: string | undefined;
  finalProjectPath: string;
  finalReportingMode: ReportingMode;
  /** The audit overrides to hand finalizeApproval so the proposal record matches the thread. */
  finalizeOverrides: ProposalApproveOverrides;
}

export type ApproveOverridesResolution =
  | { ok: true; resolved: ResolvedApproveOverrides }
  | { ok: false; status: number; error: string };

/**
 * Resolve + validate the approve-time overrides against the proposal's prefilled values.
 * Returns a discriminated result so the caller emits the right HTTP status without this
 * helper needing the Fastify reply.
 */
export async function resolveApproveOverrides(
  proposal: ThreadProposal,
  overrides: ApproveOverridesInput,
  userId: string,
  threadStore: Pick<IThreadStore, 'get'>,
): Promise<ApproveOverridesResolution> {
  const finalTitle = overrides.title ?? proposal.title;

  let finalParentThreadId = overrides.parentThreadId ?? proposal.parentThreadId;
  // Track the re-parent target thread: projectPath defaults to inherit the EFFECTIVE parent
  // (spec: "projectPath 默认继承 parent thread"), so a re-parent without an explicit projectPath
  // must re-home to the new parent's ownership, not keep the old one.
  let reparentedThread: { projectPath: string } | null = null;
  if (overrides.parentThreadId && overrides.parentThreadId !== proposal.parentThreadId) {
    const parent = await threadStore.get(overrides.parentThreadId);
    if (!parent || parent.createdBy !== userId) {
      return { ok: false, status: 403, error: 'parentThreadId does not belong to the current user' };
    }
    finalParentThreadId = overrides.parentThreadId;
    reparentedThread = parent;
  }

  const finalPreferredCats = (overrides.preferredCats ?? proposal.preferredCats) as CatId[];
  const finalInitialMessage = resolveInitialMessage(proposal.initialMessage, overrides.initialMessage);
  const finalReportingMode = overrides.reportingMode ?? proposal.reportingMode ?? 'final-only';

  // F128 projectPath priority: explicit override (validated, fail-loud 400) > re-parent
  // inheritance (new parent's ownership) > the proposal's projectPath (set at propose time).
  // Validation runs BEFORE the claim so a bad path never leaves the proposal stuck in
  // `approving`, and a cat/user who thinks they pinned a repo never silently lands in `default`.
  let finalProjectPath = proposal.projectPath;
  if (overrides.projectPath !== undefined) {
    const validatedProjectPath = await validateProjectPath(overrides.projectPath);
    if (!validatedProjectPath) {
      return {
        ok: false,
        status: 400,
        error: 'Invalid projectPath: must be an existing directory under allowed roots',
      };
    }
    finalProjectPath = validatedProjectPath;
  } else if (reparentedThread) {
    finalProjectPath = reparentedThread.projectPath;
  }

  return {
    ok: true,
    resolved: {
      finalTitle,
      finalParentThreadId,
      finalPreferredCats,
      finalInitialMessage,
      finalProjectPath,
      finalReportingMode,
      finalizeOverrides: {
        title: finalTitle,
        parentThreadId: finalParentThreadId,
        preferredCats: finalPreferredCats,
        initialMessage: finalInitialMessage === undefined ? null : finalInitialMessage,
        // Sync the proposal audit record to the final ownership so the persisted proposal
        // doesn't keep a stale projectPath after an approve-time re-home.
        projectPath: finalProjectPath,
        reportingMode: finalReportingMode,
      },
    },
  };
}

function resolveInitialMessage(
  fromProposal: string | undefined,
  override: string | null | undefined,
): string | undefined {
  if (override === undefined) return fromProposal;
  if (override === null) return undefined;
  return override;
}
