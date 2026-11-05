/**
 * #1838: turn "this Windows API job is gone" into exact provider teardown proof for the executions
 * it owned, so the existing TurnExecution owner can settle them.
 *
 * Two steps, around the existing startup reconciler:
 *   1. `recordVerifiedWindowsJobTeardowns` (before it): for a job that verifiably closed, write
 *      `recordProviderTeardown` on each linked execution whose ledger identity matches the link.
 *      That is the only write here. The reconciler then interrupts those executions through the
 *      normal path, which also settles callback auth, the response and the parent invocation.
 *   2. `clearSettledWindowsJobEvidence` (after it): remove a link once its execution is no longer
 *      running, and the job record once nothing it covered still runs. Until then the evidence is
 *      kept, so an interrupted pass is retried from the same proof.
 *
 * Present, other-session and unknown jobs release nothing; their executions stay protected and are
 * reported by exact invocation id.
 */

import type { CliExecutionOwnerRef } from '../../../../../utils/cli-process-ownership.js';
import {
  clearWindowsJobExecutionLink,
  readWindowsJobExecutionLinks,
  type WindowsJobExecutionLinkEntry,
} from '../../../../../utils/windows-job-execution-links.js';
import {
  clearWindowsJobOwner,
  queryWindowsJobStopEvidence,
  readWindowsJobOwnerRecords,
  type WindowsJobOwnerEntry,
  type WindowsJobQueryExecute,
  type WindowsJobStopVerdict,
} from '../../../../../utils/windows-job-owner.js';
import {
  hasUnconfirmedProviderTeardown,
  type ITurnExecutionStore,
  type TurnExecutionRecord,
} from '../../stores/ports/TurnExecutionStore.js';

export interface WindowsJobStopResolution {
  /** Jobs that verifiably closed, with every execution linked to them. */
  verifiedStopped: Array<{
    job: WindowsJobOwnerEntry;
    verifiedAt: number;
    links: WindowsJobExecutionLinkEntry[];
    /** Links that could not be read; the job's evidence is kept while any exist. */
    invalidLinkPaths: string[];
  }>;
  /** Jobs still present, in another session, or unknown. Nothing they own may be released. */
  unresolved: Array<{ jobName: string; verdict: WindowsJobStopVerdict; reason: string; invocationIds: string[] }>;
}

/** Resolve every durable job record except this process's own into a stop verdict. */
export async function resolveWindowsJobStopEvidence(
  options: { dataDir?: string; currentJobName?: string; execute?: WindowsJobQueryExecute } = {},
): Promise<WindowsJobStopResolution> {
  const { records, invalidPaths } = readWindowsJobOwnerRecords(options.dataDir);
  const resolution: WindowsJobStopResolution = { verifiedStopped: [], unresolved: [] };
  for (const job of records.filter((record) => record.jobName !== options.currentJobName)) {
    const evidence = await queryWindowsJobStopEvidence(job, options);
    const verifiedAt = Date.now();
    const { links, invalidPaths: invalidLinkPaths } = readWindowsJobExecutionLinks(job.jobName, options.dataDir);
    if (evidence.verdict === 'absent') resolution.verifiedStopped.push({ job, verifiedAt, links, invalidLinkPaths });
    else
      resolution.unresolved.push({
        jobName: job.jobName,
        verdict: evidence.verdict,
        reason: evidence.reason,
        invocationIds: links.map((link) => link.execution.invocationId),
      });
  }
  for (const path of invalidPaths) {
    resolution.unresolved.push({
      jobName: '',
      verdict: 'unknown',
      reason: `owner_record_unreadable:${path}`,
      invocationIds: [],
    });
  }
  return resolution;
}

function matchesLinkedExecution(record: TurnExecutionRecord, execution: CliExecutionOwnerRef): boolean {
  return (
    record.invocationId === execution.invocationId &&
    record.parentInvocationId === execution.executionId &&
    record.threadId === execution.threadId &&
    record.catId === execution.catId &&
    record.userId === execution.userId
  );
}

export interface WindowsJobTeardownPass {
  resolution: WindowsJobStopResolution;
  /** Executions whose teardown was recorded in this pass. */
  released: string[];
  /** Executions or links that keep their protection, with the exact reason. */
  preserved: Array<{ invocationId: string; reason: string }>;
}

