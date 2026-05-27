import type { IThreadStore } from '../../domains/cats/services/stores/ports/ThreadStore.js';

export interface EvalDomainThreadSpec {
  domainId: string;
  systemThreadId: string;
  displayName: string;
}

export interface EnsureResult {
  threadId: string;
  domainId: string;
  created: boolean;
  /** True when an existing thread was repaired (empty title or soft-deleted state). */
  healed?: boolean;
}

/**
 * Ensure system threads for all eval domains exist and are healthy.
 * - Creates missing threads with domain displayName as title.
 * - Heals existing threads that have null/empty titles (placeholder state).
 * - Restores soft-deleted system threads.
 * - Preserves custom non-empty titles set by users.
 * - When defaultUserId is provided, indexes threads into the user's sidebar list
 *   (cloud review P1: ensureThread creates with createdBy='system' which skips user-list indexing).
 * Idempotent — safe to call on every request.
 */
export async function ensureEvalDomainThreads(
  threadStore: IThreadStore,
  domains: EvalDomainThreadSpec[],
  defaultUserId?: string,
): Promise<EnsureResult[]> {
  const results: EnsureResult[] = [];

  for (const domain of domains) {
    const existing = await threadStore.get(domain.systemThreadId);

    if (!existing) {
      // Thread doesn't exist — create it with systemKind for sidebar visibility
      await threadStore.ensureThread(domain.systemThreadId, domain.displayName);
      await threadStore.updateSystemKind(domain.systemThreadId, 'eval_domain');
      // Cloud P1: index into default user's thread list for sidebar visibility
      if (defaultUserId) {
        await threadStore.indexForUser(domain.systemThreadId, defaultUserId);
      }
      results.push({ threadId: domain.systemThreadId, domainId: domain.domainId, created: true });
      continue;
    }

    // Thread exists — check if it needs healing
    const needsTitleRepair = !existing.title || existing.title.trim() === '';
    const needsRestore = existing.deletedAt != null;
    const needsSystemKind = existing.systemKind !== 'eval_domain';

    if (needsTitleRepair || needsRestore || needsSystemKind) {
      // Heal: repair empty title to registry displayName
      if (needsTitleRepair) {
        await threadStore.updateTitle(domain.systemThreadId, domain.displayName);
      }
      // Heal: restore soft-deleted thread
      if (needsRestore) {
        await threadStore.restore(domain.systemThreadId);
      }
      // Heal: set systemKind for sidebar "系统" section visibility (F192 OQ-19)
      if (needsSystemKind) {
        await threadStore.updateSystemKind(domain.systemThreadId, 'eval_domain');
      }
      // Cloud P1: ensure healed threads are indexed for user sidebar
      if (defaultUserId) {
        await threadStore.indexForUser(domain.systemThreadId, defaultUserId);
      }
      results.push({
        threadId: domain.systemThreadId,
        domainId: domain.domainId,
        created: false,
        healed: true,
      });
    } else {
      // Healthy existing thread — already indexed (or was indexed on creation)
      // Re-index idempotently to cover threads created before this fix
      if (defaultUserId) {
        await threadStore.indexForUser(domain.systemThreadId, defaultUserId);
      }
      results.push({ threadId: domain.systemThreadId, domainId: domain.domainId, created: false });
    }
  }

  return results;
}
