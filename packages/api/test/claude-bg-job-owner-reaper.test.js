import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, statSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ClaudeBgCarrierService } from '../dist/domains/cats/services/agents/providers/ClaudeBgCarrierService.js';
import { reapStaleClaudeBgJobOwners } from '../dist/utils/claude-bg-job-owner-reaper.js';
import {
  activateClaudeBgJobOwner,
  createClaudeBgJobOwnerManifest,
  parseClaudeBgJobOwnerManifest,
} from '../dist/utils/claude-bg-job-ownership.js';
import { isProcessAlive } from './helpers/process-liveness.js';

async function waitUntil(predicate, timeoutMs = 4_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return Boolean(await predicate());
}

function forceCleanup(pid) {
  if (!isProcessAlive(pid)) return;
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    // Already gone.
  }
}

async function readWorkerPid(registryDirectory, shortId) {
  const record = JSON.parse(await readFile(join(registryDirectory, `${shortId}.json`), 'utf8'));
  return record.workerPid;
}

async function launchUnrelatedJob(fixturePath, registryDirectory, shortId) {
  const child = spawn(fixturePath, ['--bg'], {
    env: { ...process.env, CLAUDE_CONFIG_DIR: registryDirectory, FAKE_CLAUDE_BG_ID: shortId },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
  });
  const exitCode = await new Promise((resolve) => child.once('close', resolve));
  assert.equal(exitCode, 0, stderr);
  return readWorkerPid(registryDirectory, shortId);
}

const silentLog = { info() {}, warn() {} };
const REAPER_TEST_STOP_TIMEOUT_MS = 2_000;

test(
  'unparseable dispatcher acknowledgement retains the pending record and never guesses a process target',
  { skip: process.platform === 'win32' && 'Unix ownership tokens are not available on Windows' },
  async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'cat-cafe-claude-bg-bad-dispatch-'));
    const registryDirectory = await mkdtemp(join(tmpdir(), 'cat-cafe-claude-bg-bad-registry-'));
    const fixturePath = fileURLToPath(new URL('./fixtures/fake-claude-bg-cli.js', import.meta.url));
    const shortId = 'bad00001';
    chmodSync(fixturePath, 0o755);
    const service = new ClaudeBgCarrierService({
      claudeCommand: fixturePath,
      model: 'claude-fixture',
      ownerDataDir: dataDir,
      ownerKillGraceMs: 100,
      l0CompilerFn: async ({ outPath }) => writeFile(outPath, 'fixture-l0'),
    });
    let workerPid;
    try {
      await assert.rejects(
        () =>
          service.startJob('bad dispatcher', {
            callbackEnv: {
              CLAUDE_CONFIG_DIR: registryDirectory,
              FAKE_CLAUDE_BG_ID: shortId,
              FAKE_CLAUDE_BG_BAD_OUTPUT: '1',
            },
          }),
        /Could not parse short id/,
      );
      workerPid = await readWorkerPid(registryDirectory, shortId);
      assert.equal(isProcessAlive(workerPid), true, 'unknown native job identity must not be signalled');
      await new Promise((resolve) => setTimeout(resolve, 250));
      assert.equal((await readdir(join(dataDir, 'claude-bg-job-owners'))).length, 1);
    } finally {
      forceCleanup(workerPid);
      await rm(dataDir, { recursive: true, force: true });
      await rm(registryDirectory, { recursive: true, force: true });
    }
  },
);

