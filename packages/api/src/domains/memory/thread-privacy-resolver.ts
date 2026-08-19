/**
 * F260 PR-5: Thread privacy resolver — determines if a thread is
 * workspace-scope (non-private) or private.
 *
 * F282 reuses this resolver before phrase extraction so private content never
 * enters the lane-neutral occurrence map.
 *
 * Privacy semantics:
 * - **workspace** (returns false): normal owner workspace threads.
 * - **private** (returns true): system / gate-keeping / explicitly-private
 *   threads — proactive detection suppressed per KD-7 "宁哑不漏".
 *
 * Fail-closed: unknown thread → private.
 *
 * [宪宪/Claude Opus 4.6🐾]
 */

/** Minimal thread shape — only fields the resolver reads. */
interface ThreadLike {
  systemKind?: string;
  threadKind?: string;
  deletedAt?: number | null;
  threadMetadata?: { v: number; notes?: Record<string, string> };
}

/** Minimal store interface — sync or async get(). */
interface ThreadStoreLike {
  get(threadId: string): ThreadLike | null | Promise<ThreadLike | null>;
}

/**
 * Resolve whether a thread is private (true) or workspace (false).
 *
 * @returns true if the thread should be treated as private
 *          (candidate extraction suppressed), false if workspace-scope.
 */
export async function resolveThreadPrivacy(threadId: string, threadStore: ThreadStoreLike): Promise<boolean> {
  const thread = await threadStore.get(threadId);

  // Fail-closed: unknown thread → private (KD-7 宁哑不漏)
  if (!thread) return true;

  // Soft-deleted threads are not current workspace truth. Restore clears
  // deletedAt, so a later invocation can re-evaluate them without a rebuild.
  if (thread.deletedAt) return true;

  // System threads (connector_hub, eval_domain) are infrastructure,
  // not workspace conversation — no proactive candidates.
  if (thread.systemKind) return true;

  // Gate-keeping threads are ops/intake, not workspace.
  if (thread.threadKind === 'gate-keeping') return true;

  // Explicit privacy metadata via threadMetadata.notes
  if (thread.threadMetadata?.notes?.privacy === 'private') return true;

  // Default: workspace (non-private) — most threads land here.
  return false;
}
