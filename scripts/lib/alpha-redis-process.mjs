import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { assertNamedAlphaCheckout, parseNamedAlphaCoordinates } from './alpha-coordinates.mjs';
import { captureProcessIdentity, captureReadableIdentity, PROCESS_START_TIME_FORMAT } from './process-identity.mjs';

function listenerPids(port) {
  const output = execFileSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], {
    encoding: 'utf8',
    timeout: 2_000,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
  const values = output.split('\n');
  if (!values.length || values.some((value) => !/^[1-9]\d*$/.test(value)))
    throw new Error('Redis listener identity is unreadable');
  return [...new Set(values.map(Number))];
}

function redisScope(raw) {
  const coordinates = parseNamedAlphaCoordinates(raw);
  assertNamedAlphaCheckout(coordinates, { requireBuilds: true, requireTarget: true });
  const dataDirectory = join(coordinates.alphaRoot, '.cat-cafe/redis');
  if (realpathSync(dataDirectory) !== dataDirectory) throw new Error('Redis directory is not its exact Alpha home');
  return { projectRoot: coordinates.alphaRoot, dataDirectory, port: coordinates.ports.redis };
}

function validRedisIdentity(identity, dataDirectory) {
  return (
    identity.argvAvailable === true &&
    identity.ucomm === 'redis-server' &&
    identity.cwd === dataDirectory &&
    identity.startedAtFormat === PROCESS_START_TIME_FORMAT &&
    Number.isSafeInteger(identity.startedAtEpochMs) &&
    typeof identity.startedAt === 'string' &&
    /^\S*redis-server\s/.test(identity.command)
  );
}

/** Capture only the actual listener spawned into the selected new directory; never sends a Redis command. */
export function captureNamedAlphaRedisIdentity(
  raw,
  { readListeners = listenerPids, capture = captureReadableIdentity } = {},
) {
  const scope = redisScope(raw);
  const pidFile = join(scope.dataDirectory, `redis-${scope.port}.pid`);
  const before = lstatSync(pidFile);
  if (!before.isFile() || before.isSymbolicLink() || before.size > 32 || realpathSync(pidFile) !== pidFile)
    throw new Error('Alpha Redis pidfile is not a bounded regular file');
  const rawPid = readFileSync(pidFile, 'utf8').trim();
  const after = lstatSync(pidFile);
  if (
    !/^[1-9]\d*$/.test(rawPid) ||
    after.ino !== before.ino ||
    after.dev !== before.dev ||
    after.mtimeMs !== before.mtimeMs
  )
    throw new Error('Alpha Redis pidfile changed');
  const pid = Number(rawPid);
  const listeners = readListeners(scope.port);
  if (listeners.length !== 1 || listeners[0] !== pid)
    throw new Error('Alpha Redis listener does not match the spawned pidfile');
  const identity = capture(pid);
  if (!validRedisIdentity(identity, scope.dataDirectory))
    throw new Error('Alpha Redis process identity does not match its new home');
  return { v: 1, ...scope, pid, process: identity };
}

/** OS metadata must prove the same incarnation before PING, CONFIG, BGSAVE or shutdown is considered. */
export function verifyNamedAlphaRedisIdentity(
  raw,
  proof,
  { readListeners = listenerPids, capture = captureProcessIdentity } = {},
) {
  const scope = redisScope(raw);
  if (
    !proof ||
    proof.v !== 1 ||
    proof.projectRoot !== scope.projectRoot ||
    proof.dataDirectory !== scope.dataDirectory ||
    proof.port !== scope.port ||
    !Number.isSafeInteger(proof.pid) ||
    proof.pid <= 1 ||
    !proof.process
  )
    throw new Error('Alpha Redis ownership proof is missing or changed');
  const listeners = readListeners(scope.port);
  if (listeners.length !== 1 || listeners[0] !== proof.pid) throw new Error('Alpha Redis listener was replaced');
  const current = capture(proof.pid);
  if (
    !validRedisIdentity(current, scope.dataDirectory) ||
    !validRedisIdentity(proof.process, scope.dataDirectory) ||
    current.startedAt !== proof.process.startedAt ||
    current.startedAtEpochMs !== proof.process.startedAtEpochMs ||
    current.command !== proof.process.command ||
    current.cwd !== proof.process.cwd
  )
    throw new Error('Alpha Redis process incarnation changed');
  return true;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const [command, raw, proof] = process.argv.slice(2);
    if (command === 'capture') process.stdout.write(`${JSON.stringify(captureNamedAlphaRedisIdentity(raw))}\n`);
    else if (command === 'verify') verifyNamedAlphaRedisIdentity(raw, JSON.parse(proof));
    else throw new Error('Invalid Alpha Redis ownership operation');
  } catch (error) {
    process.stderr.write(`[alpha-redis-process] ${error.message}\n`);
    process.exitCode = 1;
  }
}