test(
  'startup recovery stops the exact stale Claude bg job after its dispatcher and API owner die',
  { skip: process.platform === 'win32' && 'Unix ownership tokens are not available on Windows' },
  async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'cat-cafe-claude-bg-owner-'));
    const registryDirectory = await mkdtemp(join(tmpdir(), 'cat-cafe-claude-bg-registry-'));
    const helperReadyPath = join(dataDir, 'helper-ready.json');
    const ownedShortId = 'a11ce001';
    const unrelatedShortId = 'b22bb002';
    const fixturePath = fileURLToPath(new URL('./fixtures/fake-claude-bg-cli.js', import.meta.url));
    const serviceUrl = pathToFileURL(
      fileURLToPath(
        new URL('../dist/domains/cats/services/agents/providers/ClaudeBgCarrierService.js', import.meta.url),
      ),
    ).href;
    chmodSync(fixturePath, 0o755);
    const helperScript = [
      'const { writeFileSync } = await import("node:fs");',
      `const { ClaudeBgCarrierService } = await import(${JSON.stringify(serviceUrl)});`,
      'const service = new ClaudeBgCarrierService({',
      `  claudeCommand: ${JSON.stringify(fixturePath)},`,
      '  model: "claude-fixture",',
      `  ownerDataDir: ${JSON.stringify(dataDir)},`,
      '  ownerKillGraceMs: 100,',
      '  l0CompilerFn: async ({ outPath }) => writeFileSync(outPath, "fixture-l0"),',
      '});',
      'const result = await service.startJob("owned job", { callbackEnv: {',
      `  CLAUDE_CONFIG_DIR: ${JSON.stringify(registryDirectory)},`,
      `  FAKE_CLAUDE_BG_ID: ${JSON.stringify(ownedShortId)},`,
      '  FAKE_CLAUDE_BG_DAEMON_SHAPED: "1",',
      '} });',
      `writeFileSync(${JSON.stringify(helperReadyPath)}, JSON.stringify({ shortId: result.shortId }));`,
      'setInterval(() => {}, 60_000);',
    ].join('\n');

    let helper;
    let ownedWorkerPid;
    let unrelatedWorkerPid;
    let daemonPid;
    try {
      helper = spawn(process.execPath, ['--input-type=module', '-e', helperScript], {
        env: process.env,
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      let helperStderr = '';
      helper.stderr.on('data', (chunk) => {
        helperStderr += chunk.toString();
      });
      assert.equal(await waitUntil(() => existsSync(helperReadyPath)), true, helperStderr);
      ownedWorkerPid = await readWorkerPid(registryDirectory, ownedShortId);
      unrelatedWorkerPid = await launchUnrelatedJob(fixturePath, registryDirectory, unrelatedShortId);
      daemonPid = JSON.parse(await readFile(join(registryDirectory, 'daemon.json'), 'utf8')).daemonPid;
      assert.equal(isProcessAlive(ownedWorkerPid), true);
      assert.equal(isProcessAlive(unrelatedWorkerPid), true);
      assert.equal(isProcessAlive(daemonPid), true);

      const ownerDirectory = join(dataDir, 'claude-bg-job-owners');
      assert.equal(await waitUntil(() => existsSync(ownerDirectory)), true);
      const [manifestName] = await readdir(ownerDirectory);
      const manifest = JSON.parse(await readFile(join(ownerDirectory, manifestName), 'utf8'));
      assert.equal(manifest.shortId, ownedShortId, 'short-lived dispatcher must activate the durable job record');
      assert.deepEqual(manifest.stopContext, { claudeConfigDir: registryDirectory });
      assert.equal(statSync(ownerDirectory).mode & 0o777, 0o700);
      assert.equal(statSync(join(ownerDirectory, manifestName)).mode & 0o777, 0o600);

      const liveRecovery = await reapStaleClaudeBgJobOwners({
        dataDir,
        claudeCommand: fixturePath,
        killGraceMs: REAPER_TEST_STOP_TIMEOUT_MS,
        log: silentLog,
      });
      assert.equal(liveRecovery.skippedActiveOwners, 1);
      assert.equal(liveRecovery.stopAttempts, 0, 'startup recovery must not stop a job whose API owner is live');
      assert.equal(isProcessAlive(ownedWorkerPid), true);

      helper.kill('SIGKILL');
      await new Promise((resolve) => helper.once('exit', resolve));
      assert.equal(isProcessAlive(ownedWorkerPid), true, 'owned worker should outlive its dispatcher and API owner');

      const recovery = await reapStaleClaudeBgJobOwners({
        dataDir,
        claudeCommand: fixturePath,
        killGraceMs: REAPER_TEST_STOP_TIMEOUT_MS,
        log: silentLog,
      });

      assert.equal(recovery.reapedOwners, 1);
      assert.equal(recovery.stopAttempts, 1);
      assert.equal(await waitUntil(() => !isProcessAlive(ownedWorkerPid)), true);
      assert.equal(isProcessAlive(unrelatedWorkerPid), true, 'recovery must not stop an unrelated Claude bg job');
      assert.equal(isProcessAlive(daemonPid), true, 'native stop must not terminate the shared daemon');
      assert.equal(existsSync(join(registryDirectory, `${unrelatedShortId}.json`)), true);
      assert.deepEqual(await readdir(ownerDirectory), []);
    } finally {
      helper?.kill('SIGKILL');
      forceCleanup(ownedWorkerPid);
      forceCleanup(unrelatedWorkerPid);
      forceCleanup(daemonPid);
      await rm(dataDir, { recursive: true, force: true });
      await rm(registryDirectory, { recursive: true, force: true });
    }
  },
);

