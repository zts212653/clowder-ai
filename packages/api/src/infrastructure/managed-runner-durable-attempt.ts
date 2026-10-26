import { randomUUID } from 'node:crypto';
import type { DurableManagedGateJob } from '../domains/ball-custody/durable-managed-gate-job.js';
import {
  DURABLE_MANAGED_GATE_RECOVERY_PROTOCOL_VERSION,
  type DurableGateFrozenIdentity,
} from '../domains/ball-custody/durable-managed-gate-recovery.js';
import {
  ALPHA_RECOVERY_JOURNAL_ENV,
  alphaRecoveryJournalPath,
  DURABLE_GATE_ATTEMPT_TOKEN_ENV,
  DURABLE_GATE_FROZEN_IDENTITY_ENV,
  DURABLE_GATE_RECONCILE_FROM_ENV,
  DURABLE_GATE_RECOVERY_READY_PATH_ENV,
  DURABLE_GATE_RESUME_EPOCH_ENV,
  durableGateRecoveryReadyPath,
} from '../domains/ball-custody/durable-managed-gate-recovery-child-contract.js';
import { readUnixProcessSnapshot, sameUnixProcess, type UnixProcessIdentity } from '../utils/cli-process-ownership.js';

export interface DurableManagedGateAttempt {
  readonly attemptToken: string;
  readonly environment: NodeJS.ProcessEnv;
}

export interface DurableManagedGateCleanupSignal {
  readonly processIdentity: UnixProcessIdentity;
  readonly signal: 'SIGTERM' | 'SIGKILL';
  readonly sentAt: number;
}

export interface DurableManagedGateCleanupReport {
  readonly proven: boolean;
  readonly signals: readonly DurableManagedGateCleanupSignal[];
}

function canonicalGateResumeIdentity(frozenIdentity: DurableGateFrozenIdentity): Record<string, unknown> {
  const suppliedVersion = (frozenIdentity as DurableGateFrozenIdentity & { protocolVersion?: unknown }).protocolVersion;
  if (suppliedVersion !== undefined && suppliedVersion !== DURABLE_MANAGED_GATE_RECOVERY_PROTOCOL_VERSION) {
    throw new Error('durable gate frozen identity protocol version is unsupported');
  }
  return { ...frozenIdentity, protocolVersion: DURABLE_MANAGED_GATE_RECOVERY_PROTOCOL_VERSION };
}

export function createDurableManagedGateAttempt(
  job: DurableManagedGateJob,
  resumeEpoch: number | null,
  frozenIdentity: DurableGateFrozenIdentity | null,
  reconcileFrom: number | null = null,
): DurableManagedGateAttempt {
  const attemptToken = randomUUID();
  return {
    attemptToken,
    environment: {
      [DURABLE_GATE_ATTEMPT_TOKEN_ENV]: attemptToken,
      [DURABLE_GATE_RECOVERY_READY_PATH_ENV]: durableGateRecoveryReadyPath(job, attemptToken),
      ...(job.kind === 'alpha_revision_v1'
        ? { [ALPHA_RECOVERY_JOURNAL_ENV]: alphaRecoveryJournalPath(job, attemptToken) }
        : {}),
      ...(resumeEpoch === null ? {} : { [DURABLE_GATE_RESUME_EPOCH_ENV]: String(resumeEpoch) }),
      ...(reconcileFrom === null ? {} : { [DURABLE_GATE_RECONCILE_FROM_ENV]: String(reconcileFrom) }),
      ...(frozenIdentity === null
        ? {}
        : { [DURABLE_GATE_FROZEN_IDENTITY_ENV]: JSON.stringify(canonicalGateResumeIdentity(frozenIdentity)) }),
    },
  };
}

function hasAttemptToken(commandAndEnvironment: string | undefined, attemptToken: string): boolean {
  const marker = `${DURABLE_GATE_ATTEMPT_TOKEN_ENV}=${attemptToken}`;
  return commandAndEnvironment?.split(/\s+/u).includes(marker) ?? false;
}

async function attemptMembers(attemptToken: string): Promise<UnixProcessIdentity[] | null> {
  const environmentMarkers = [`${DURABLE_GATE_ATTEMPT_TOKEN_ENV}=${attemptToken}`];
  const snapshot = await readUnixProcessSnapshot({ includeEnvironment: true, environmentMarkers });
  if (snapshot === null) return null;
  const candidates = [...snapshot.values()].filter(
    (entry) => entry.pid !== process.pid && hasAttemptToken(entry.commandAndEnvironment, attemptToken),
  );
  if (candidates.length === 0) return [];
  const verified = await readUnixProcessSnapshot({
    includeEnvironment: true,
    environmentMarkers,
    pids: candidates.map((entry) => entry.pid),
  });
  if (verified === null) return null;
  return candidates.filter((entry) => {
    const current = verified.get(entry.pid);
    return sameUnixProcess(entry, current) && hasAttemptToken(current?.commandAndEnvironment, attemptToken);
  });
}

function signalMembers(
  members: readonly UnixProcessIdentity[],
  signal: DurableManagedGateCleanupSignal['signal'],
): DurableManagedGateCleanupSignal[] {
  const signals: DurableManagedGateCleanupSignal[] = [];
  for (const member of members) {
    try {
      const sentAt = Date.now();
      process.kill(member.pid, signal);
      signals.push({ processIdentity: member, signal, sentAt });
    } catch {
      // A member that exited between proof and signal is rechecked below.
    }
  }
  return signals;
}

function sleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

export async function cleanupDurableManagedGateAttempt(
  attemptToken: string,
  budgetMs: number,
  pollMs: number,
): Promise<DurableManagedGateCleanupReport> {
  const startedAt = Date.now();
  let forced = false;
  const signals: DurableManagedGateCleanupSignal[] = [];
  while (Date.now() - startedAt <= budgetMs) {
    const members = await attemptMembers(attemptToken);
    if (members === null) return { proven: false, signals };
    if (members.length === 0) return { proven: true, signals };
    const shouldForce = Date.now() - startedAt >= Math.max(pollMs, Math.floor(budgetMs / 2));
    if (shouldForce && !forced) forced = true;
    signals.push(...signalMembers(members, forced ? 'SIGKILL' : 'SIGTERM'));
    await sleep(pollMs);
  }
  return { proven: (await attemptMembers(attemptToken))?.length === 0, signals };
}