export async function recordVerifiedWindowsJobTeardowns(options: {
  store: Pick<ITurnExecutionStore, 'get' | 'recordProviderTeardown'>;
  dataDir?: string;
  currentJobName?: string;
  execute?: WindowsJobQueryExecute;
}): Promise<WindowsJobTeardownPass> {
  const resolution = await resolveWindowsJobStopEvidence(options);
  const pass: WindowsJobTeardownPass = {
    resolution,
    released: [],
    preserved: [
      ...resolution.unresolved.flatMap((job) =>
        job.invocationIds.map((invocationId) => ({ invocationId, reason: `job_${job.verdict}:${job.reason}` })),
      ),
      ...resolution.verifiedStopped.flatMap((job) =>
        job.invalidLinkPaths.map((path) => ({ invocationId: `unknown:${path}`, reason: 'link_unreadable' })),
      ),
    ],
  };
  const candidates = resolution.verifiedStopped.flatMap((job) =>
    job.links.map(({ execution }) => ({ execution, verifiedAt: job.verifiedAt })),
  );
  for (const { execution, verifiedAt } of candidates) {
    // One unreachable record must not stop the others or fail the whole startup recovery.
    try {
      const record = await options.store.get(execution.invocationId);
      if (!record || record.status !== 'running') continue;
      if (!matchesLinkedExecution(record, execution)) {
        pass.preserved.push({ invocationId: execution.invocationId, reason: 'link_identity_mismatch' });
        continue;
      }
      // Started-but-unconfirmed is the only state that needs the proof; the rest settle normally.
      if (!hasUnconfirmedProviderTeardown(record)) continue;
      await options.store.recordProviderTeardown(execution.invocationId, verifiedAt);
      pass.released.push(execution.invocationId);
    } catch (error) {
      pass.preserved.push({ invocationId: execution.invocationId, reason: `teardown_write_failed:${String(error)}` });
    }
  }
  return pass;
}

/**
 * A user's Stop on one running execution whose provider started and whose stop is unconfirmed,
 * after its API died. Only a verifiably closed job that is linked to exactly this execution proves
 * its provider gone; then the execution is canceled with that proof and its link removed. A job
 * that is present, in another session or unknown, a missing link or a mismatched one stops nothing:
 * the execution keeps its occupancy and the caller reports the exact reason. Nothing is killed here.
 */
export async function stopWithWindowsJobProof(options: {
  store: Pick<ITurnExecutionStore, 'transitionTerminal'>;
  record: TurnExecutionRecord;
  dataDir?: string;
  execute?: WindowsJobQueryExecute;
}): Promise<{ stopped: true } | { stopped: false; reason: string }> {
  const { record } = options;
  const resolution = await resolveWindowsJobStopEvidence(options);
  for (const job of resolution.verifiedStopped) {
    const link = job.links.find((entry) => entry.execution.invocationId === record.invocationId);
    if (!link) continue;
    if (!matchesLinkedExecution(record, link.execution)) return { stopped: false, reason: 'link_identity_mismatch' };
    const result = await options.store.transitionTerminal(record.invocationId, {
      status: 'canceled',
      endedAt: job.verifiedAt,
      terminalReason: 'user_cancel',
      providerTeardownAt: job.verifiedAt,
    });
    if (!result.record || result.record.status === 'running')
      return { stopped: false, reason: 'terminal_not_committed' };
    clearWindowsJobExecutionLink(link.path);
    return { stopped: true };
  }
  const owner = resolution.unresolved.find((job) => job.invocationIds.includes(record.invocationId));
  return { stopped: false, reason: owner ? `job_${owner.verdict}:${owner.reason}` : 'no_windows_job_link' };
}

export async function clearSettledWindowsJobEvidence(options: {
  store: Pick<ITurnExecutionStore, 'get'>;
  pass: WindowsJobTeardownPass;
}): Promise<{ clearedLinks: number; clearedJobs: number }> {
  let clearedLinks = 0;
  let clearedJobs = 0;
  for (const { job, links, invalidLinkPaths } of options.pass.resolution.verifiedStopped) {
    let retained = invalidLinkPaths.length;
    for (const link of links) {
      const record = await options.store.get(link.execution.invocationId);
      if (record?.status === 'running') {
        retained += 1;
        continue;
      }
      clearWindowsJobExecutionLink(link.path);
      clearedLinks += 1;
    }
    if (retained > 0) continue;
    clearWindowsJobOwner(job.path);
    clearedJobs += 1;
  }
  return { clearedLinks, clearedJobs };
}