test(
  'startup recovery retains an active manifest when stop fails and no token membership was observed',
  { skip: process.platform === 'win32' && 'Unix ownership tokens are not available on Windows' },
  async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'cat-cafe-claude-bg-uncertain-'));
    const registryDirectory = await mkdtemp(join(tmpdir(), 'cat-cafe-claude-bg-empty-registry-'));
    const fixturePath = fileURLToPath(new URL('./fixtures/fake-claude-bg-cli.js', import.meta.url));
    chmodSync(fixturePath, 0o755);
    try {
      const owner = createClaudeBgJobOwnerManifest(dataDir);
      activateClaudeBgJobOwner(owner, 'fade0001');
      const staleManifest = {
        ...owner.manifest,
        apiOwner: { ...owner.manifest.apiOwner, pid: 99_999_999 },
        stopContext: { claudeConfigDir: registryDirectory },
      };
      await writeFile(owner.path, `${JSON.stringify(staleManifest)}\n`, 'utf8');

      const recovery = await reapStaleClaudeBgJobOwners({
        dataDir,
        claudeCommand: fixturePath,
        killGraceMs: REAPER_TEST_STOP_TIMEOUT_MS,
        log: silentLog,
      });

      assert.equal(recovery.stopAttempts, 1);
      assert.equal(recovery.stopFailures, 1);
      assert.equal(recovery.retainedOwners, 1);
      assert.equal(existsSync(owner.path), true, 'uncertain recovery must retain its durable retry record');
    } finally {
      await rm(dataDir, { recursive: true, force: true });
      await rm(registryDirectory, { recursive: true, force: true });
    }
  },
);

