import { readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { classifyNativeTarget } from '../native-effect-target-classifier.mjs';
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
  preserveRegistrationJournal,
  publishRegistrationResult,
} from './preview-alpha-registration-settlement.mjs';
import { ordinaryUnclaimedReceiptFormat } from './preview-cleanup-result.mjs';
import { readBoundPreviewCommand } from './preview-command-identity.mjs';
import { canonicalWorktreePreviewPort, physicalDirectory } from './preview-coordinates.mjs';
import { isProcessRunning } from './process-tree.mjs';
import { readSelfHostFacet } from './self-host-facet.mjs';

export function ordinaryRetirementCandidate(config, record, completion) {
  return (
    ordinaryUnclaimedReceiptFormat(completion) !== null &&
    Array.isArray(record.command) &&
    !record.command.includes('--instance') &&
    typeof config.cwd === 'string' &&
    basename(config.cwd) !== 'cat-cafe'
  );
}

function assertScope(config, record, deps) {
  const cwd = physicalDirectory(config.cwd);
  if (
    !cwd ||
    !canonicalWorktreePreviewPort(String(config.port)) ||
    classifyNativeTarget('', cwd, 'process_control').kind !== 'ordinary' ||
    classifyNativeTarget(config.stateDir, config.cwd, 'write').kind !== 'ordinary'
  )
    throw new Error('ordinary retirement cannot target a host/sanctuary coordinate');
  const host = (deps.readHost ?? readSelfHostFacet)();
  if (host.confidence === 'none' && !host.facet) return;
  if (host.confidence !== 'exact' || !host.facet) throw new Error('ordinary retirement host scope is unproven');
  const { facet } = host;
  if (
    !Number.isSafeInteger(facet.runtime?.apiPort) ||
    !Array.isArray(facet.hostDependencies) ||
    !Array.isArray(facet.launcherPids) ||
    typeof facet.installation?.projectRoot !== 'string'
  )
    throw new Error('ordinary retirement host scope is incomplete');
  const ports = [facet.runtime?.apiPort, ...(facet.hostDependencies ?? []).map((d) => d.port)];
  const pids = [
    ...(facet.launcherPids ?? []),
    facet.runtime?.launcherPid,
    ...(facet.hostDependencies ?? []).map((d) => d.pid),
  ];
  const roots = [facet.runtime?.worktree, facet.installation?.projectRoot]
    .filter((p) => typeof p === 'string')
    .map((root) => physicalDirectory(root) ?? root);
  if (
    ports.includes(config.port) ||
    pids.includes(record.pid) ||
    roots.some((root) => cwd === root || cwd.startsWith(`${root}/`))
  )
    throw new Error('ordinary retirement target belongs to the current host');
}

function assertNoSuccessor(config) {
  const names = readdirSync(config.stateDir);
  if (names.length > 16384) throw new Error('ordinary successor observation exceeds its bound');
  for (const name of names.filter((n) => /^[a-f0-9]{16}\.json$/.test(n))) {
    const path = join(config.stateDir, name);
    if (path !== config.recordPath && recoveryFile(path).value.port === config.port)
      throw new Error('another preview generation is registered on this port');
  }
}

/** Only removes an ended supervisor registration. No script inspection or resource/data action. */
export async function retireUnclaimedOrdinaryRegistration(config, record, deps = {}) {
  const evidence = readRegisteredPreviewEnvelope(config, record),
    { completion } = evidence;
  const format = ordinaryUnclaimedReceiptFormat(completion);
  if (
    !format ||
    !ordinaryRetirementCandidate(config, record, completion) ||
    recoveryPathExists(`${record.completionPath}.recovery`)
  )
    throw new Error('ordinary registration has no known unclaimed completion format');
  if (
    record.readyAt &&
    (!Number.isFinite(Date.parse(record.readyAt)) ||
      Date.parse(record.readyAt) < Date.parse(record.startedAt) ||
      Date.parse(record.readyAt) > Date.parse(completion.completedAt))
  )
    throw new Error('ordinary readiness receipt is inconsistent');
  const command = readBoundPreviewCommand(record, completion);
  if (command) evidence.sources.command = command;
  const assertIdle = () => {
    assertScope(config, record, deps);
    if (recoveryPathExists(`${record.completionPath}.owner.json`)) throw new Error('ordinary cleanup owner appeared');
    if (
      (deps.isRunning ?? isProcessRunning)(record.pid) !== false ||
      (deps.groupRunning ?? recoveryGroupRunning)(record.pid) !== false
    )
      throw new Error('ordinary supervisor/group is live or unproven');
    if (
      command?.value.identityStatus === 'observed' &&
      ((deps.isRunning ?? isProcessRunning)(command.value.pid) !== false ||
        (deps.groupRunning ?? recoveryGroupRunning)(command.value.processGroupId) !== false)
    )
      throw new Error('ordinary command group is live or unproven');
    assertRecoveryLaunchd(config, record, deps.readJob);
    if ((deps.readListeners ?? recoveryListeners)(config.port).length)
      throw new Error('ordinary preview port remains occupied');
    assertNoSuccessor(config);
  };
  assertIdle();
  if (record.logPath) {
    if (record.logPath !== (config.logPath ?? join(config.stateDir, `${config.id}.log`)))
      throw new Error('ordinary log coordinate changed');
    evidence.sources.log = recoverySnapshot(record.logPath, { maxBytes: 16 * 1024 * 1024 });
  }
  if (record.origin === 'launchd') evidence.sources.plist = recoverySnapshot(config.plistPath);
  const journal = preserveRegistrationJournal(record, evidence, [], 'unclaimed-preview-registration-retirement', {
    ownerAbsent: true,
    receiptFormat: format,
    dataCoordinatesStatus: 'unknown',
  });
  const assertReadyToRelease = () => {
    assertRegistrationSources(evidence, []);
    assertIdle();
  };
  assertReadyToRelease();
  const summary = publishRegistrationResult(config, record, evidence, journal, {
    status: 'registration_retired',
    registered: false,
    originalExitCode: completion.exitCode,
    businessExitCode: format === 'v2' ? completion.commandExitCode : null,
    cleanupExitCode: null,
    cleanupStatus: 'unknown',
    commandGroupStatus: command?.value.identityStatus === 'observed' ? 'absent' : 'unverified',
    otherResourcesStatus: 'not_reverified',
    persistenceStatus: 'not_reverified',
    journalPath: journal.directory,
  });
  await deps.afterSettlementJournal?.();
  assertReadyToRelease();
  return { record: evidence.sources.record, summary, assertReadyToRelease };
}
