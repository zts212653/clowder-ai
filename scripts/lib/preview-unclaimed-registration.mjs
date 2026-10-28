import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { assertNamedAlphaCheckout, assertNamedAlphaNotServing } from './alpha-coordinates.mjs';
import { acquireNamedAlphaLifecycle } from './alpha-lifecycle-lock.mjs';
import {
  readRegisteredPreviewEnvelope,
  recoveryFile,
  recoveryPathExists,
  recoverySnapshot,
} from './preview-alpha-recovery-evidence.mjs';
import {
  assertRecoveryLaunchd,
  recoveryGroupRunning,
  recoveryListeners,
} from './preview-alpha-recovery-observation.mjs';
import {
  assertRegistrationSources,
  portLeases,
  preserveRegistrationJournal,
  publishRegistrationResult,
  snapshotData,
} from './preview-alpha-registration-settlement.mjs';
import { isUnclaimedPreviewFailure } from './preview-cleanup-result.mjs';
import { readBoundPreviewCommand } from './preview-command-identity.mjs';
import { recordedAlphaConfiguration } from './preview-recorded-alpha-configuration.mjs';
import { isProcessRunning } from './process-tree.mjs';

function otherGeneration(config, coordinates) {
  const names = readdirSync(config.stateDir);
  if (names.length > 16384) throw new Error('preview registry observation exceeds its bound');
  for (const name of names.filter((n) => /^[a-f0-9]{16}\.json$/.test(n))) {
    const path = join(config.stateDir, name);
    if (path === config.recordPath) continue;
    const other = recoveryFile(path).value;
    if (Object.values(coordinates.ports).includes(other.port) || other.command?.includes(coordinates.instance))
      throw new Error('another registered Alpha generation is active or unsettled, including pre-listener builds');
  }
}

export function readUnclaimedAlphaRegistration(config, record) {
  const envelope = readRegisteredPreviewEnvelope(config, record);
  const { coordinates, options } = recordedAlphaConfiguration(record.command, config.cwd);
  if (!options['--instance'] || coordinates.ports.frontend !== record.port)
    throw new Error('recorded failed Alpha has a different isolated tuple');
  if (recoveryPathExists(coordinates.alphaRoot)) assertNamedAlphaCheckout(coordinates, { requireClean: false });
  const evidence = { ...envelope, coordinates };
  const completion = evidence.completion;
  if (!isUnclaimedPreviewFailure(completion) || recoveryPathExists(`${record.completionPath}.recovery`))
    throw new Error('registration has no bounded unclaimed command failure receipt');
  const ownerPath = `${record.completionPath}.owner.json`;
  const command = readBoundPreviewCommand(record, completion);
  if (command) evidence.sources.command = command;
  if (recoveryPathExists(ownerPath)) throw new Error('unclaimed registration now has an owner artifact');
  return evidence;
}

/** Read-only preflight; mutation repeats it under both lifecycle locks. */
export function assertUnclaimedAlphaIdle(config, record, evidence, deps = {}) {
  const { coordinates } = evidence;
  const command = evidence.sources.command;
  const ownerPath = `${record.completionPath}.owner.json`;
  if (recoveryPathExists(ownerPath)) throw new Error('unclaimed registration now has an owner artifact');
  if (
    (deps.isRunning ?? isProcessRunning)(record.pid) !== false ||
    (deps.groupRunning ?? recoveryGroupRunning)(record.pid) !== false
  )
    throw new Error('old Alpha supervisor is live or unproven');
  if (
    command?.value.identityStatus === 'observed' &&
    ((deps.isRunning ?? isProcessRunning)(command.value.pid) !== false ||
      (deps.groupRunning ?? recoveryGroupRunning)(command.value.processGroupId) !== false)
  )
    throw new Error('recorded Alpha command is live or unproven');
  assertRecoveryLaunchd(config, record, deps.readJob);
  for (const port of Object.values(coordinates.ports))
    if ((deps.readListeners ?? recoveryListeners)(port).length) throw new Error('Alpha port is occupied');
  if (portLeases(coordinates, deps).length) throw new Error('Alpha same-port producer lease still exists');
  otherGeneration(config, coordinates);
  assertNamedAlphaNotServing(coordinates, { readCwds: deps.readCwds });
}

/** Retires only a terminated supervisor's registration; missing child identity remains unknown. */
export async function retireUnclaimedAlphaRegistration(config, record, deps, release) {
  const evidence = readUnclaimedAlphaRegistration(config, record);
  const { coordinates, completion } = evidence;
  const assertUnoccupied = () => assertUnclaimedAlphaIdle(config, record, evidence, deps);
  const unlock = await acquireNamedAlphaLifecycle(coordinates);
  try {
    assertUnoccupied();
    if (record.logPath) {
      if (record.logPath !== (config.logPath ?? join(config.stateDir, `${config.id}.log`)))
        throw new Error('unclaimed preview log coordinate changed');
      evidence.sources.log = recoverySnapshot(record.logPath, { maxBytes: 16 * 1024 * 1024 });
    }
    if (record.origin === 'launchd') evidence.sources.plist = recoverySnapshot(config.plistPath);
    const dataState = () => ({
      checkoutPresent: recoveryPathExists(coordinates.alphaRoot),
      directory: join(coordinates.alphaRoot, '.cat-cafe/redis'),
      directoryPresent: recoveryPathExists(join(coordinates.alphaRoot, '.cat-cafe/redis')),
      dumpPresent: recoveryPathExists(join(coordinates.alphaRoot, '.cat-cafe/redis/dump.rdb')),
    });
    const initialData = dataState();
    const snapshots = snapshotData(evidence);
    const journal = preserveRegistrationJournal(
      record,
      evidence,
      snapshots,
      'unclaimed-alpha-registration-retirement',
      { ownerAbsent: true, dataState: initialData },
    );
    const assertReadyToRelease = () => {
      assertRegistrationSources(evidence, snapshots);
      assertUnoccupied();
      if (
        JSON.stringify(dataState()) !== JSON.stringify(initialData) ||
        JSON.stringify(snapshotData(evidence).map((s) => [s.path, s.sha256])) !==
          JSON.stringify(snapshots.map((s) => [s.path, s.sha256]))
      )
        throw new Error('Alpha data evidence changed during retirement');
    };
    assertReadyToRelease();
    const summary = publishRegistrationResult(config, record, evidence, journal, {
      status: 'registration_retired',
      registered: false,
      originalExitCode: completion.exitCode,
      businessExitCode: completion.commandExitCode,
      cleanupExitCode: null,
      cleanupStatus: 'unknown',
      commandGroupStatus: evidence.sources.command?.value.identityStatus === 'observed' ? 'absent' : 'unverified',
      persistenceStatus: 'not_reverified',
      journalPath: journal.directory,
    });
    await deps.afterSettlementJournal?.();
    assertReadyToRelease();
    return await release({ record: evidence.sources.record, summary, assertReadyToRelease });
  } finally {
    await unlock();
  }
}
