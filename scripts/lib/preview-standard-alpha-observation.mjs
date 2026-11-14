import { readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { classifyNativeTarget } from '../native-effect-target-classifier.mjs';
import { parseAlphaLaunchChild, STANDARD_ALPHA_PORTS } from './alpha-launch-contract.mjs';
import { daemonStatePaths, inspectDaemonState } from './daemon-state.mjs';
import { recoveryFile, recoveryPathExists } from './preview-alpha-recovery-evidence.mjs';
import {
  assertPreviewProcessQuiescence,
  assertRecoveryLaunchd,
  recoveryGroupRunning,
  recoveryListeners,
} from './preview-alpha-recovery-observation.mjs';
import { physicalDirectory } from './preview-coordinates.mjs';
import { isQuiescentHistoricalPredecessor } from './preview-standard-alpha-predecessor.mjs';
import { isProcessRunning } from './process-tree.mjs';
import { readSelfHostFacet } from './self-host-facet.mjs';

const APP_PORTS = [
  STANDARD_ALPHA_PORTS.frontend,
  STANDARD_ALPHA_PORTS.api,
  STANDARD_ALPHA_PORTS.preview,
  STANDARD_ALPHA_PORTS.service,
];
const ALL_PORTS = [...APP_PORTS, STANDARD_ALPHA_PORTS.redis];
export const isExitCode = (n) => Number.isInteger(n) && n >= 0 && n <= 255;

function hasStandardAlphaRecordShape(config, record) {
  return (
    record?.version === 1 &&
    Array.isArray(record.command) &&
    !record.command.includes('--instance') &&
    !record.command.includes('--ports') &&
    config.port === STANDARD_ALPHA_PORTS.frontend &&
    record.port === STANDARD_ALPHA_PORTS.frontend &&
    typeof config.cwd === 'string'
  );
}

export function resolveStandardAlphaCoordinates(config, record) {
  if (!hasStandardAlphaRecordShape(config, record)) return null;
  const cwd = physicalDirectory(config.cwd);
  if (!cwd || basename(cwd) !== 'cat-cafe') return null;
  try {
    const parsed = parseAlphaLaunchChild(record.command, cwd);
    return parsed.options['--instance'] || parsed.options['--ports'] ? null : { cwd, coordinates: parsed.coordinates };
  } catch {
    return null;
  }
}

export function failedOwnerReceiptFormat(completion) {
  if (!completion || completion.forced !== false || completion.cleanupOwnerStatus !== 'complete') return null;
  if (completion.version === undefined)
    return isExitCode(completion.exitCode) && completion.exitCode > 0 ? 'legacy' : null;
  const failedV2 =
    completion.version === 2 &&
    isExitCode(completion.exitCode) &&
    isExitCode(completion.cleanupExitCode) &&
    completion.cleanupExitCode > 0;
  return failedV2 ? 'v2' : null;
}

function assertHostFacetCompatible(facet, record, cwd, coordinates) {
  const validShape =
    Number.isSafeInteger(facet.runtime?.apiPort) &&
    Array.isArray(facet.hostDependencies) &&
    Array.isArray(facet.launcherPids) &&
    typeof facet.installation?.projectRoot === 'string';
  if (!validShape) throw new Error('standard Alpha host scope is incomplete');
  const installRoot = physicalDirectory(facet.installation.projectRoot);
  const runtimeRoot = typeof facet.runtime?.worktree === 'string' ? physicalDirectory(facet.runtime.worktree) : null;
  const siblingRuntimeHost =
    facet.installation.deploymentId === 'runtime' && Boolean(installRoot) && dirname(installRoot) === dirname(cwd);
  const hostPorts = [facet.runtime?.apiPort, ...facet.hostDependencies.map((d) => d.port)];
  const hostPids = [...facet.launcherPids, facet.runtime?.launcherPid, ...facet.hostDependencies.map((d) => d.pid)];
  const overlaps = (root) =>
    Boolean(root) && (coordinates.alphaRoot === root || coordinates.alphaRoot.startsWith(`${root}/`));
  const allowedCwd = Boolean(installRoot) && (cwd === installRoot || siblingRuntimeHost);
  if (
    !allowedCwd ||
    overlaps(installRoot) ||
    overlaps(runtimeRoot) ||
    APP_PORTS.some((port) => hostPorts.includes(port)) ||
    hostPids.includes(record.pid)
  )
    throw new Error('standard Alpha retirement target conflicts with current host');
}

function assertHostScope(config, record, cwd, coordinates, deps) {
  const targetsSanctuary =
    classifyNativeTarget('', cwd, 'process_control').kind === 'runtime_sanctuary' ||
    classifyNativeTarget('', coordinates.alphaRoot, 'process_control').kind === 'runtime_sanctuary' ||
    classifyNativeTarget(config.stateDir, cwd, 'write').kind !== 'ordinary';
  if (targetsSanctuary) throw new Error('standard Alpha retirement cannot target runtime sanctuary');
  const host = (deps.readHost ?? readSelfHostFacet)();
  if (host.confidence === 'none' && !host.facet) return;
  if (host.confidence !== 'exact' || !host.facet) throw new Error('standard Alpha host scope is unproven');
  assertHostFacetCompatible(host.facet, record, cwd, coordinates);
}

function assertDaemonNotRunning(coordinates, deps) {
  if (!recoveryPathExists(coordinates.alphaRoot)) return;
  const paths = daemonStatePaths({
    homeDir: deps.homeDir ?? process.env.HOME ?? homedir(),
    projectRoot: coordinates.alphaRoot,
    deploymentId: 'alpha',
  });
  const daemon = inspectDaemonState({
    stateFile: paths.stateFile,
    expectedProjectRoot: coordinates.alphaRoot,
    expectedDeploymentId: 'alpha',
    captureIdentity: deps.captureDaemonProcess,
  });
  if (!['missing', 'stale'].includes(daemon.kind)) throw new Error(`standard Alpha daemon state is ${daemon.kind}`);
}

function assertNoSuccessor(config, record, deps) {
  const names = readdirSync(config.stateDir);
  if (names.length > 16384) throw new Error('standard Alpha successor observation exceeds its bound');
  for (const name of names.filter((n) => /^[a-f0-9]{16}\.json$/.test(n))) {
    const path = join(config.stateDir, name);
    if (path === config.recordPath) continue;
    const other = recoveryFile(path).value;
    if (
      ALL_PORTS.includes(other.port) &&
      !isQuiescentHistoricalPredecessor(config, record, name.slice(0, 16), other, deps)
    )
      throw new Error('another preview generation is registered on a standard Alpha port');
  }
}

function assertProcessAndCommandQuiescent(record, owner, command, unclaimedFormat, deps) {
  const checkPid = deps.isRunning ?? isProcessRunning;
  const checkGroup = deps.groupRunning ?? recoveryGroupRunning;
  if (unclaimedFormat) {
    if (recoveryPathExists(`${record.completionPath}.owner.json`))
      throw new Error('standard Alpha cleanup owner appeared');
    if (checkPid(record.pid) !== false || checkGroup(record.pid) !== false)
      throw new Error('standard Alpha supervisor/group is live or unproven');
  } else {
    assertPreviewProcessQuiescence(record, owner, deps);
  }
  if (
    command?.value.identityStatus === 'observed' &&
    (checkPid(command.value.pid) !== false || checkGroup(command.value.processGroupId) !== false)
  )
    throw new Error('standard Alpha command group is live or unproven');
}

export function assertStandardAlphaIdle(config, record, state, deps) {
  const { cwd, coordinates, owner, command, unclaimedFormat } = state;
  assertHostScope(config, record, cwd, coordinates, deps);
  assertProcessAndCommandQuiescent(record, owner, command, unclaimedFormat, deps);
  assertRecoveryLaunchd(config, record, deps.readJob);
  for (const port of APP_PORTS) {
    if ((deps.readListeners ?? recoveryListeners)(port).length)
      throw new Error(`standard Alpha application port ${port} remains occupied`);
  }
  assertDaemonNotRunning(coordinates, deps);
  assertNoSuccessor(config, record, deps);
}
