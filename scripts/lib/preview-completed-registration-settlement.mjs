import { readPreviewCompletionEvidence, recoverySnapshot } from './preview-alpha-recovery-evidence.mjs';
import {
  assertPreviewProcessQuiescence,
  assertRecoveryLaunchd,
  recoveryListeners,
} from './preview-alpha-recovery-observation.mjs';
import {
  assertRegistrationSources,
  preserveRegistrationJournal,
  publishRegistrationResult,
} from './preview-alpha-registration-settlement.mjs';
import { capturePreviewDiagnosticLog } from './preview-diagnostic-log.mjs';

/** Retire an explicitly completed ordinary preview. No resource ownership or SAVE is inferred. */
export function settleCompletedPreviewRegistration(config, record, deps = {}) {
  if (record.command?.includes('--instance'))
    throw new Error('named Alpha must retain its own settlement and lease proof');
  const evidence = readPreviewCompletionEvidence(config, record);
  const { completion, owner } = evidence;
  if (
    completion.version !== 2 ||
    owner.version !== 2 ||
    completion.cleanupExitCode !== 0 ||
    owner.cleanupExitCode !== 0 ||
    completion.commandExitCode === null ||
    !Number.isInteger(completion.runnerExitCode) ||
    completion.runnerExitCode < 0 ||
    completion.runnerExitCode > 255
  )
    throw new Error('ordinary preview has no explicit successful cleanup proof');
  const assertStopped = () => {
    assertPreviewProcessQuiescence(record, owner, deps);
    assertRecoveryLaunchd(config, record, deps.readJob);
    if ((deps.readListeners ?? recoveryListeners)(config.port).length)
      throw new Error('ordinary preview port remains occupied');
  };
  assertStopped();
  const log = capturePreviewDiagnosticLog(config, record, evidence);
  if (record.origin === 'launchd') evidence.sources.plist = recoverySnapshot(config.plistPath);
  const journal = preserveRegistrationJournal(
    record,
    evidence,
    [],
    'completed-preview-registration-settlement',
    log.details,
  );
  const assertReadyToRelease = () => {
    assertRegistrationSources(evidence, []);
    log.assertCurrent();
    assertStopped();
  };
  assertReadyToRelease();
  const summary = publishRegistrationResult(config, record, evidence, journal);
  assertReadyToRelease();
  return { record: evidence.sources.record, summary, assertReadyToRelease };
}
