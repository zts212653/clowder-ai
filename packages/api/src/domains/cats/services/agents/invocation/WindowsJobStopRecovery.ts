/**
 * #1838: turn verified absence of every linked Windows job and launch controller into exact
 * provider teardown proof, so the existing TurnExecution owner can settle the execution.
 *
 * Two steps, around the existing startup reconciler:
 *   1. `recordVerifiedWindowsJobTeardowns` (before it): for a job that verifiably closed, write
 *      `recordProviderTeardown` on each linked execution whose ledger identity matches the link.
 *      A child already terminal still needs its independent physical proof. The reconciler then
 *      settles running executions through the normal callback auth, response and parent path.
 *   2. `clearSettledWindowsJobEvidence` (after it): remove an exact link only after its execution
 *      ended and any started provider's teardown is durable. Keep the job record while any covered
 *      link needs it, so an interrupted pass retries the same proof.
 *
 * Present, other-session and unknown jobs release nothing; their executions stay protected and are
 * reported by exact invocation id.
 */

import type { CliExecutionOwnerRef } from '../../../../../utils/cli-process-ownership.js';
import {
  clearWindowsJobExecutionLink,
  readWindowsJobExecutionLinks,
  readWindowsJobNamesLinkedTo,
  type WindowsJobExecutionLinkEntry,
} from '../../../../../utils/windows-job-execution-links.js';
import {
  clearWindowsJobOwner,
  queryWindowsControllers,
  queryWindowsJobStopEvidence,
  readWindowsJobOwnerRecords,
  type WindowsControllerVerdict,
  type WindowsJobOwnerEntry,
  type WindowsJobQueryExecute,
  type WindowsJobStopVerdict,
  windowsControllerKey,
} from '../../../../../utils/windows-job-owner.js';
import type { ITurnExecutionStore, TurnExecutionRecord } from '../../stores/ports/TurnExecutionStore.js';

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
  unresolved: Array<{
    jobName: string;
    verdict: WindowsJobStopVerdict;
    reason: string;
    invocationIds: string[];
    /** Readable links of a job that could be queried; none for an unreadable owner record. */
    links?: WindowsJobExecutionLinkEntry[];
  }>;
  /** The controlling API of each closed provider-host job, keyed by exact pid and birth. */
  controllers: Map<string, WindowsControllerVerdict>;
}

/** Resolve every durable job record except this process's own into a stop verdict. */
export async function resolveWindowsJobStopEvidence(
  options: { dataDir?: string; currentJobName?: string; execute?: WindowsJobQueryExecute } = {},
): Promise<WindowsJobStopResolution> {
  const { records, invalidPaths } = readWindowsJobOwnerRecords(options.dataDir);
  const resolution: WindowsJobStopResolution = { verifiedStopped: [], unresolved: [], controllers: new Map() };
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
        links,
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
  // Read after the job queries: a controller seen gone from here on can no longer add a host, so the
  // link set each release reads afterwards is final for that controller.
  const controllers = resolution.verifiedStopped.flatMap(({ job }) =>
    job.controller ? [{ ...job.controller, sessionId: job.sessionId }] : [],
  );
  resolution.controllers = await queryWindowsControllers(controllers, options);
  return resolution;
}

/**
 * A closed job proves its host's tree gone, but not that its controlling API cannot start another
 * host for the same execution. An API-member job (no controller) closed only when that API died.
 */
function controllerGone(resolution: WindowsJobStopResolution, job: WindowsJobOwnerEntry): boolean {
  return !job.controller || resolution.controllers.get(windowsControllerKey(job.controller)) === 'gone';
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
  /**
   * Running executions with positive proof that an owner can still write them: exactly linked to a
   * job still present, or to a closed job whose exact controller API is alive and could start
   * another host. Only these join the live-owner exclusion; an unknown is not a live owner.
   */
  liveOwners: string[];
  /** False when a candidate's canonical record could not be read: no child may be interrupted then. */
  liveOwnersComplete: boolean;
}

