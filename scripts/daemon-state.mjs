#!/usr/bin/env node

import { homedir } from 'node:os';

import {
  DaemonStateError,
  daemonStatePaths,
  inspectDaemonState,
  migrateLegacyDaemonState,
  prepareDaemonStart,
  refusalFromInspection,
  stopDaemon,
  writeDaemonState,
} from './lib/daemon-state.mjs';
import {
  authorizeRestart,
  executeStop,
  readStopOperation,
  recordRestart,
  requestStop,
  reverifyStop,
} from './lib/daemon-stop-operation.mjs';

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const values = {};
  for (let index = 0; index < rest.length; index += 2) {
    const key = rest[index];
    if (!key?.startsWith('--') || rest[index + 1] === undefined) {
      throw new DaemonStateError('invalid-arguments', `Expected --key value, got: ${key ?? '<missing>'}`);
    }
    values[key.slice(2)] = rest[index + 1];
  }
  return { command, values };
}

function cliContext(values) {
  const projectRoot = values['project-root'];
  const deploymentId = values['deployment-id'];
  if (!projectRoot || !deploymentId) throw new DaemonStateError('invalid-arguments', 'Missing project/deployment');
  const paths = daemonStatePaths({ homeDir: values.home ?? homedir(), projectRoot, deploymentId });
  return { paths, projectRoot, deploymentId };
}

function reportLegacyMigration(result) {
  if (result.outcome === 'migrated') console.log(`Migrated legacy daemon PID ${result.pid}`);
  if (result.reason === 'legacy-owner-mismatch') {
    console.warn(
      `[daemon-state] WARNING [legacy-owner-mismatch]: skipped PID ${result.pid} owned by ${result.foreignCwd}`,
    );
  }
  if (result.reason === 'legacy-command-mismatch') {
    console.warn(`[daemon-state] WARNING [legacy-command-mismatch]: skipped non-daemon PID ${result.pid}`);
  }
}

async function main(argv) {
  const { command, values } = parseArgs(argv);
  const { paths, projectRoot, deploymentId } = cliContext(values);
  if (command === 'path') return console.log(paths.stateFile);
  if (command === 'migrate-legacy') {
    const result = migrateLegacyDaemonState({
      paths,
      legacyPidFile: values['legacy-pid-file'],
      legacyLogPathFile: values['legacy-log-path-file'],
      expectedProjectRoot: projectRoot,
      expectedDeploymentId: deploymentId,
    });
    reportLegacyMigration(result);
    return;
  }
  if (command === 'inspect') {
    const inspection = inspectDaemonState({
      stateFile: paths.stateFile,
      expectedProjectRoot: projectRoot,
      expectedDeploymentId: deploymentId,
    });
    const detail = inspection.kind === 'running' ? inspection.state.pid : inspection.reason;
    console.log(`${inspection.kind}${detail === undefined ? '' : `:${detail}`}`);
    return;
  }
  if (command === 'prepare') {
    const result = prepareDaemonStart({ paths, expectedProjectRoot: projectRoot, expectedDeploymentId: deploymentId });
    if (result.outcome === 'stale-cleared') console.log('Cleared stale daemon state');
    return;
  }
  if (command === 'write') {
    const state = writeDaemonState({
      paths,
      pid: Number.parseInt(values.pid, 10),
      projectRoot,
      deploymentId,
      launchToken: values['launch-token'],
      logFile: values['log-file'],
      ports: {
        frontend: Number.parseInt(values['frontend-port'], 10),
        api: Number.parseInt(values['api-port'], 10),
        redis: Number.parseInt(values['redis-port'], 10),
        preview: Number.parseInt(values['preview-port'], 10),
      },
    });
    console.log(`Recorded ${deploymentId} daemon PID ${state.pid}`);
    // F300: if an authorized restart is outstanding, this *is* that restart.
    // Binding it here keeps one opId across stop and restart without threading
    // the id through the shell scripts.
    const pending = readStopOperation(paths);
    if (pending?.state === 'restart_authorized') {
      const restarted = recordRestart({ paths, opId: pending.opId, pid: state.pid });
      console.log(`Bound restart to stop operation ${restarted.opId}`);
    }
    return;
  }
  if (command === 'stop') {
    // F300: every stop goes through the operation record, so the step after the
    // API is gone can still say what happened and what has to come back.
    const opened = requestStop({
      paths,
      expectedProjectRoot: projectRoot,
      expectedDeploymentId: deploymentId,
      invocationRef: values['invocation-ref'] ?? `cli:${process.pid}`,
    });
    if (opened.state === 'stale_cleared') {
      console.log(`No ${deploymentId} daemon was running; cleared stale state (op ${opened.opId})`);
      return;
    }
    const record = await executeStop({
      paths,
      expectedProjectRoot: projectRoot,
      expectedDeploymentId: deploymentId,
      opId: opened.opId,
      stop: (args) => stopDaemon({ ...args, graceMs: Number.parseInt(values['grace-ms'] ?? '15000', 10) }),
    });
    if (record.state !== 'stopped') {
      // The caller is a shell script that will otherwise announce success and
      // move on while the daemon is still running.
      console.error(
        `Failed to stop ${deploymentId} daemon PID ${record.targetProcessSet.join(', ')} ` +
          `(op ${record.opId}, ${record.state}${record.failure ? `: ${record.failure.reason}` : ''})`,
      );
      process.exitCode = 1;
      return;
    }
    console.log(
      `Stopped ${deploymentId} daemon PID ${record.targetProcessSet.join(', ')} (op ${record.opId}, ${record.state})`,
    );
    return;
  }
  if (command === 'stop-authorize-restart') {
    const record = readStopOperation(paths);
    if (!record) throw new DaemonStateError('no-stop-operation', 'No stop operation to authorize a restart for');
    const authorized = authorizeRestart({ paths, opId: record.opId, authorizedBy: values['authorized-by'] });
    console.log(`Restart authorized for ${authorized.opId} by ${authorized.restart.authorizedBy}`);
    return;
  }
  if (command === 'stop-reverify') {
    const record = readStopOperation(paths);
    // Nothing to re-verify is a normal state, not a failure: most starts are
    // not the second half of an authorized stop.
    if (!record || record.state !== 'restarted') return;
    // No caller-supplied health: the record layer probes the incarnation it
    // recorded and produces its own evidence.
    const verified = await reverifyStop({ paths, opId: record.opId });
    if (verified.state !== 'reverified') {
      console.error(`Stop operation ${verified.opId} could not be re-verified (${verified.failure?.reason})`);
      process.exitCode = 1;
      return;
    }
    console.log(`Stop operation ${verified.opId} re-verified against ${verified.reverification.ref}`);
    return;
  }
  if (command === 'status') {
    const inspection = inspectDaemonState({
      stateFile: paths.stateFile,
      expectedProjectRoot: projectRoot,
      expectedDeploymentId: deploymentId,
    });
    if (inspection.kind !== 'running') throw refusalFromInspection(inspection);
    console.log(`Clowder AI ${deploymentId} daemon is running (PID ${inspection.state.pid})`);
    console.log(`  root: ${inspection.state.projectRoot}`);
    console.log(`  log: ${inspection.state.logFile}`);
    console.log(`  ports: ${JSON.stringify(inspection.state.ports)}`);
    return;
  }
  throw new DaemonStateError('invalid-command', `Unknown command: ${command}`);
}

main(process.argv.slice(2)).catch((error) => {
  const reason = error instanceof DaemonStateError ? ` [${error.reason}]` : '';
  console.error(`[daemon-state] ERROR${reason}: ${error.message}`);
  process.exitCode = 1;
});
