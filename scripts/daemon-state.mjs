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
    return;
  }
  if (command === 'stop') {
    const result = await stopDaemon({
      paths,
      expectedProjectRoot: projectRoot,
      expectedDeploymentId: deploymentId,
      graceMs: Number.parseInt(values['grace-ms'] ?? '15000', 10),
    });
    console.log(`Stopped ${deploymentId} daemon PID ${result.pid}${result.forced ? ' (forced)' : ''}`);
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
