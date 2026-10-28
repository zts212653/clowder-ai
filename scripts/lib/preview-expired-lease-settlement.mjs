import { rmSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { assertNamedAlphaNotServing } from './alpha-coordinates.mjs';
import { acquireNamedAlphaLifecycle } from './alpha-lifecycle-lock.mjs';
import { assertNamedAlphaRedisHistoricalProof } from './alpha-redis-process.mjs';
import { assertNoOtherAlphaGeneration } from './preview-alpha-occupancy.mjs';
import {
  readAlphaCompletionEvidence,
  readHistoricalAlphaLeaseEvidence,
  recoveryPathExists,
  recoverySnapshot,
  sameRecoveryFile,
  syncRecoveryDirectory,
} from './preview-alpha-recovery-evidence.mjs';
import { priorRecovery, recoveryJournalRoot } from './preview-alpha-recovery-journal.mjs';
import {
  assertRecoveryLaunchd,
  assertRecoveryQuiescence,
  recoveryGroupRunning,
  recoveryListeners,
} from './preview-alpha-recovery-observation.mjs';
import {
  portLeases,
  preserveRegistrationJournal,
  publishRegistrationResult,
} from './preview-alpha-registration-settlement.mjs';
import { readBoundPreviewCommand } from './preview-command-identity.mjs';
import { EXPIRED_LEASE_SETTLEMENT, publishedExpiredLease } from './preview-expired-lease-journal.mjs';
import { readForensicRecoveryHistory } from './preview-forensic-recovery-history.mjs';
import { snapshotRedisRetirementData } from './preview-redis-retirement-data.mjs';
import { isProcessRunning } from './process-tree.mjs';

function assertExpiredAlphaIdle(config, record, evidence, deps, leaseRemoved, command) {
  const { coordinates, proof, owner } = evidence;
  assertNamedAlphaRedisHistoricalProof(JSON.stringify(coordinates), proof);
  assertRecoveryQuiescence(record, owner, coordinates, deps);
  assertRecoveryLaunchd(config, record, deps.readJob);
  if (
    (deps.isRunning ?? isProcessRunning)(proof.pid) !== false ||
    (deps.readListeners ?? recoveryListeners)(proof.port).length
  )
    throw new Error('expired Redis PID or port is live or unproven');
  if (
    command?.value.identityStatus === 'observed' &&
    ((deps.isRunning ?? isProcessRunning)(command.value.pid) !== false ||
      (deps.groupRunning ?? recoveryGroupRunning)(command.value.processGroupId) !== false)
  )
    throw new Error('recorded command group is live or unproven');
  const names = portLeases(coordinates, deps).sort();
  const expected = leaseRemoved ? [] : [basename(evidence.sources.lease.path)];
  if (JSON.stringify(names) !== JSON.stringify(expected))
    throw new Error('expired producer lease set changed or conflicts');
  assertNoOtherAlphaGeneration(config, coordinates);
  assertNamedAlphaNotServing(coordinates, { readCwds: deps.readCwds });
}

function verifyExpiredEvidence(config, record, evidence, deps, state, command) {
  for (const [name, source] of Object.entries(evidence.sources))
    sameRecoveryFile(source, { missing: state.leaseRemoved && name === 'lease' });
  for (const snapshot of state.data.files) sameRecoveryFile(snapshot);
  if (
    snapshotRedisRetirementData(evidence).fingerprint !== state.data.fingerprint ||
    readForensicRecoveryHistory(record, evidence)?.fingerprint !== state.history.fingerprint
  )
    throw new Error('expired Redis data or recovery file set changed');
  assertExpiredAlphaIdle(config, record, evidence, deps, state.leaseRemoved, command);
}

/** Only resource absence and metadata settlement; never a successful historical SAVE receipt. */
export async function settleExpiredNamedAlphaLease(config, record, deps, release) {
  if (typeof release !== 'function') throw new Error('expired lease settlement needs the canonical locked release');
  const declared = readAlphaCompletionEvidence(config, record).coordinates;
  const published = publishedExpiredLease(record);
  if (priorRecovery(recoveryJournalRoot(record))) {
    if (published) throw new Error('saving recovery appeared during lease retirement');
    return null;
  }
  // An empty registry has its existing no-lease consumer, unless our completed
  // journal proves that this exact lease was already retired before a crash.
  if (!portLeases(declared, deps).length && !published?.savedLease) {
    if (published) throw new Error('lease disappeared before retirement result was published');
    return null;
  }
  const evidence = readHistoricalAlphaLeaseEvidence(config, record, { ...deps, savedLease: published?.savedLease });
  const { coordinates, proof, owner } = evidence;
  const completion = evidence.sources.completion.value;
  const running = (deps.isRunning ?? isProcessRunning)(proof.pid);
  if (running === true && !published) return null; // Existing live saving recovery, unchanged.
  if (running !== false) throw new Error('expired Redis PID is live or unproven');
  const command = readBoundPreviewCommand(record, completion);
  if (command) evidence.sources.command = command;
  const unlock = await acquireNamedAlphaLifecycle(coordinates);
  try {
    const history = readForensicRecoveryHistory(record, evidence);
    if (!history) throw new Error('saving recovery cannot downgrade to lease retirement');
    for (const [index, snapshot] of history.files.entries()) evidence.sources[`history_${index}`] = snapshot;
    if (record.logPath) {
      if (record.logPath !== (config.logPath ?? join(config.stateDir, `${config.id}.log`)))
        throw new Error('expired preview log changed');
      evidence.sources.log = recoverySnapshot(record.logPath, { maxBytes: 16 * 1024 * 1024 });
    }
    if (record.origin === 'launchd') evidence.sources.plist = recoverySnapshot(config.plistPath);
    const data = snapshotRedisRetirementData(evidence);
    const state = {
      data,
      history,
      leaseRemoved: Boolean(published?.savedLease && !recoveryPathExists(evidence.sources.lease.path)),
    };
    const verify = () => verifyExpiredEvidence(config, record, evidence, deps, state, command);
    verify();
    const journal = preserveRegistrationJournal(record, evidence, data.files, EXPIRED_LEASE_SETTLEMENT, {
      directories: data.directories,
      retiredLease: {
        path: evidence.sources.lease.path,
        sha256: evidence.sources.lease.sha256,
        port: proof.port,
        redisPid: proof.pid,
        ownerPid: owner.pid,
      },
    });
    verify();
    const explicit = completion.version === 2 && owner.version === 2;
    const summary = publishRegistrationResult(config, record, evidence, journal, {
      status: 'stopped',
      registered: false,
      originalExitCode: completion.exitCode,
      businessExitCode: explicit ? completion.commandExitCode : null,
      cleanupExitCode: explicit ? completion.cleanupExitCode : null,
      persistenceStatus: 'not_reverified',
      leaseStatus: 'retired',
      journalPath: journal.directory,
    });
    await deps.afterSettlementJournal?.();
    verify();
    if (!state.leaseRemoved) {
      (deps.removeLease ?? rmSync)(evidence.sources.lease.path);
      syncRecoveryDirectory(dirname(evidence.sources.lease.path));
      state.leaseRemoved = true;
    }
    await deps.afterRetiredLease?.();
    verify();
    return { result: await release({ record: evidence.sources.record, summary, assertReadyToRelease: verify }) };
  } finally {
    await unlock();
  }
}
