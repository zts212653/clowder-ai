import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { stoppedFixture } from './preview-alpha-settlement-test-fixture.mjs';
import { previewProcessRecordId } from './preview-process-record-key.mjs';

export function standardAlphaDeadFixture(t, { mode = 'unclaimed-v2', command } = {}) {
  const f = stoppedFixture(t);
  const oldRecordPath = f.config.recordPath;
  const oldCompletionPath = f.record.completionPath;
  const cwd = f.config.cwd;
  const port = 3011;
  const preloadPath = join(f.directory, 'virtual-port-3011.mjs');
  writeFileSync(
    preloadPath,
    `import net from 'node:net';\nconst orig = net.createConnection;\nnet.createConnection = function patched(...args) {\n  if (args[0] && typeof args[0] === 'object' && Number(args[0].port) === 3011) {\n    const socket = new net.Socket();\n    queueMicrotask(() => socket.destroy(Object.assign(new Error('ECONNREFUSED'), { code: 'ECONNREFUSED' })));\n    return socket;\n  }\n  return orig.apply(this, args);\n};\n`,
  );
  f.virtualPort3011PreloadUrl = pathToFileURL(preloadPath).href;
  const id = previewProcessRecordId(cwd, port);
  const completionPath = join(f.config.stateDir, `${id}.8d8b705b-c972-4c84-9c23-6e2f9a966aab.completion.json`);
  const stdAlphaRoot = join(f.directory, 'cat-cafe-alpha');
  const runtimeDir = join(f.directory, 'cat-cafe-runtime');
  mkdirSync(join(stdAlphaRoot, '.cat-cafe/redis'), { recursive: true });
  mkdirSync(runtimeDir, { recursive: true });
  writeFileSync(join(stdAlphaRoot, '.cat-cafe/redis/dump.rdb'), readFileSync(f.dumpFile));

  unlinkSync(oldRecordPath);
  renameSync(oldCompletionPath, completionPath);
  renameSync(`${oldCompletionPath}.owner.json`, `${completionPath}.owner.json`);

  f.stdAlphaRoot = stdAlphaRoot;
  f.config = {
    ...f.config,
    cwd,
    port,
    id,
    recordPath: join(f.config.stateDir, `${id}.json`),
    logPath: join(f.config.stateDir, `${id}.log`),
    launchdLabel: `com.catcafe.preview.${id}`,
    plistPath: join(f.config.stateDir, `${id}.plist`),
  };
  f.record = {
    ...f.record,
    id,
    cwd,
    port,
    command: command ?? ['pnpm', 'alpha:start', '--', '--no-quick'],
    completionPath,
    logPath: f.config.logPath,
  };

  if (mode === 'unclaimed-v2') {
    unlinkSync(`${completionPath}.owner.json`);
    f.completion = {
      ...f.completion,
      version: 2,
      exitCode: 128,
      commandExitCode: 128,
      runnerExitCode: 128,
      cleanupExitCode: null,
      cleanupOwnerStatus: 'unclaimed',
    };
  } else if (mode === 'unclaimed-legacy') {
    unlinkSync(`${completionPath}.owner.json`);
    f.completion = { ...f.completion, exitCode: 1, cleanupOwnerStatus: 'unclaimed' };
  } else if (mode === 'failed-owner-v2') {
    f.completion = {
      ...f.completion,
      version: 2,
      exitCode: 1,
      commandExitCode: 0,
      runnerExitCode: 1,
      cleanupExitCode: 1,
      cleanupOwnerStatus: 'complete',
    };
    f.owner = { ...f.owner, version: 2, exitCode: 1, commandExitCode: 0, cleanupExitCode: 1 };
    f.write(`${completionPath}.owner.json`, f.owner);
  } else if (mode === 'failed-owner-legacy') {
    f.completion = { ...f.completion, exitCode: 1, cleanupOwnerStatus: 'complete' };
    f.owner = { pid: f.owner.pid, processGroupId: f.owner.processGroupId, exitCode: 1 };
    f.write(`${completionPath}.owner.json`, f.owner);
  }

  f.write(f.config.recordPath, f.record);
  f.write(completionPath, f.completion);
  f.recovery.homeDir = f.directory;
  f.recovery.readHost = () => ({
    confidence: 'exact',
    facet: {
      runtime: { apiPort: 3002, worktree: join(f.directory, 'cat-cafe-runtime') },
      launcherPids: [4001],
      hostDependencies: [
        { port: 3001, pid: 4002 },
        { port: 6399, pid: 4003 },
      ],
      installation: { projectRoot: join(f.directory, 'cat-cafe-runtime'), deploymentId: 'runtime' },
    },
  });
  return f;
}
