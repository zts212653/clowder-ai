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
 * Idempotent — safe to call on every request.
 */
export async function ensureEvalDomainThreads(
  threadStore: IThreadStore,
  domains: EvalDomainThreadSpec[],
): Promise<EnsureResult[]> {
  const results: EnsureResult[] = [];

  for (const domain of domains) {
    const existing = await threadStore.get(domain.systemThreadId);

    if (!existing) {
      // Thread doesn't exist — create it
      await threadStore.ensureThread(domain.systemThreadId, domain.displayName);
      results.push({ threadId: domain.systemThreadId, domainId: domain.domainId, created: true });
      continue;
    }

    // Thread exists — check if it needs healing
    const needsTitleRepair = !existing.title || existing.title.trim() === '';
    const needsRestore = existing.deletedAt != null;

    if (needsTitleRepair || needsRestore) {
      // Heal: repair empty title to registry displayName
      if (needsTitleRepair) {
        await threadStore.updateTitle(domain.systemThreadId, domain.displayName);
      }
      // Heal: restore soft-deleted thread
      if (needsRestore) {
        await threadStore.restore(domain.systemThreadId);
      }
      results.push({
        threadId: domain.systemThreadId,
        domainId: domain.domainId,
        created: false,
        healed: true,
      });
    } else {
      // Healthy existing thread — no-op
      results.push({ threadId: domain.systemThreadId, domainId: domain.domainId, created: false });
    }
  }

  return results;
}
