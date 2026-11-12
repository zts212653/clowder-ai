import { join } from 'node:path';
import {
  readPreviewCompletionEvidence,
  readRegisteredPreviewEnvelope,
  recoveryPathExists,
  recoverySnapshot,
} from './preview-alpha-recovery-evidence.mjs';
import {
  assertRegistrationSources,
  preserveRegistrationJournal,
  publishRegistrationResult,
} from './preview-alpha-registration-settlement.mjs';
import { ordinaryUnclaimedReceiptFormat } from './preview-cleanup-result.mjs';
import { readBoundPreviewCommand } from './preview-command-identity.mjs';
import {
  assertStandardAlphaIdle,
  failedOwnerReceiptFormat,
  isExitCode,
  resolveStandardAlphaCoordinates,
} from './preview-standard-alpha-observation.mjs';

export function standardAlphaRetirementCandidate(config, record, completion) {
  if (!completion || completion.forced !== false || !record?.completionPath) return false;
  if (recoveryPathExists(`${record.completionPath}.recovery`) || !resolveStandardAlphaCoordinates(config, record))
    return false;
  return ordinaryUnclaimedReceiptFormat(completion) !== null || failedOwnerReceiptFormat(completion) !== null;
}

function assertReadinessConsistent(record, completion) {
  if (!record.readyAt) return;
  const readyMs = Date.parse(record.readyAt);
  if (
    !Number.isFinite(readyMs) ||
    readyMs < Date.parse(record.startedAt) ||
    readyMs > Date.parse(completion.completedAt)
  )
    throw new Error('standard Alpha readiness receipt is inconsistent');
}

function loadStandardAlphaEvidence(config, record) {
  const rawEnvelope = readRegisteredPreviewEnvelope(config, record);
  const unclaimedFormat = ordinaryUnclaimedReceiptFormat(rawEnvelope.completion);
  const ownerFormat = unclaimedFormat ? null : failedOwnerReceiptFormat(rawEnvelope.completion);
  if (!unclaimedFormat && !ownerFormat)
    throw new Error('standard Alpha registration has no bounded retirement receipt');
  const evidence = unclaimedFormat ? rawEnvelope : readPreviewCompletionEvidence(config, record);
  const { completion, owner } = evidence;
  const format = unclaimedFormat ?? ownerFormat;
  if (owner && format === 'v2' && !(isExitCode(owner.cleanupExitCode) && owner.cleanupExitCode > 0))
    throw new Error('standard Alpha owner receipt does not match failed v2 cleanup');
  assertReadinessConsistent(record, completion);
  const command = readBoundPreviewCommand(record, completion);
  if (command) evidence.sources.command = command;
  return { evidence, completion, owner, command, unclaimedFormat, format };
}

function snapshotOptionalSources(config, record, evidence) {
  if (record.logPath && recoveryPathExists(record.logPath)) {
    if (record.logPath !== (config.logPath ?? join(config.stateDir, `${config.id}.log`)))
      throw new Error('standard Alpha log coordinate changed');
    evidence.sources.log = recoverySnapshot(record.logPath, { maxBytes: 16 * 1024 * 1024 });
  }
  if (record.origin === 'launchd') evidence.sources.plist = recoverySnapshot(config.plistPath);
}

/** Retires only a dead standard Alpha preview registration; shared 6397 is never signalled. */
export async function retireStandardAlphaRegistration(config, record, deps = {}) {
  const resolved = resolveStandardAlphaCoordinates(config, record);
  if (!resolved || recoveryPathExists(`${record.completionPath}.recovery`))
    throw new Error('registration is not an eligible standard Alpha preview');
  const loaded = loadStandardAlphaEvidence(config, record);
  const { evidence, completion, owner, command, unclaimedFormat, format } = loaded;
  const idleState = { ...resolved, owner, command, unclaimedFormat };
  assertStandardAlphaIdle(config, record, idleState, deps);
  snapshotOptionalSources(config, record, evidence);
  const journal = preserveRegistrationJournal(record, evidence, [], 'standard-alpha-registration-retirement', {
    ownerAbsent: Boolean(unclaimedFormat),
    receiptFormat: format,
    dataCoordinatesStatus: 'shared_alpha_not_reverified',
  });
  const assertReadyToRelease = () => {
    assertRegistrationSources(evidence, []);
    assertStandardAlphaIdle(config, record, idleState, deps);
  };
  assertReadyToRelease();
  const summary = publishRegistrationResult(config, record, evidence, journal, {
    status: 'registration_retired',
    registered: false,
    originalExitCode: completion.exitCode,
    businessExitCode: format === 'v2' ? completion.commandExitCode : null,
    cleanupExitCode: owner && format === 'v2' ? completion.cleanupExitCode : null,
    cleanupStatus: 'unknown',
    priorCleanupStatus: unclaimedFormat ? 'unclaimed' : format === 'v2' ? 'failed' : 'legacy_unseparated',
    commandGroupStatus: command?.value.identityStatus === 'observed' ? 'absent' : 'unverified',
    otherResourcesStatus: 'not_reverified',
    persistenceStatus: 'not_reverified',
    journalPath: journal.directory,
  });
  await deps.afterSettlementJournal?.();
  assertReadyToRelease();
  return { record: evidence.sources.record, summary, assertReadyToRelease };
}
