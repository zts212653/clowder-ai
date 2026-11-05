import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { previewProcessRecordId } from './lib/preview-process-record-key.mjs';
import { waitForPort } from './lib/preview-process-runtime.mjs';
import { launchWithLaunchd, removeLaunchdJob } from './preview-process-launchers.mjs';

for (const [legacy, natural, aliased] of [
  [true, false],
  [false, false],
  [false, true],
  [false, false, true],
])
  test(`actual ${legacy ? 'published legacy' : 'current v2'} runner ${natural ? 'naturally exits zero' : 'stops'} a once-ready ordinary service ${aliased ? 'through a cwd alias ' : ''}with a limited receipt`, async (t) => {
    assert.equal(process.platform, 'darwin', 'owned launchd fixture must run on its supported host');
    const rawRoot = mkdtempSync(join(tmpdir(), 'ordinary-unclaimed-'));
    const physicalRoot = realpathSync(rawRoot);
    const root = aliased ? rawRoot : physicalRoot,
      stateDir = join(physicalRoot, 'state');
    if (aliased)
      assert.notEqual(root, physicalRoot, 'this host fixture exercises the native temporary-directory alias');
    mkdirSync(stateDir);
    const port = await new Promise((resolve) => {
      const s = net.createServer();
      s.listen(0, '127.0.0.1', () => {
        const p = s.address().port;
        s.close(() => resolve(p));
      });
    });
    const id = previewProcessRecordId(root, port),
      recordPath = join(stateDir, `${id}.json`),
      completionPath = join(stateDir, `${id}.${randomUUID()}.completion.json`);
    const config = {
      cwd: root,
      port,
      id,
      stateDir,
      recordPath,
      logPath: join(stateDir, `${id}.log`),
      launchdLabel: `com.catcafe.preview.${id}`,
      plistPath: join(stateDir, `${id}.plist`),
    };
    const env = { ...process.env, HOME: root, CAT_CAFE_PREVIEW_PROCESS_DIR: stateDir };
    // This fixture is an isolated, unhosted installation. Host conflicts are tested separately.
    delete env.CAT_CAFE_DEPLOYMENT_ID;
    delete env.CAT_CAFE_RUNTIME_ROOT;
    const source = join(root, 'source.cjs'),
      data = join(root, 'work.json');
    writeFileSync(data, '{"work":"fixture-work","date":"2026-10-27"}\n');
    writeFileSync(
      source,
      `require('node:fs').writeFileSync(${JSON.stringify(join(root, 'app.pid'))},String(process.pid));const server=require('node:http').createServer((q,r)=>{r.end(require('node:fs').readFileSync(${JSON.stringify(data)}));if(q.url==='/finish')server.close(()=>process.exit(0));});server.listen(${port},'127.0.0.1');\n`,
    );
    let runner = fileURLToPath(new URL('./preview-process-lease-runner.mjs', import.meta.url));
    if (legacy) {
      const archive = execFileSync('git', [
        'archive',
        'eacafbd7a108fb676c1c10c5234fda971666d8d0',
        'scripts/preview-process-lease-runner.mjs',
        'scripts/lib/preview-process-runtime.mjs',
        'scripts/lib/preview-cleanup-result.mjs',
      ]);
      const restored = spawnSync('tar', ['-xf', '-', '-C', root], { input: archive });
      assert.equal(restored.status, 0);
      runner = join(root, 'scripts/preview-process-lease-runner.mjs');
    }
    const expiresAt = new Date(Date.now() + 60000).toISOString(),
      command = [process.execPath, source];
    const handle = await launchWithLaunchd({
      ...config,
      command: [
        process.execPath,
        runner,
        '--expires-at',
        expiresAt,
        '--completion-path',
        completionPath,
        '--',
        ...command,
      ],
    });
    const record = {
      version: 1,
      id,
      cwd: root,
      port,
      command,
      ...handle,
      startedAt: new Date().toISOString(),
      expiresAt,
      completionPath,
      logPath: config.logPath,
    };
    const invoke = (action) =>
      spawnSync(
        process.execPath,
        [
          fileURLToPath(new URL('./preview-process.mjs', import.meta.url)),
          action,
          '--cwd',
          root,
          '--port',
          String(port),
          '--json',
        ],
        { cwd: root, encoding: 'utf8', timeout: 15000, env },
      );
    t.after(() => {
      removeLaunchdJob(config);
      if (existsSync(join(root, 'app.pid'))) {
        const pid = Number(readFileSync(join(root, 'app.pid'), 'utf8'));
        const ps = spawnSync('ps', ['-ww', '-p', String(pid), '-o', 'command='], { encoding: 'utf8' });
        if (ps.status === 0 && ps.stdout.includes(source))
          try {
            process.kill(pid, 'SIGTERM');
          } catch {}
      }
      rmSync(root, { recursive: true, force: true });
    });
    assert.equal(await waitForPort(port, true, 5000), true, readFileSync(config.logPath, 'utf8'));
    assert.deepEqual(await (await fetch(`http://127.0.0.1:${port}`)).json(), {
      work: 'fixture-work',
      date: '2026-10-27',
    });
    record.readyAt = new Date().toISOString();
    writeFileSync(recordPath, JSON.stringify(record) + '\n');
    if (natural) {
      await (await fetch(`http://127.0.0.1:${port}/finish`)).text();
      const deadline = Date.now() + 5000;
      while (!existsSync(completionPath) && Date.now() < deadline)
        await new Promise((resolve) => setTimeout(resolve, 20));
      assert.ok(existsSync(completionPath), 'natural exit publishes its actual completion');
    }
    const before = readFileSync(data),
      stopped = invoke('stop');
    assert.equal(stopped.status, 3, stopped.stderr || stopped.stdout);
    const receipt = JSON.parse(stopped.stdout).settlement,
      completion = JSON.parse(readFileSync(completionPath));
    assert.equal(Object.hasOwn(completion, 'version'), !legacy);
    assert.equal(completion.cleanupOwnerStatus, 'unclaimed');
    assert.equal(completion.exitCode, natural ? 0 : 1);
    assert.equal(receipt.businessExitCode, natural ? 0 : null);
    assert.equal(receipt.cleanupExitCode, null);
    assert.equal(receipt.commandGroupStatus, legacy ? 'unverified' : 'absent');
    assert.equal(receipt.otherResourcesStatus, 'not_reverified');
    assert.equal(receipt.persistenceStatus, 'not_reverified');
    assert.equal(existsSync(recordPath), false);
    assert.equal(await waitForPort(port, false, 1000), true);
    assert.deepEqual(readFileSync(data), before);
    assert.equal(invoke('status').status, 3);
    assert.equal(invoke('stop').status, 3);
  });
