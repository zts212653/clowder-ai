const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { after, test } = require('node:test');
const { compareRedisDirectory } = require('./redis-directory-diagnostic');

const root = mkdtempSync(join(tmpdir(), 'clowder-redis-directory-diagnostic-'));
const expected = join(root, 'desktop', 'data', 'redis');
const other = join(root, 'previous', 'data', 'redis');
const preload = join(root, 'redis-cli-preload.cjs');
const cli = join(__dirname, 'redis-directory-diagnostic.js');
const fakeRedisCli = join(root, 'fixture-redis-cli');
mkdirSync(expected, { recursive: true });
mkdirSync(other, { recursive: true });
// Keep the real CLI entrypoint and spawn options. Substitute only the Redis executable.
writeFileSync(
  preload,
  `const child = require('node:child_process');
const { writeFileSync } = require('node:fs');
const spawn = child.spawnSync;
child.spawnSync = (file, args, options) => {
  writeFileSync(process.env.FIXTURE_CALL, JSON.stringify({
    file, args, hasAuth: Object.hasOwn(options.env, 'REDISCLI_AUTH'),
  }));
  return spawn(process.execPath, ['-e', process.env.FIXTURE_REDIS_SCRIPT], options);
};
`,
);

after(() => rmSync(root, { recursive: true, force: true }));

test('distinguishes matching and different data directories', () => {
  assert.equal(compareRedisDirectory(expected, ['dir', expected]), 'directory_matches');
  assert.equal(compareRedisDirectory(expected, ['dir', other]), 'directory_mismatch');
});

test('canonicalizes a directory alias before comparing', () => {
  const alias = join(root, 'linked redis');
  symlinkSync(expected, alias, process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(compareRedisDirectory(expected, ['dir', alias]), 'directory_matches');
});

test('recognizes the drive path reported by the Windows Redis build', { skip: process.platform !== 'win32' }, () => {
  const reported = expected.replace(/^([a-z]):\\/i, '/cygdrive/$1/').replaceAll('\\', '/');
  assert.equal(compareRedisDirectory(expected, ['dir', reported]), 'directory_matches');
});

test('an unavailable, non-local or malformed directory is inconclusive', () => {
  for (const response of [null, ['dir', 'relative'], ['dir', join(root, 'missing')], ['dbfilename', other]]) {
    assert.equal(compareRedisDirectory(expected, response), 'directory_unknown');
  }
  assert.equal(compareRedisDirectory(join(root, 'missing'), ['dir', other]), 'directory_unknown');
});

function runCli(args, call, script) {
  return spawnSync(process.execPath, [...(call ? ['--require', preload] : []), cli, ...args], {
    encoding: 'utf8',
    timeout: 10_000,
    env: {
      ...process.env,
      REDISCLI_AUTH: 'synthetic-secret',
      ...(call ? { FIXTURE_CALL: call, FIXTURE_REDIS_SCRIPT: script } : {}),
    },
  });
}

test('the CLI probes only loopback with CONFIG GET dir and strips ambient authentication', () => {
  const call = join(root, 'valid-call.json');
  const script = `console.log(JSON.stringify(['dir', ${JSON.stringify(expected)}]))`;
  const result = runCli([join(root, 'desktop'), '16489', fakeRedisCli], call, script);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.deepEqual(JSON.parse(result.stdout), { port: 16489, status: 'directory_matches' });
  assert.deepEqual(JSON.parse(readFileSync(call, 'utf8')), {
    file: fakeRedisCli,
    args: ['-h', '127.0.0.1', '-p', '16489', '-2', '--json', 'CONFIG', 'GET', 'dir'],
    hasAuth: false,
  });
});

test('the CLI rejects invalid arguments before spawning a Redis client', () => {
  const call = join(root, 'invalid-call.json');
  const userData = join(root, 'desktop');
  for (const args of [
    ['relative', '16489', fakeRedisCli],
    [userData, '0', fakeRedisCli],
    [userData, '16489', ''],
  ]) {
    const result = runCli(args, call, '');
    assert.equal(existsSync(call), false, result.stderr);
    assert.equal(result.status, 2, result.stderr);
    assert.equal(result.stdout, '');
    assert.match(result.stderr.trim(), /^Usage: [^\r\n]+$/);
  }
});

test('the CLI reports unknown without leaking paths or child output', () => {
  const args = [join(root, 'desktop'), '16489', fakeRedisCli];
  const validOutput = JSON.stringify(JSON.stringify(['dir', expected]));
  const pathOutput = `console.error(${JSON.stringify(root)});`;
  const results = [
    runCli(args),
    runCli(args, join(root, 'invalid-output.json'), `console.log(${JSON.stringify(root)}); ${pathOutput}`),
    runCli(args, join(root, 'nonzero-exit.json'), `console.log(${validOutput}); ${pathOutput} process.exitCode = 1;`),
    runCli(args, join(root, 'excess-output.json'), `console.log(${validOutput}.padEnd(32 * 1024));`),
    runCli(args, join(root, 'timeout.json'), `${pathOutput} setTimeout(() => console.log(${validOutput}), 5000);`),
  ];
  for (const result of results) {
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    assert.deepEqual(JSON.parse(result.stdout), { port: 16489, status: 'directory_unknown' });
  }
});
