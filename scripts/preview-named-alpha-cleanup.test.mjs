import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { dirname, join } from 'node:path';
import { test as nodeTest } from 'node:test';
import { fileURLToPath } from 'node:url';
import { deriveNamedAlphaCoordinates, namedAlphaEnvironment } from './lib/alpha-coordinates.mjs';
import { namedAlphaFixture } from './lib/alpha-named-fixture.mjs';
import { readNamedAlphaRedisLeases } from './lib/alpha-redis-leases.mjs';
import { captureNamedAlphaRedisIdentity, verifyNamedAlphaRedisIdentity } from './lib/alpha-redis-process.mjs';
import { waitForPreviewFixture } from './lib/preview-fixture-readiness.mjs';

const cli = join(dirname(fileURLToPath(import.meta.url)), 'preview-process.mjs');
const test =
  process.platform === 'win32'
    ? (name, fn) => nodeTest(name, { skip: 'Requires POSIX process groups and Bash cleanup traps' }, fn)
    : nodeTest;

function identityProbeFixture(directory, port, pidFile, mode) {
  if (!mode) return null;
  const bin = join(directory, 'identity-probe-bin');
  mkdirSync(bin);
  const armed = join(directory, 'identity-probe-armed');
  const observed = join(directory, 'identity-probe-failures');
  const argv = mode.startsWith('argv-');
  const command = argv ? 'ps' : 'lsof';
  const native = execFileSync('which', [command], { encoding: 'utf8' }).trim();
  const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
  writeFileSync(
    join(bin, command),
    `#!/bin/sh
target=false
${
  argv
    ? `previous= selected_pid= command_read=false
for arg do
  [ "$previous" != -p ] || selected_pid="$arg"
  [ "$arg" != command= ] || command_read=true
  previous="$arg"
done
if [ "$command_read" = true ] && [ -f ${quote(pidFile)} ]; then
  IFS= read -r fixture_pid < ${quote(pidFile)}
  [ "$selected_pid" != "$fixture_pid" ] || target=true
fi`
    : `for arg do [ "$arg" != '-iTCP:${port}' ] || target=true; done`
}
if [ "$target" = true ] && [ -f ${quote(armed)} ] &&
   { ${mode.endsWith('always') ? 'true' : `[ ! -f ${quote(observed)} ]`}; }; then
  printf '%s\\n' ${quote(argv ? 'argv unavailable' : 'timeout')} >> ${quote(observed)}
  ${argv ? "printf '%s\\n' '(redis-server)'; exit 0" : 'exec sleep 10'}
fi
# Keep healthy native observations within their real identity budget; a Node
# wrapper for every ps/lsof call adds unrelated startup time to the retry.
exec ${quote(native)} "$@"
`,
    { mode: 0o755 },
  );
  return { bin, armed, observed };
}