// Physical teardown remains independent of the Host terminal and of older tracking flags.
function needsProviderStopProof(record: TurnExecutionRecord): boolean {
  return record.providerStartedAt !== undefined && record.providerTeardownAt === undefined;
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
    liveOwners: [],
    liveOwnersComplete: true,
    preserved: [
      ...resolution.unresolved.flatMap((job) =>
        job.invocationIds.map((invocationId) => ({ invocationId, reason: `job_${job.verdict}:${job.reason}` })),
      ),
      ...resolution.verifiedStopped.flatMap((job) =>
        job.invalidLinkPaths.map((path) => ({ invocationId: `unknown:${path}`, reason: 'link_unreadable' })),
      ),
    ],
  };
  const closedJobs = new Set(resolution.verifiedStopped.map(({ job }) => job.jobName));
  // One execution can be linked to several closed jobs; it is decided once.
  const candidates = [
    ...new Map(
      resolution.verifiedStopped.flatMap((job) =>
        job.links.map(({ execution }) => [execution.invocationId, { execution, verifiedAt: job.verifiedAt }] as const),
      ),
    ).values(),
  ];
  for (const { execution, verifiedAt } of candidates) {
    // One unreachable record must not stop the others or fail the whole startup recovery.
    try {
      const record = await options.store.get(execution.invocationId);
      if (!record) continue;
      if (!matchesLinkedExecution(record, execution)) {
        pass.preserved.push({ invocationId: execution.invocationId, reason: 'link_identity_mismatch' });
        continue;
      }
      // Started-but-unconfirmed is the only state that needs the proof; the rest settle normally.
      if (!needsProviderStopProof(record)) continue;
      // One closed job says nothing about a writer in another (a retry can rebuild the provider in a
      // new host): every job this execution ran in must be among the verifiably closed ones.
      // Read only now, after the controller check: a host its API linked meanwhile is counted too.
      const linkedJobs = readWindowsJobNamesLinkedTo(execution.invocationId, options.dataDir);
      if (!linkedJobs || linkedJobs.some((jobName) => !closedJobs.has(jobName))) {
        pass.preserved.push({ invocationId: execution.invocationId, reason: 'linked_job_not_closed' });
        continue;
      }
      // Its API could still launch a new host into it: the execution keeps its protection until
      // every controlling API is verifiably gone.
      const linkedClosed = resolution.verifiedStopped.filter(({ job }) => linkedJobs.includes(job.jobName));
      if (linkedClosed.some(({ job }) => !controllerGone(resolution, job))) {
        pass.preserved.push({ invocationId: execution.invocationId, reason: 'controller_not_gone' });
        continue;
      }
      await options.store.recordProviderTeardown(execution.invocationId, verifiedAt);
      const committed = await options.store.get(execution.invocationId);
      if (!committed || !matchesLinkedExecution(committed, execution) || committed.providerTeardownAt === undefined) {
        pass.preserved.push({ invocationId: execution.invocationId, reason: 'teardown_not_committed' });
        continue;
      }
      pass.released.push(execution.invocationId);
    } catch (error) {
      pass.preserved.push({ invocationId: execution.invocationId, reason: `teardown_write_failed:${String(error)}` });
    }
  }
  for (const { execution } of liveOwnerLinks(resolution)) {
    // A link protects only the canonical execution it names exactly, never one a stray file mentions.
    try {
      const record = await options.store.get(execution.invocationId);
      if (record?.status === 'running' && matchesLinkedExecution(record, execution))
        pass.liveOwners.push(execution.invocationId);
    } catch {
      pass.liveOwnersComplete = false;
    }
  }
  return pass;
}

/**
 * The links that carry positive live-owner proof: a job still present, or a closed job whose exact
 * controller API is alive and can start another host. An unknown is never in here. Startup recovery
 * and every uncontrollable failed write read this one rule.
 */
function liveOwnerLinks(resolution: WindowsJobStopResolution): WindowsJobExecutionLinkEntry[] {
  return [
    ...resolution.unresolved.filter((job) => job.verdict === 'present').flatMap((job) => job.links ?? []),
    ...resolution.verifiedStopped
      .filter(
        ({ job }) => job.controller && resolution.controllers.get(windowsControllerKey(job.controller)) === 'alive',
      )
      .flatMap((job) => job.links),
  ];
}

/**
 * The first of these running executions that a live owner can still write, by the same rule startup
 * recovery uses; each must match its link exactly. Undefined when none has positive proof, so an
 * unknown settles through the ordinary failure path without a teardown.
 */
