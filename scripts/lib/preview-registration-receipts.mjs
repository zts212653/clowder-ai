import { randomUUID } from 'node:crypto';
import { renameSync, rmSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import {
  recoveryFile,
  recoveryPathExists,
  syncRecoveryDirectory,
  writeRecoveryFile,
} from './preview-alpha-recovery-evidence.mjs';

const pointerPath = (config) => join(config.stateDir, `${config.id}.settlement.json`);

function outcome(evidence, directory) {
  const { completion, owner } = evidence;
  const explicit = completion.version === 2 && owner.version === 2;
  return {
    status: 'stopped',
    registered: false,
    originalExitCode: completion.exitCode,
    businessExitCode: explicit ? completion.commandExitCode : null,
    cleanupExitCode: explicit ? completion.cleanupExitCode : null,
    persistenceStatus: 'not_reverified',
    journalPath: directory,
  };
}

export function publishRegistrationResult(config, record, evidence, journal, summary) {
  const resultPath = join(journal.directory, 'result.json');
  const expected = { ...journal.intent, outcome: summary ?? outcome(evidence, journal.directory) };
  if (recoveryPathExists(resultPath)) {
    const { completedAt, ...prior } = recoveryFile(resultPath).value;
    if (!Number.isFinite(Date.parse(completedAt)) || JSON.stringify(prior) !== JSON.stringify(expected))
      throw new Error('settlement result belongs to another lifecycle');
  } else writeRecoveryFile(resultPath, { ...expected, completedAt: new Date().toISOString() });
  const result = recoveryFile(resultPath);
  const temporary = join(config.stateDir, `.${config.id}.${randomUUID()}.settlement.tmp`);
  writeRecoveryFile(temporary, {
    v: 1,
    id: config.id,
    cwd: config.cwd,
    port: config.port,
    completionPath: record.completionPath,
    resultPath,
    sha256: result.sha256,
  });
  renameSync(temporary, pointerPath(config));
  syncRecoveryDirectory(config.stateDir);
  return { ...result.value.outcome, completedAt: result.value.completedAt };
}

function validUnclaimedProjection(value, pointer) {
  const s = value.outcome;
  if (
    !['unverified', 'absent'].includes(s.commandGroupStatus) ||
    s.cleanupExitCode !== null ||
    s.cleanupStatus !== 'unknown' ||
    (s.commandGroupStatus === 'absent' && value.sources?.command?.path !== `${pointer.completionPath}.command.json`)
  )
    return false;
  if (value.kind === 'unclaimed-alpha-registration-retirement')
    return (
      s.businessExitCode === s.originalExitCode &&
      s.originalExitCode > 0 &&
      typeof value.dataState?.directoryPresent === 'boolean'
    );
  return (
    ['legacy', 'v2'].includes(value.receiptFormat) &&
    value.dataCoordinatesStatus === 'unknown' &&
    value.data?.length === 0 &&
    s.otherResourcesStatus === 'not_reverified' &&
    (value.receiptFormat !== 'legacy' || (s.businessExitCode === null && s.commandGroupStatus === 'unverified'))
  );
}

export function readPreviewSettlement(config) {
  if (recoveryPathExists(config.recordPath)) return null;
  if (!recoveryPathExists(pointerPath(config))) return null;
  const pointer = recoveryFile(pointerPath(config)).value;
  if (
    pointer.v !== 1 ||
    pointer.id !== config.id ||
    pointer.cwd !== config.cwd ||
    pointer.port !== config.port ||
    dirname(pointer.completionPath ?? '') !== config.stateDir ||
    !new RegExp(`^${config.id}\\.[a-f0-9-]{36}\\.completion\\.json$`).test(basename(pointer.completionPath ?? '')) ||
    pointer.resultPath !== join(`${pointer.completionPath}.settlement`, 'result.json')
  )
    throw new Error('preview settlement pointer is inconsistent');
  const result = recoveryFile(pointer.resultPath);
  const value = result.value;
  const summary = value.outcome;
  const retired = ['unclaimed-alpha-registration-retirement', 'unclaimed-preview-registration-retirement'].includes(
    value.kind,
  );
  const code = (number) => Number.isInteger(number) && number >= 0 && number <= 255;
  if (
    result.sha256 !== pointer.sha256 ||
    value.v !== 1 ||
    ![
      'named-alpha-registration-settlement',
      'completed-preview-registration-settlement',
      'unclaimed-alpha-registration-retirement',
      'unclaimed-preview-registration-retirement',
    ].includes(value.kind) ||
    value.sources?.record?.path !== config.recordPath ||
    value.sources?.completion?.path !== pointer.completionPath ||
    (retired
      ? value.sources?.owner !== undefined || value.ownerAbsent !== true
      : value.sources?.owner?.path !== `${pointer.completionPath}.owner.json`) ||
    summary?.status !== (retired ? 'registration_retired' : 'stopped') ||
    (retired && !validUnclaimedProjection(value, pointer)) ||
    summary.registered !== false ||
    summary.persistenceStatus !== 'not_reverified' ||
    summary.journalPath !== dirname(pointer.resultPath) ||
    !code(summary.originalExitCode) ||
    (summary.businessExitCode !== null && !code(summary.businessExitCode)) ||
    (summary.cleanupExitCode !== null && !code(summary.cleanupExitCode)) ||
    !Number.isFinite(Date.parse(value.completedAt))
  )
    throw new Error('preview settlement receipt changed');
  return { ...result.value.outcome, completedAt: result.value.completedAt };
}

export function clearPreviewSettlement(config) {
  if (recoveryPathExists(pointerPath(config))) {
    rmSync(pointerPath(config));
    syncRecoveryDirectory(config.stateDir);
  }
}

/** Archived configuration attributes only the same canonical lifecycle, not any live PID. */
export function readRetiredPreviewRecord(config) {
  const summary = readPreviewSettlement(config);
  if (summary?.status !== 'registration_retired') return null;
  const result = recoveryFile(join(summary.journalPath, 'result.json')).value;
  const archived = recoveryFile(join(summary.journalPath, 'record.json'));
  if (archived.sha256 !== result.sources.record.sha256) throw new Error('retired preview configuration changed');
  return archived.value;
}