for (const [verificationFails, earlyWrapper, missingResult, pnpmWrapper, identityFailureMode, trackedServingChange] of [
  [false, false, false],
  [false, false, false, false, undefined, true],
  [true, false, false],
  [false, true, false],
  [true, true, false],
  [false, true, true],
  [false, false, false, true],
  [true, false, false, true],
  [false, false, false, false, 'listener-once'],
  [false, false, false, false, 'listener-always'],
  [false, false, false, false, 'argv-once'],
  [false, false, false, false, 'argv-always'],
]) {
  const cleanupRefused = verificationFails || identityFailureMode?.endsWith('always');
  test(`canonical preview stop ${cleanupRefused ? 'reports refused Redis cleanup and retains ownership' : 'saves Redis and releases the producer lease'}${trackedServingChange ? ' after tracked serving changes' : ''}${earlyWrapper ? ' after an early wrapper exit' : ''}${missingResult ? ' but rejects an unpublished owner result' : ''}${pnpmWrapper ? ' through real pnpm' : ''}${identityFailureMode ? ` after ${identityFailureMode}` : ''}`, async (t) => {
    const disposals = [];
    const f = namedAlphaFixture({ after: (fn) => disposals.push(fn) });
    const sockets = [];
    for (let index = 0; index < 4; index += 1) {
      const socket = net.createServer();
      await new Promise((resolve) => socket.listen(0, '127.0.0.1', resolve));
      sockets.push(socket);
    }
    const ports = sockets.map((socket) => socket.address().port);
    await Promise.all(sockets.map((socket) => new Promise((resolve) => socket.close(resolve))));
    // Exercise the actual launcher/storage/cleanup code. Only replace application
    // startup with a private HTTP child; no build, model invocation or shared DB.
    const entry = join(f.mainRoot, 'scripts/start-dev.sh');
    const source = readFileSync(entry, 'utf8');
    assert.ok(source.endsWith('main "$@"\n'));
    writeFileSync(entry, source.replace(/main "\$@"\n$/, 'source "$ALPHA_TEST_DRIVER"\n'));
    writeFileSync(
      join(f.mainRoot, 'package.json'),
      JSON.stringify({ private: true, scripts: { start: 'bash ./scripts/start-dev.sh --quick' } }),
    );
    f.git(['add', 'scripts/start-dev.sh', 'package.json']);
    f.git(['commit', '-m', 'exercise real managed Alpha cleanup']);
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
    const directory = join(f.alphaRoot, '.cat-cafe/redis');
    const pidFile = join(directory, `redis-${coordinates.ports.redis}.pid`);
    const registry = join(f.directory, 'leases');
    const driver = join(f.directory, 'driver.sh');
    const probe = identityProbeFixture(f.directory, coordinates.ports.redis, pidFile, identityFailureMode);
    const readinessBody = createHash('sha256').update(f.directory).digest('hex');
    writeFileSync(
      join(f.directory, 'server.cjs'),
      `require('node:http').createServer((q,s)=>s.end(${JSON.stringify(readinessBody)})).listen(${ports[0]},'127.0.0.1');`,
    );
    writeFileSync(
      driver,
      `set -e
setup_storage
redis-cli -p "$REDIS_PORT" set preview-cleanup-marker preserved
${verificationFails ? 'named_alpha_redis_is_owned() { return 1; }' : ''}
${missingResult ? 'publish_preview_cleanup_result() { :; }' : ''}
${probe ? `touch '${probe.armed}'` : ''}
"${process.execPath}" "${join(f.directory, 'server.cjs')}" &
register_managed_pid "$!"
wait
`,
    );
    const env = { ...process.env, CAT_CAFE_PREVIEW_PROCESS_DIR: join(f.directory, 'preview-state') };
    const id = createHash('sha256').update(`${f.alphaRoot}\0${ports[0]}`).digest('hex').slice(0, 16);
    const recordPath = join(env.CAT_CAFE_PREVIEW_PROCESS_DIR, `${id}.json`);
    let previewRecord;
    let redisProof;
    const run = (action, extra = []) =>
      spawnSync(process.execPath, [cli, action, '--port', String(ports[0]), '--cwd', f.alphaRoot, '--json', ...extra], {
        env,
        encoding: 'utf8',
        timeout: 45_000,
      });
    let cleanupProven = false;
    t.after(() => {
      run('stop');
      // A failed regression must still keep data and never bypass identity proof.
      if (existsSync(pidFile)) {
        const proof = redisProof ?? captureNamedAlphaRedisIdentity(raw);
        verifyNamedAlphaRedisIdentity(raw, proof);
        execFileSync('redis-cli', ['-h', '127.0.0.1', '-p', String(coordinates.ports.redis), 'shutdown', 'save']);
      }
      if (previewRecord?.origin === 'launchd') {
        spawnSync('launchctl', ['bootout', `gui/${process.getuid()}/${previewRecord.launchdLabel}`]);
      }
      if (cleanupProven) for (const dispose of disposals) dispose();
    });
    const assignments = Object.entries({
      ...namedAlphaEnvironment(coordinates),
      HOME: f.env.HOME,
      PATH: probe ? `${probe.bin}:${process.env.PATH}` : process.env.PATH,
      CAT_CAFE_SKIP_NODE_RUNTIME_GUARD: '1',
      CAT_CAFE_ALPHA_REDIS_REGISTRY_DIR: registry,
      ALPHA_TEST_DRIVER: driver,
    }).map(([key, value]) => `${key}=${value}`);
    const wrapper = join(f.directory, 'wrapper.cjs');
    writeFileSync(
      wrapper,
      `const {spawn}=require('node:child_process');
spawn('/bin/bash',['./scripts/start-dev.sh','--quick'],{stdio:'inherit'});
process.on('SIGTERM',()=>process.exit(143));
setInterval(()=>{},1000);`,
    );
    const launcher = earlyWrapper
      ? [process.execPath, wrapper]
      : pnpmWrapper
        ? ['pnpm', 'run', 'start']
        : ['/bin/bash', './scripts/start-dev.sh', '--quick'];
    const startupDeadline = performance.now() + 45_000;
    const started = run('start', ['--', '/usr/bin/env', ...assignments, ...launcher]);
    assert.equal(started.status, 0, started.stderr || started.stdout);
    previewRecord = JSON.parse(readFileSync(recordPath, 'utf8'));
    await waitForPreviewFixture({
      port: ports[0],
      expectedBody: readinessBody,
      deadline: startupDeadline,
      diagnostics: () =>
        JSON.stringify({
          start: started.stdout,
          stderr: started.stderr,
          record: previewRecord,
          logTail: existsSync(previewRecord.logPath)
            ? readFileSync(previewRecord.logPath, 'utf8').slice(-8_000)
            : 'log missing',
        }),
    });
    const proof = captureNamedAlphaRedisIdentity(raw);
    redisProof = proof;
    verifyNamedAlphaRedisIdentity(raw, proof);
    assert.equal(readdirSync(registry).length, 1, 'producer registered its own Redis lease');
    if (trackedServingChange) {
      writeFileSync(join(f.alphaRoot, 'packages/web/package.json'), '{"generatedDuringServing":true}\n');
      assert.throws(() => captureNamedAlphaRedisIdentity(raw), /tracked changes/);
      verifyNamedAlphaRedisIdentity(raw, proof);
      const leases = readNamedAlphaRedisLeases(registry);
      assert.deepEqual(leases.rejected, []);
      assert.equal(leases.live.length, 1, 'serving generation does not erase the owner lease');
    }
    const stopped = run('stop');
    if (probe) assert.ok(existsSync(probe.observed), 'exercise the native identity probe failure');
    if (cleanupRefused) {
      assert.equal(stopped.status, 1, stopped.stderr || stopped.stdout);
      verifyNamedAlphaRedisIdentity(raw, proof);
      assert.equal(readdirSync(registry).length, 1, 'failed cleanup preserves the original lease');
      assert.equal(existsSync(recordPath), true, 'failed cleanup preserves the preview record');
      cleanupProven = true;
      return;
    }
    assert.equal(stopped.status, missingResult ? 1 : 0, stopped.stderr || stopped.stdout);
    assert.equal(existsSync(recordPath), missingResult, 'missing owner result retains preview evidence');
    assert.equal(existsSync(pidFile), false, 'Redis must have exited before stopped');
    assert.deepEqual(readdirSync(registry), [], 'producer must release its own Redis lease');
    const rdb = readFileSync(join(directory, 'dump.rdb'));
    assert.ok(rdb.includes(Buffer.from('preview-cleanup-marker')), 'shutdown save preserves the written key');
    assert.ok(rdb.includes(Buffer.from('preserved')));
    cleanupProven = true;
  });
}
