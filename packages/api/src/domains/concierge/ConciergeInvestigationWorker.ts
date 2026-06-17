/**
 * ConciergeInvestigationWorker (F229 Phase B2)
 *
 * Executes bounded async investigation:
 *   1. Claim job queued → running (CAS, fail if race-lost)
 *   2. Check deadline — cancel if expired (INV I3)
 *   3. Run search_evidence via ConciergeEvidenceStore
 *   4. Build report with R-handle anchors
 *   5. Write report + transition to done
 *
 * Fire-and-forget from dispatchInvestigateTriage — errors never propagate to HTTP.
 */

import type { InvestigationAnchor, InvestigationReport } from '@cat-cafe/shared';
import { createModuleLogger } from '../../infrastructure/logger.js';
import type { IConciergeInvestigationJobStore } from './ConciergeInvestigationJobStore.js';
import { isJobExpired } from './ConciergeInvestigationJobStore.js';
import type { IConciergeTriagePlanStore } from './ConciergeTriagePlanStore.js';
import type { ConciergeEvidenceItem, ConciergeEvidenceStore } from './concierge-search-context.js';

const log = createModuleLogger('investigation-worker');

// ---------------------------------------------------------------------------
// Anchor parsing (reuses concierge-search-context parseAnchor logic)
// ---------------------------------------------------------------------------

function evidenceToAnchor(item: ConciergeEvidenceItem, index: number): InvestigationAnchor {
  const handle = `R${index + 1}`;
  const base = { handle, title: item.title, relevance: item.summary ?? '' };

  // Thread items: drillDown.params.threadId > anchor prefix "thread-"
  if (item.drillDown?.params?.threadId) {
    return {
      ...base,
      kind: 'thread',
      threadId: item.drillDown.params.threadId,
      ...(item.drillDown.params.messageId ? { messageId: item.drillDown.params.messageId } : {}),
    };
  }

  // Non-thread evidence kinds → path-based anchor (AC-B2: 路径/URL/编号)
  if (item.kind === 'doc' || item.kind === 'feature' || item.kind === 'github') {
    return { ...base, kind: item.kind, path: item.anchor };
  }

  // Thread anchor from prefix
  if (item.anchor.startsWith('thread-')) {
    return { ...base, kind: 'thread', threadId: item.anchor.slice('thread-'.length) };
  }

  // Fallback: unknown kind with path
  return { ...base, kind: 'unknown', path: item.anchor };
}

// ---------------------------------------------------------------------------
// Parent plan propagation
// ---------------------------------------------------------------------------

async function propagatePlanStatus(
  triagePlanStore: IConciergeTriagePlanStore | undefined,
  triagePlanId: string,
  status: 'completed' | 'failed' | 'cancelled',
): Promise<void> {
  if (!triagePlanStore) return;
  try {
    await triagePlanStore.updateStatus(triagePlanId, status);
  } catch (err) {
    // Best-effort: plan propagation failure must not mask job outcome
    log.warn({ err, triagePlanId, status }, 'Failed to propagate status to parent TriagePlan');
  }
}

// ---------------------------------------------------------------------------
// Worker execution
// ---------------------------------------------------------------------------

export interface ExecuteInvestigationOptions {
  jobId: string;
  jobStore: IConciergeInvestigationJobStore;
  evidenceStore?: ConciergeEvidenceStore;
  /** Optional: propagate job terminal state to parent TriagePlan */
  triagePlanStore?: IConciergeTriagePlanStore;
}

/**
 * Execute a single investigation job. Designed to be called fire-and-forget.
 * Never throws — all errors are caught and result in job → failed transition.
 */
export async function executeInvestigation(opts: ExecuteInvestigationOptions): Promise<void> {
  const { jobId, jobStore, evidenceStore, triagePlanStore } = opts;

  // 1. Fetch job
  const job = await jobStore.get(jobId);
  if (!job) {
    log.warn({ jobId }, 'InvestigationJob not found, skipping');
    return;
  }

  // 2. Check deadline before even trying to claim
  if (isJobExpired(job)) {
    const expired = await jobStore.claimTransition(jobId, job.status, 'cancelled');
    if (expired) await propagatePlanStatus(triagePlanStore, job.triagePlanId, 'cancelled');
    log.info({ jobId }, 'InvestigationJob expired before execution, cancelled');
    return;
  }

  // 3. Claim queued → running (CAS — if another worker or cancel won, we bail)
  const claimed = await jobStore.claimTransition(jobId, 'queued', 'running');
  if (!claimed) {
    log.info({ jobId, status: job.status }, 'InvestigationJob claim failed (already running/cancelled)');
    return;
  }

  try {
    // 4. Execute search
    let items: ConciergeEvidenceItem[] = [];
    if (evidenceStore) {
      items = await evidenceStore.search(job.query, {
        limit: 10,
        scope: 'all',
        mode: 'hybrid',
        depth: 'raw',
      });
    }

    // 4b. Post-search deadline recheck (INV I3 fail-closed — cloud P1)
    // If the search took longer than the deadline, cancel instead of writing results.
    if (isJobExpired(job)) {
      const expired = await jobStore.claimTransition(jobId, 'running', 'cancelled');
      if (expired) await propagatePlanStatus(triagePlanStore, job.triagePlanId, 'cancelled');
      log.info({ jobId }, 'InvestigationJob expired after search completed, cancelled');
      return;
    }

    // 5. Build report
    const report = buildReport(job.query, items);

    // 6. Atomic CAS + report write (INV I2: done ⇒ report).
    // claimDoneWithReport atomically checks status='running', then sets
    // status='done' AND report in a single write (Lua script in Redis,
    // synchronous in Memory). This prevents both:
    //   - cancel-overwrite race (cloud P1 R2: setReport non-atomic GET→SET)
    //   - done-without-report (gpt52 P1: CAS-before-report + setReport throw)
    const transitioned = await jobStore.claimDoneWithReport(jobId, report);
    if (transitioned) {
      await propagatePlanStatus(triagePlanStore, job.triagePlanId, 'completed');
      log.info({ jobId, anchorCount: report.anchors.length }, 'InvestigationJob completed');
    } else {
      log.warn({ jobId }, 'InvestigationJob was cancelled during execution, report discarded');
    }
  } catch (err) {
    log.error({ err, jobId }, 'InvestigationJob execution failed');
    // CAS: only transition if still running — cancelled takes precedence
    const failedOk = await jobStore.claimTransition(jobId, 'running', 'failed');
    if (failedOk) await propagatePlanStatus(triagePlanStore, job.triagePlanId, 'failed');
  }
}

function buildReport(query: string, items: ConciergeEvidenceItem[]): InvestigationReport {
  if (items.length === 0) {
    return {
      summary: `关于「${query}」没有找到相关记录。`,
      anchors: [],
    };
  }

  const anchors = items.map((item, i) => evidenceToAnchor(item, i));
  const summaryParts = anchors.map((a) => {
    switch (a.kind) {
      case 'thread':
        return `[跳过去 ${a.handle}] ${a.title}`;
      case 'doc':
        return `[查看 ${a.handle}] ${a.path ?? a.title}`;
      case 'feature':
        return `[${a.handle}] ${a.title}`;
      case 'github':
        return `[链接 ${a.handle}] ${a.title}`;
      default:
        return `[${a.handle}] ${a.title}`;
    }
  });
  const summary = `关于「${query}」找到 ${anchors.length} 条相关记录：\n${summaryParts.join('\n')}`;

  return { summary, anchors };
}