test(
  'startup recovery retains a stale pending record without signalling a token-shaped process',
  { skip: process.platform === 'win32' && 'Unix ownership tokens are not available on Windows' },
  async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'cat-cafe-claude-bg-pending-'));
    const helperReadyPath = join(dataDir, 'pending-ready.json');
    const ownershipUrl = pathToFileURL(
      fileURLToPath(new URL('../dist/utils/claude-bg-job-ownership.js', import.meta.url)),
    ).href;
    const helperScript = [
      'const { spawn } = await import("node:child_process");',
      'const { writeFileSync } = await import("node:fs");',
      `const { createClaudeBgJobOwnerManifest } = await import(${JSON.stringify(ownershipUrl)});`,
      `const owner = createClaudeBgJobOwnerManifest(${JSON.stringify(dataDir)});`,
      'const worker = spawn(process.execPath, ["-e", "process.on(\\"SIGTERM\\",()=>process.exit(0));setInterval(()=>{},60000)"], {',
      '  detached: true, stdio: "ignore",',
      '  env: { ...process.env, CAT_CAFE_PROCESS_OWNER_ID: owner.manifest.ownerId },',
      '});',
      'worker.unref();',
      `writeFileSync(${JSON.stringify(helperReadyPath)}, JSON.stringify({ workerPid: worker.pid }));`,
      'setInterval(() => {}, 60_000);',
    ].join('\n');

    let helper;
    let workerPid;
    try {
      helper = spawn(process.execPath, ['--input-type=module', '-e', helperScript], {
        env: process.env,
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      let helperStderr = '';
      helper.stderr.on('data', (chunk) => {
        helperStderr += chunk.toString();
      });
      assert.equal(await waitUntil(() => existsSync(helperReadyPath)), true, helperStderr);
      workerPid = JSON.parse(await readFile(helperReadyPath, 'utf8')).workerPid;
      assert.equal(isProcessAlive(workerPid), true);

      helper.kill('SIGKILL');
      await new Promise((resolve) => helper.once('exit', resolve));
      const recovery = await reapStaleClaudeBgJobOwners({
        dataDir,
        killGraceMs: REAPER_TEST_STOP_TIMEOUT_MS,
        log: silentLog,
      });

      assert.equal(recovery.stopAttempts, 0, 'pending records have no semantic job id to stop');
      assert.equal(recovery.reapedOwners, 0);
      assert.equal(recovery.retainedOwners, 1);
      assert.equal(
        isProcessAlive(workerPid),
        true,
        'Claude recovery must not treat a process env token as job identity',
      );
      assert.equal((await readdir(join(dataDir, 'claude-bg-job-owners'))).length, 1);
    } finally {
      helper?.kill('SIGKILL');
      forceCleanup(workerPid);
      await rm(dataDir, { recursive: true, force: true });
    }
  },
);

test('manifest stop context accepts only the non-secret Claude config namespace', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'cat-cafe-claude-bg-context-'));
  try {
    const owner = createClaudeBgJobOwnerManifest(dataDir);
    const safe = {
      ...owner.manifest,
      stopContext: { claudeConfigDir: join(dataDir, 'profile') },
    };
    assert.deepEqual(parseClaudeBgJobOwnerManifest(safe)?.stopContext, safe.stopContext);
    assert.equal(
      parseClaudeBgJobOwnerManifest({
        ...safe,
        stopContext: { ...safe.stopContext, ANTHROPIC_API_KEY: 'secret' },
      }),
      null,
    );
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test(
  'abort retains an active manifest when native stop is nonzero and leaves worker plus daemon alive',
  { skip: process.platform === 'win32' && 'Unix durable ownership is not available on Windows' },
  async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'cat-cafe-claude-bg-abort-'));
    const registryDirectory = await mkdtemp(join(tmpdir(), 'cat-cafe-claude-bg-abort-profile-'));
    const fixturePath = fileURLToPath(new URL('./fixtures/fake-claude-bg-cli.js', import.meta.url));
    const shortId = 'ab07ab07';
    chmodSync(fixturePath, 0o755);
    await writeFile(join(registryDirectory, 'stop-fail'), '1');
    const stopEnvironments = [];
    const spawnFn = (command, args, options) => {
      if (args[0] === 'stop') stopEnvironments.push(options.env);
      return spawn(command, args, options);
    };
    const service = new ClaudeBgCarrierService({
      claudeCommand: fixturePath,
      spawnFn,
      enableJobOwnership: true,
      model: 'claude-fixture',
      ownerDataDir: dataDir,
      jobsDir: join(dataDir, 'jobs'),
      pollMs: 10,
      ownerKillGraceMs: 1_000,
      l0CompilerFn: async ({ outPath }) => writeFile(outPath, 'fixture-l0'),
    });
    const controller = new AbortController();
    let workerPid;
    let daemonPid;
    try {
      const invocation = (async () => {
        for await (const _message of service.invoke('abort me', {
          signal: controller.signal,
          accountEnv: {
            CLAUDE_CONFIG_DIR: registryDirectory,
            FAKE_CLAUDE_BG_ID: shortId,
            FAKE_CLAUDE_BG_DAEMON_SHAPED: '1',
          },
        })) {
          // No terminal messages are expected before abort.
        }
      })();
      assert.equal(await waitUntil(() => existsSync(join(registryDirectory, `${shortId}.json`))), true);
      const ownerDirectory = join(dataDir, 'claude-bg-job-owners');
      assert.equal(
        await waitUntil(async () => {
          if (!existsSync(ownerDirectory)) return false;
          const [manifestName] = await readdir(ownerDirectory);
          if (!manifestName) return false;
          return JSON.parse(await readFile(join(ownerDirectory, manifestName), 'utf8')).state === 'active';
        }),
        true,
      );
      workerPid = await readWorkerPid(registryDirectory, shortId);
      daemonPid = JSON.parse(await readFile(join(registryDirectory, 'daemon.json'), 'utf8')).daemonPid;
      controller.abort();
      await assert.rejects(invocation, /aborted/);
      assert.equal(stopEnvironments.length, 1);
      assert.equal(stopEnvironments[0].CLAUDE_CONFIG_DIR, registryDirectory);
      assert.equal(stopEnvironments[0].CAT_CAFE_PROCESS_OWNER_ID, undefined);
      assert.equal(await waitUntil(() => existsSync(join(registryDirectory, `stop-attempt-${shortId}.json`))), true);
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.equal((await readdir(ownerDirectory)).length, 1);
      assert.equal(isProcessAlive(workerPid), true);
      assert.equal(isProcessAlive(daemonPid), true);
    } finally {
      forceCleanup(workerPid);
      forceCleanup(daemonPid);
      await rm(dataDir, { recursive: true, force: true });
      await rm(registryDirectory, { recursive: true, force: true });
    }
  },
);

