import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
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

for (const mode of ['identity-failure', 'business-failure', 'legacy-outcome'])
  test(
    mode === 'identity-failure'
      ? 'real failed named cleanup resumes from canonical stop, saves Redis and preserves the failed owner evidence'
      : `real ${mode} saves and stops Redis, then canonical stop settles registration without data actions`,
    { skip: process.platform === 'win32' && 'requires POSIX Bash and process groups' },
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
      f.git(['commit', '-m', 'exercise real failed named cleanup recovery']);
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
      const armed = join(f.directory, 'fault-armed');
      const businessExit = join(f.directory, 'request-business-failure');
      const faultBin = join(f.directory, 'fault-bin');
      const bin = join(f.directory, 'launcher-bin');
      mkdirSync(faultBin);
      mkdirSync(bin);
      const nativeLsof = execFileSync('which', ['lsof'], { encoding: 'utf8' }).trim();
      // Only the owned launcher's final per-command identity check times out.
      // The canonical CLI environment is unchanged between both stop calls.
      writeFileSync(
        join(faultBin, 'lsof'),
        [
          '#!/bin/sh',
          'for arg do',
          `  if [ "$arg" = '-iTCP:${ports[3]}' ] && [ -f ${quote(armed)} ]; then exec sleep 10; fi`,
          'done',
          `exec ${quote(nativeLsof)} "$@"`,
          '',
        ].join('\n'),
        { mode: 0o755 },
      );
      const server = join(f.directory, 'server.cjs');
      const body = createHash('sha256').update(f.directory).digest('hex');
      writeFileSync(
        server,
        `require('node:http').createServer((q,s)=>s.end('${body}')).listen(${ports[0]},'127.0.0.1');`,
      );
      writeFileSync(
        driver,
        [
          'set -e',
          'setup_storage',
          'redis-cli -p "$REDIS_PORT" set recovery-test-key retained-value',
          ...(mode === 'identity-failure'
            ? [
                'eval "$(declare -f redis-cli | sed \'1s/redis-cli/fixture_verified_redis_cli/\')"',
                'redis-cli() {',
                '  local arg',
                `  for arg do [ "$arg" != shutdown ] || touch ${quote(armed)}; done`,
                '  fixture_verified_redis_cli "$@"',
                '}',
              ]
            : []),
          `${quote(process.execPath)} ${quote(server)} &`,
          'register_managed_pid "$!"',
          mode === 'identity-failure' ? 'wait' : `while [ ! -f ${quote(businessExit)} ]; do sleep 0.1; done\nexit 1`,
          '',
        ].join('\n'),
      );
      const environment = {
        ...namedAlphaEnvironment(coordinates),
        CAT_CAFE_ALPHA_REDIS_REGISTRY_DIR: registryDir,
        CAT_CAFE_SKIP_NODE_RUNTIME_GUARD: '1',
        PATH: `${faultBin}:${process.env.PATH}`,
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
        spawnSync(
          process.execPath,
          [cli, action, '--port', String(ports[0]), '--cwd', f.mainRoot, '--json', ...extra],
          {
            env,
            encoding: 'utf8',
            timeout: 45000,
          },
        );
      const id = previewProcessRecordId(f.mainRoot, ports[0]);
      const recordPath = join(stateDir, `${id}.json`);
      let proof;
      let record;
      t.after(() => {
        if (proof) {
          const observed = spawnSync('lsof', ['-nP', `-iTCP:${ports[3]}`, '-sTCP:LISTEN', '-t'], {
            encoding: 'utf8',
            timeout: 3000,
          });
          if (observed.status === 0) {
            verifyNamedAlphaRedisIdentity(raw, proof);
            execFileSync('redis-cli', ['-h', '127.0.0.1', '-p', String(ports[3]), 'shutdown', 'save'], {
              timeout: 5000,
            });
          } else assert.equal(observed.status, 1, 'fixture listener absence must be observable');
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
      record = JSON.parse(readFileSync(recordPath, 'utf8'));
      await waitForPreviewFixture({
        port: ports[0],
        expectedBody: body,
        deadline: performance.now() + 45000,
        diagnostics: () => readFileSync(record.logPath, 'utf8').slice(-8000),
      });
      proof = captureNamedAlphaRedisIdentity(raw);
      if (mode === 'identity-failure') {
        const failed = run('stop');
        assert.equal(failed.status, 1, failed.stderr || failed.stdout);
        assert.match(readFileSync(record.logPath, 'utf8'), /spawnSync lsof ETIMEDOUT/);
      } else {
        writeFileSync(businessExit, 'fail the owned application after readiness\n');
        const deadline = performance.now() + 35000;
        while (
          (!existsSync(record.completionPath) || isProcessRunning(record.pid) !== false) &&
          performance.now() < deadline
        )
          await new Promise((resolve) => setTimeout(resolve, 100));
        assert.ok(existsSync(record.completionPath), 'natural failure publishes completion');
        assert.equal(isProcessRunning(record.pid), false);
        const completion = JSON.parse(readFileSync(record.completionPath, 'utf8'));
        assert.equal(completion.commandExitCode, 1);
        assert.equal(completion.cleanupExitCode, 0);
        const replacement = run('start', [
          '--',
          'pnpm',
          'alpha:start',
          '--',
          '--instance',
          coordinates.instance,
          '--ports',
          ports.join(','),
        ]);
        assert.equal(replacement.status, 1);
        assert.match(replacement.stderr, /cleanup remains unsettled/);
      }
      if (mode === 'legacy-outcome') {
        // Only this owned fixture is rewritten to the pre-versioned producer
        // format after all processes exit. The real consumer evidence is read-only.
        const completion = JSON.parse(readFileSync(record.completionPath, 'utf8'));
        const owner = JSON.parse(readFileSync(`${record.completionPath}.owner.json`, 'utf8'));
        for (const key of ['version', 'commandExitCode', 'cleanupExitCode', 'runnerExitCode']) delete completion[key];
        for (const key of ['version', 'commandExitCode', 'cleanupExitCode']) delete owner[key];
        owner.exitCode = 1;
        writeFileSync(record.completionPath, JSON.stringify(completion));
        writeFileSync(`${record.completionPath}.owner.json`, JSON.stringify(owner));
      }
      const originalFailure = readFileSync(record.completionPath);
      const originalOwner = readFileSync(`${record.completionPath}.owner.json`);
      assert.equal(JSON.parse(originalFailure).exitCode, 1);
      assert.equal(readdirSync(registryDir).length, mode === 'identity-failure' ? 1 : 0);
      const beforeRdb = mode !== 'identity-failure' ? readFileSync(join(proof.dataDirectory, 'dump.rdb')) : null;
      const recovered = run('stop');
      assert.equal(recovered.status, 0, recovered.stderr || recovered.stdout);
      assert.equal(JSON.parse(recovered.stdout).status, 'stopped');
      if (mode !== 'identity-failure') {
        const settlement = JSON.parse(recovered.stdout).settlement;
        assert.equal(settlement.originalExitCode, 1);
        assert.equal(settlement.businessExitCode, mode === 'business-failure' ? 1 : null);
        assert.equal(settlement.cleanupExitCode, mode === 'business-failure' ? 0 : null);
        assert.equal(settlement.persistenceStatus, 'not_reverified');
        assert.deepEqual(readFileSync(join(proof.dataDirectory, 'dump.rdb')), beforeRdb);
      }
      assert.equal(existsSync(recordPath), false);
      assert.deepEqual(readdirSync(registryDir), []);
      assert.deepEqual(readFileSync(record.completionPath), originalFailure);
      assert.deepEqual(readFileSync(`${record.completionPath}.owner.json`), originalOwner);
      const rdb = readFileSync(join(proof.dataDirectory, 'dump.rdb'));
      assert.ok(rdb.includes(Buffer.from('recovery-test-key')));
      assert.ok(rdb.includes(Buffer.from('retained-value')));
      const status = run('status');
      assert.equal(JSON.parse(status.stdout).registered, false);
    },
  );
