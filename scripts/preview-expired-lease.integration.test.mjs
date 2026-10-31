import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { deriveNamedAlphaCoordinates, namedAlphaEnvironment } from './lib/alpha-coordinates.mjs';
import { namedAlphaFixture } from './lib/alpha-named-fixture.mjs';
import { captureNamedAlphaRedisIdentity, verifyNamedAlphaRedisIdentity } from './lib/alpha-redis-process.mjs';
import { waitForPreviewFixture } from './lib/preview-fixture-readiness.mjs';
import { previewProcessRecordId } from './lib/preview-process-record-key.mjs';
import { isProcessRunning } from './lib/process-tree.mjs';

const cli = fileURLToPath(new URL('./preview-process.mjs', import.meta.url));
const quote = (value) => `'${String(value).replaceAll("'", "'\\''")}'`;

// One real launcher/Redis journey protects wiring that the metadata fixture
// cannot prove: absent Redis leaves its original producer lease behind.
test(
  'real vanished Redis with complete failed owner settles through the original CLI without a new Redis command',
  {
    skip: process.platform === 'win32' && 'requires POSIX Bash and process groups',
  },
  async (t) => {
    const disposals = [];
    const f = namedAlphaFixture({ after: (dispose) => disposals.push(dispose) });
    const servers = [];
    for (let i = 0; i < 4; i++) {
      const server = createServer();
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      servers.push(server);
    }
    const ports = servers.map((server) => server.address().port);
    await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));
    const driver = join(f.directory, 'driver.sh');
    const entry = join(f.mainRoot, 'scripts/start-dev.sh');
    const source = readFileSync(entry, 'utf8');
    assert.ok(source.endsWith('main "$@"\n'));
    writeFileSync(entry, source.replace(/main "\$@"\n$/, `source ${quote(driver)}\n`));
    f.git(['add', 'scripts/start-dev.sh']);
    f.git(['commit', '-m', 'exercise absent Redis producer lease']);
    f.git(['push', 'origin', 'main']);
    f.git(['fetch', 'origin', 'main']);
    f.git(['merge', '--ff-only', 'origin/main'], f.alphaRoot);
    const head = f.git(['rev-parse', 'HEAD'], f.alphaRoot);
    f.preparedBuilds(head);
    const coordinates = deriveNamedAlphaCoordinates({
      mainRoot: f.mainRoot,
      instance: 'f290-communication',
      ports: ports.join(','),
      targetSha: head,
    });
    const raw = JSON.stringify(coordinates);
    const registryDir = join(f.directory, 'leases');
    const stateDir = join(f.directory, 'preview-state');
    const request = join(f.directory, 'expire-redis');
    const bin = join(f.directory, 'launcher-bin');
    mkdirSync(bin);
    const server = join(f.directory, 'server.cjs');
    writeFileSync(
      server,
      `require('node:http').createServer((q,s)=>s.end('expired-lease-fixture')).listen(${ports[0]},'127.0.0.1');`,
    );
    writeFileSync(
      driver,
      [
        'set -e',
        'setup_storage',
        'redis-cli -p "$REDIS_PORT" set archived-key retained-value',
        'redis-cli -p "$REDIS_PORT" save',
        `${quote(process.execPath)} ${quote(server)} &`,
        'register_managed_pid "$!"',
        `while [ ! -f ${quote(request)} ]; do sleep 0.1; done`,
        // Only this owned fixture makes its Redis disappear before cleanup. The
        // canonical metadata retry below must never send or invent this command.
        'redis-cli -p "$REDIS_PORT" shutdown nosave',
        'exit 1',
        '',
      ].join('\n'),
    );
    const environment = {
      ...namedAlphaEnvironment(coordinates),
      CAT_CAFE_ALPHA_REDIS_REGISTRY_DIR: registryDir,
      CAT_CAFE_SKIP_NODE_RUNTIME_GUARD: '1',
    };
    writeFileSync(
      join(bin, 'pnpm'),
      [
        '#!/bin/bash',
        'set -e',
        '[ "$1" = alpha:start ] || exit 64',
        ...Object.entries(environment).map(([key, value]) => `export ${key}=${quote(value)}`),
        `cd ${quote(f.alphaRoot)}`,
        'exec /bin/bash ./scripts/start-dev.sh --quick',
        '',
      ].join('\n'),
      { mode: 0o755 },
    );
    const env = {
      ...process.env,
      HOME: f.env.HOME,
      PATH: `${bin}:${process.env.PATH}`,
      CAT_CAFE_PREVIEW_PROCESS_DIR: stateDir,
      CAT_CAFE_ALPHA_REDIS_REGISTRY_DIR: registryDir,
    };
    const run = (action, extra = []) =>
      spawnSync(process.execPath, [cli, action, '--port', String(ports[0]), '--cwd', f.mainRoot, '--json', ...extra], {
        env,
        encoding: 'utf8',
        timeout: 45000,
      });
    const id = previewProcessRecordId(f.mainRoot, ports[0]);
    const recordPath = join(stateDir, `${id}.json`);
    let proof, record;
    t.after(() => {
      if (proof && isProcessRunning(proof.pid) === true) {
        verifyNamedAlphaRedisIdentity(raw, proof);
        execFileSync('redis-cli', ['-h', '127.0.0.1', '-p', String(ports[3]), 'shutdown', 'save'], { timeout: 5000 });
      }
      if (record?.origin === 'launchd')
        spawnSync('launchctl', ['bootout', `gui/${process.getuid()}/${record.launchdLabel}`]);
      for (const dispose of disposals) dispose();
    });
    const started = run('start', [
      '--',
      'pnpm',
      'alpha:start',
      '--',
      '--instance',
      coordinates.instance,
      '--ports',
      ports.join(','),
    ]);
    assert.equal(started.status, 0, started.stderr || started.stdout);
    record = JSON.parse(readFileSync(recordPath));
    await waitForPreviewFixture({
      port: ports[0],
      expectedBody: 'expired-lease-fixture',
      deadline: performance.now() + 45000,
      diagnostics: () => readFileSync(record.logPath, 'utf8').slice(-5000),
    });
    proof = captureNamedAlphaRedisIdentity(raw);
    writeFileSync(request, 'make this owned Redis disappear before owner cleanup\n');
    const deadline = performance.now() + 35000;
    while (
      (!existsSync(record.completionPath) || isProcessRunning(record.pid) !== false) &&
      performance.now() < deadline
    )
      await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(isProcessRunning(record.pid), false);
    assert.equal(isProcessRunning(proof.pid), false);
    const originalFailure = readFileSync(record.completionPath);
    const originalOwner = readFileSync(`${record.completionPath}.owner.json`);
    assert.equal(JSON.parse(originalFailure).cleanupExitCode, 1);
    assert.equal(JSON.parse(originalFailure).cleanupOwnerStatus, 'complete');
    const leases = readdirSync(registryDir);
    assert.equal(leases.length, 1);
    const lease = readFileSync(join(registryDir, leases[0]));
    // A tripwire installed only after the fixture failure proves the canonical
    // metadata retry does not run redis-cli. Keep CLI env/caller unchanged.
    const tripwire = join(f.directory, 'unexpected-redis-command');
    writeFileSync(join(bin, 'redis-cli'), `#!/bin/sh\nprintf called > ${quote(tripwire)}\nexit 99\n`, { mode: 0o755 });
    const settled = run('stop');
    assert.equal(settled.status, 0, settled.stderr || settled.stdout);
    const summary = JSON.parse(settled.stdout).settlement;
    assert.equal(summary.leaseStatus, 'retired');
    assert.equal(summary.cleanupExitCode, 1);
    assert.equal(summary.persistenceStatus, 'not_reverified');
    assert.equal('shutdownExitCode' in summary, false);
    assert.equal(existsSync(tripwire), false);
    assert.deepEqual(readdirSync(registryDir), []);
    assert.equal(existsSync(recordPath), false);
    assert.deepEqual(readFileSync(record.completionPath), originalFailure);
    assert.deepEqual(readFileSync(`${record.completionPath}.owner.json`), originalOwner);
    assert.deepEqual(readFileSync(join(summary.journalPath, 'lease.json')), lease);
    const journal = JSON.parse(readFileSync(join(summary.journalPath, 'result.json')));
    assert.ok(journal.data.some((data) => data.path.endsWith('.manifest')));
    assert.ok(journal.data.some((data) => data.path.endsWith('.aof')));
    assert.ok(journal.data.some((data) => data.path.endsWith('dump.rdb')));
    for (const data of journal.data) assert.deepEqual(readFileSync(data.savedPath), readFileSync(data.path));
    const status = run('status');
    assert.equal(status.status, 1, status.stderr);
    assert.deepEqual(JSON.parse(status.stdout).settlement, summary);
    const repeated = run('stop');
    assert.equal(repeated.status, 0, repeated.stderr);
    assert.deepEqual(JSON.parse(repeated.stdout).settlement, summary);
    assert.equal(existsSync(tripwire), false);
  },
);