export async function findWindowsLiveOwner(options: {
  records: readonly TurnExecutionRecord[];
  dataDir?: string;
  execute?: WindowsJobQueryExecute;
}): Promise<{ invocationId: string } | undefined> {
  const running = options.records.filter((record) => record.status === 'running');
  if (running.length === 0) return undefined;
  const live = liveOwnerLinks(await resolveWindowsJobStopEvidence(options));
  const owner = running.find((record) =>
    live.some(
      (link) => link.execution.invocationId === record.invocationId && matchesLinkedExecution(record, link.execution),
    ),
  );
  return owner ? { invocationId: owner.invocationId } : undefined;
}

/**
 * A user's Stop on one running execution whose provider started and whose stop is unconfirmed,
 * after its API died. Only a verifiably closed job that is linked to exactly this execution proves
 * its provider gone; then the execution is canceled with that proof and its link removed. A job
 * that is present, in another session or unknown, a missing link or a mismatched one stops nothing:
 * the execution keeps its occupancy and the caller reports the exact reason. Nothing is killed here.
 */
export async function stopWithWindowsJobProof(options: {
  store: Pick<ITurnExecutionStore, 'get' | 'recordProviderTeardown' | 'transitionTerminal'>;
  record: TurnExecutionRecord;
  dataDir?: string;
  execute?: WindowsJobQueryExecute;
}): Promise<{ stopped: true; record: TurnExecutionRecord } | { stopped: false; reason: string }> {
  const { record } = options;
  const resolution = await resolveWindowsJobStopEvidence(options);
  // Every job this execution ran in must be verifiably closed: one closed job proves nothing about a
  // writer in another. A job still open names the reason the user sees.
  const owner = resolution.unresolved.find((job) => job.invocationIds.includes(record.invocationId));
  if (owner) return { stopped: false, reason: `job_${owner.verdict}:${owner.reason}` };
  const linkedJobs = readWindowsJobNamesLinkedTo(record.invocationId, options.dataDir);
  if (!linkedJobs) return { stopped: false, reason: 'links_unreadable' };
  if (linkedJobs.length === 0) return { stopped: false, reason: 'no_windows_job_link' };
  const closed = resolution.verifiedStopped.filter(({ job }) => linkedJobs.includes(job.jobName));
  if (closed.length < linkedJobs.length) return { stopped: false, reason: 'linked_job_not_closed' };
  if (closed.some(({ job }) => !controllerGone(resolution, job)))
    return { stopped: false, reason: 'controller_not_gone' };
  const links = closed.flatMap((job) =>
    job.links.filter((entry) => entry.execution.invocationId === record.invocationId),
  );
  if (links.length < linkedJobs.length) return { stopped: false, reason: 'link_unreadable' };
  if (links.some((link) => !matchesLinkedExecution(record, link.execution)))
    return { stopped: false, reason: 'link_identity_mismatch' };
  const current = await options.store.get(record.invocationId);
  if (!current || links.some((link) => !matchesLinkedExecution(current, link.execution)))
    return { stopped: false, reason: 'link_identity_mismatch' };
  const verifiedAt = Math.max(...closed.map((job) => job.verifiedAt));
  // transitionTerminal intentionally preserves an earlier ending. Commit the independent physical
  // fact first, so a concurrent terminal cannot discard it before the last durable link is removed.
  await options.store.recordProviderTeardown(record.invocationId, verifiedAt);
  const committed = await options.store.get(record.invocationId);
  if (!committed || links.some((link) => !matchesLinkedExecution(committed, link.execution)))
    return { stopped: false, reason: 'link_identity_mismatch' };
  if (committed.providerTeardownAt === undefined) return { stopped: false, reason: 'teardown_not_committed' };
  const result = await options.store.transitionTerminal(record.invocationId, {
    status: 'canceled',
    endedAt: verifiedAt,
    terminalReason: 'user_cancel',
    providerTeardownAt: verifiedAt,
  });
  if (!result.record || result.record.status === 'running') return { stopped: false, reason: 'terminal_not_committed' };
  // The caller settles the ended turn's response next; the terminal record carries what it needs.
  for (const link of links) clearWindowsJobExecutionLink(link.path);
  return { stopped: true, record: result.record };
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
      if (
        record &&
        (record.status === 'running' ||
          needsProviderStopProof(record) ||
          !matchesLinkedExecution(record, link.execution))
      ) {
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