test(
  'UI turn completion retains ownership until stale recovery stops the exact live daemon job',
  { skip: process.platform === 'win32' && 'Unix durable ownership is not available on Windows' },
  async (t) => {
    const fixturePath = fileURLToPath(new URL('./fixtures/fake-claude-bg-cli.js', import.meta.url));
    const serviceUrl = pathToFileURL(
      fileURLToPath(
        new URL('../dist/domains/cats/services/agents/providers/ClaudeBgCarrierService.js', import.meta.url),
      ),
    ).href;
    chmodSync(fixturePath, 0o755);

    const cases = [
      { name: 'blocked', shortId: 'b10c0001', unrelatedShortId: 'b10c0002', state: 'blocked' },
      {
        name: 'working plus turn_duration',
        shortId: '7a7d0001',
        unrelatedShortId: '7a7d0002',
        state: 'working',
      },
    ];

    for (const scenario of cases) {
      await t.test(scenario.name, async () => {
        const dataDir = await mkdtemp(join(tmpdir(), 'cat-cafe-claude-bg-ui-turn-'));
        const registryDirectory = await mkdtemp(join(tmpdir(), 'cat-cafe-claude-bg-ui-profile-'));
        const jobsDirectory = join(dataDir, 'jobs');
        const jobDirectory = join(jobsDirectory, scenario.shortId);
        const helperReadyPath = join(dataDir, 'helper-ready.json');
        const transcriptPath = join(dataDir, `${scenario.shortId}-transcript.jsonl`);
        const state = {
          state: scenario.state,
          daemonShort: scenario.shortId,
          ...(scenario.state === 'blocked'
            ? { detail: 'awaiting user go-ahead', needs: 'confirm whether to continue' }
            : { linkScanPath: transcriptPath }),
        };
        await mkdir(jobDirectory, { recursive: true });
        await writeFile(join(jobDirectory, 'state.json'), `${JSON.stringify(state)}\n`);
        if (scenario.state === 'working') {
          await writeFile(
            transcriptPath,
            `${[
              JSON.stringify({
                type: 'assistant',
                message: { role: 'assistant', content: [{ type: 'text', text: 'turn complete' }] },
              }),
              JSON.stringify({ type: 'system', subtype: 'turn_duration', durationMs: 42 }),
            ].join('\n')}\n`,
          );
        }

        const helperScript = [
          'const { writeFileSync } = await import("node:fs");',
          `const { ClaudeBgCarrierService } = await import(${JSON.stringify(serviceUrl)});`,
          'const service = new ClaudeBgCarrierService({',
          `  claudeCommand: ${JSON.stringify(fixturePath)},`,
          '  model: "claude-fixture",',
          `  ownerDataDir: ${JSON.stringify(dataDir)},`,
          `  jobsDir: ${JSON.stringify(jobsDirectory)},`,
          '  pollMs: 10,',
          '  ownerKillGraceMs: 100,',
          '  l0CompilerFn: async ({ outPath }) => writeFileSync(outPath, "fixture-l0"),',
          '});',
          'const types = [];',
          'for await (const event of service.invoke("owned job", { accountEnv: {',
          `  CLAUDE_CONFIG_DIR: ${JSON.stringify(registryDirectory)},`,
          `  FAKE_CLAUDE_BG_ID: ${JSON.stringify(scenario.shortId)},`,
          '  FAKE_CLAUDE_BG_DAEMON_SHAPED: "1",',
          '} })) types.push(event.type);',
          `writeFileSync(${JSON.stringify(helperReadyPath)}, JSON.stringify({ types }));`,
          'setInterval(() => {}, 60_000);',
        ].join('\n');

        let helper;
        let ownedWorkerPid;
        let unrelatedWorkerPid;
        let daemonPid;
        try {
          helper = spawn(process.execPath, ['--input-type=module', '-e', helperScript], {
            env: process.env,
            stdio: ['ignore', 'ignore', 'pipe'],
          });
          let helperStderr = '';
          helper.stderr.on('data', (chunk) => {
            helperStderr += chunk.toString();
          });
          assert.equal(await waitUntil(() => existsSync(helperReadyPath)), true, helperStderr);
          const helperResult = JSON.parse(await readFile(helperReadyPath, 'utf8'));
          assert.equal(helperResult.types.at(-1), 'done', 'UI turn must complete without waiting for job shutdown');

          ownedWorkerPid = await readWorkerPid(registryDirectory, scenario.shortId);
          unrelatedWorkerPid = await launchUnrelatedJob(fixturePath, registryDirectory, scenario.unrelatedShortId);
          daemonPid = JSON.parse(await readFile(join(registryDirectory, 'daemon.json'), 'utf8')).daemonPid;
          assert.equal(isProcessAlive(ownedWorkerPid), true, 'owned worker remains live after UI turn completion');
          assert.equal(isProcessAlive(unrelatedWorkerPid), true);
          assert.equal(isProcessAlive(daemonPid), true);

          const ownerDirectory = join(dataDir, 'claude-bg-job-owners');
          const manifests = await readdir(ownerDirectory);
          assert.equal(manifests.length, 1, 'live native job must retain its durable recovery manifest');
          const manifest = JSON.parse(await readFile(join(ownerDirectory, manifests[0]), 'utf8'));
          assert.equal(manifest.state, 'active');
          assert.equal(manifest.shortId, scenario.shortId);

          helper.kill('SIGKILL');
          await new Promise((resolve) => helper.once('exit', resolve));
          const recovery = await reapStaleClaudeBgJobOwners({
            dataDir,
            claudeCommand: fixturePath,
            killGraceMs: REAPER_TEST_STOP_TIMEOUT_MS,
            log: silentLog,
          });

          assert.equal(recovery.stopAttempts, 1);
          assert.equal(recovery.reapedOwners, 1);
          assert.equal(await waitUntil(() => !isProcessAlive(ownedWorkerPid)), true);
          assert.equal(isProcessAlive(unrelatedWorkerPid), true, 'recovery must not stop an unrelated job');
          assert.equal(isProcessAlive(daemonPid), true, 'recovery must not stop the shared daemon');
        } finally {
          helper?.kill('SIGKILL');
          forceCleanup(ownedWorkerPid);
          forceCleanup(unrelatedWorkerPid);
          forceCleanup(daemonPid);
          await rm(dataDir, { recursive: true, force: true });
          await rm(registryDirectory, { recursive: true, force: true });
        }
      });
    }
  },
);
