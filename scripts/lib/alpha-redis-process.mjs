import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { assertNamedAlphaCheckout, parseNamedAlphaCoordinates } from './alpha-coordinates.mjs';
import { alphaIdentityRefusal, captureAlphaIdentity } from './alpha-identity-diagnostics.mjs';
import { captureProcessIdentity, captureReadableIdentity, PROCESS_START_TIME_FORMAT } from './process-identity.mjs';

const REDIS_SUBJECT = 'Alpha Redis process';

function redisRefusal(expected, current, dataDirectory, mismatchMessage) {
  return alphaIdentityRefusal({
    subject: REDIS_SUBJECT,
    expected,
    current,
    required: { cwd: dataDirectory, ucomm: 'redis-server', startedAtFormat: PROCESS_START_TIME_FORMAT },
    mismatchMessage,
  });
}

function listenerPids(port, timeout = 2_000) {
  const output = execFileSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], {
    encoding: 'utf8',
    timeout,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
  const values = output.split('\n');
  if (!values.length || values.some((value) => !/^[1-9]\d*$/.test(value)))
    throw new Error('Redis listener identity is unreadable');
  return [...new Set(values.map(Number))];
}

// An unavailable observation supplies no identity evidence. Listener timeouts
// and verification against a readable stored argv share one full-scope reread,
// with one fixed extra second. Never replay a command or reuse partial fields.
// A conclusive mismatch or any other capture failure stops immediately.
function withIdentityReobservation(
  observe,
  { readListeners = listenerPids, observationNow = () => performance.now() } = {},
  reobserveArgv = false,
) {
  let deadline = Number.POSITIVE_INFINITY;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let listenerFailure;
    try {
      const value = observe((port) => {
        const remaining = Math.min(2_000, deadline - observationNow());
        if (remaining <= 0) throw new Error('Alpha Redis identity observation budget exhausted');
        try {
          return readListeners(port, Math.max(1, Math.floor(remaining)));
        } catch (error) {
          listenerFailure = error;
          throw error;
        }
      });
      if (observationNow() >= deadline) throw new Error('Alpha Redis identity observation budget exhausted');
      return value;
    } catch (error) {
      const listenerTimeout = error === listenerFailure && error?.code === 'ETIMEDOUT';
      const unavailableArgv = reobserveArgv && error?.code === 'ALPHA_IDENTITY_ARGV_UNAVAILABLE';
      if (attempt !== 0 || (!listenerTimeout && !unavailableArgv)) throw error;
      deadline = observationNow() + 1_000;
    }
  }
}

function redisScope(raw, { requireClean = true } = {}) {
  const coordinates = parseNamedAlphaCoordinates(raw);
  assertNamedAlphaCheckout(coordinates, { requireBuilds: true, requireTarget: true, requireClean });
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
function captureRedisIdentityOnce(raw, { readListeners = listenerPids, capture = captureReadableIdentity } = {}) {
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
  const identity = captureAlphaIdentity(pid, capture, REDIS_SUBJECT);
  if (!validRedisIdentity(identity, scope.dataDirectory))
    throw redisRefusal(
      undefined,
      identity,
      scope.dataDirectory,
      'Alpha Redis process identity does not match its new home',
    );
  return { v: 1, ...scope, pid, process: identity };
}

export function captureNamedAlphaRedisIdentity(raw, deps = {}) {
  return withIdentityReobservation((readListeners) => captureRedisIdentityOnce(raw, { ...deps, readListeners }), deps);
}

/** OS metadata must prove the same incarnation before PING, CONFIG, BGSAVE or shutdown is considered. */
function verifyRedisIdentityOnce(raw, proof, { readListeners = listenerPids, capture = captureProcessIdentity } = {}) {
  // Serving generators may change tracked files after capture. Reprove the
  // frozen checkout/build and process identity without reapplying launch cleanliness.
  const scope = redisScope(raw, { requireClean: false });
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
  const current = captureAlphaIdentity(proof.pid, capture, REDIS_SUBJECT);
  if (
    !validRedisIdentity(current, scope.dataDirectory) ||
    !validRedisIdentity(proof.process, scope.dataDirectory) ||
    current.startedAt !== proof.process.startedAt ||
    current.startedAtEpochMs !== proof.process.startedAtEpochMs ||
    current.command !== proof.process.command ||
    current.cwd !== proof.process.cwd
  )
    throw redisRefusal(proof.process, current, scope.dataDirectory, 'Alpha Redis process incarnation changed');
  return true;
}

export function verifyNamedAlphaRedisIdentity(raw, proof, deps = {}) {
  return withIdentityReobservation(
    (readListeners) => verifyRedisIdentityOnce(raw, proof, { ...deps, readListeners }),
    deps,
    proof?.process?.argvAvailable === true,
  );
}

function sendVerifiedRedisPing(port, run) {
  let response;
  try {
    response = run('redis-cli', ['-h', '127.0.0.1', '-p', String(port), '--raw', 'ping'], {
      encoding: 'utf8',
      timeout: 2_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch (cause) {
    throw new Error(`Alpha Redis PING failed after identity verification: ${cause.message}`, { cause });
  }
  if (response !== 'PONG') throw new Error(`Alpha Redis PING returned ${JSON.stringify(response)}`);
  return true;
}

/** Replace the launcher's one-second settling sleep with bounded fresh identity observations.
 * Only unavailable argv is retryable. Every observation rechecks the full scope/listener/incarnation;
 * a capture error or a conclusive mismatch stops immediately, and no observation grants future commands.
 * The original mandatory verification is separate from the one-second budget for extra observations.
 * Synchronous OS reads can overrun that budget, but a late retry never sends a command.
 */
export function pingNamedAlphaRedis(
  raw,
  proof,
  {
    readListeners = listenerPids,
    capture = captureProcessIdentity,
    now = () => performance.now(),
    sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms),
    run = execFileSync,
  } = {},
) {
  let deadline = Number.POSITIVE_INFINITY;
  let refusal;
  for (let attempt = 0; attempt < 10 && now() < deadline; attempt += 1) {
    try {
      // Startup already owns the argv settling allowance below; do not nest a
      // second argv retry inside it. Listener timeouts retain their own bound.
      withIdentityReobservation(
        (observeListeners) => verifyRedisIdentityOnce(raw, proof, { readListeners: observeListeners, capture }),
        { readListeners, observationNow: now },
      );
      refusal = undefined;
    } catch (error) {
      if (error.code !== 'ALPHA_IDENTITY_ARGV_UNAVAILABLE' || proof?.process?.argvAvailable !== true) throw error;
      refusal = error;
    }
    if (now() >= deadline) break;
    if (!refusal) return sendVerifiedRedisPing(proof.port, run);
    deadline = Math.min(deadline, now() + 1_000);
    if (attempt < 9) sleep(Math.min(20, Math.max(0, deadline - now())));
  }
  throw new Error(
    `Alpha Redis startup wait budget exhausted: ${refusal?.message ?? 'identity observation finished too late'}`,
    {
      cause: refusal,
    },
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const [command, raw, proof] = process.argv.slice(2);
    if (command === 'capture') process.stdout.write(`${JSON.stringify(captureNamedAlphaRedisIdentity(raw))}\n`);
    else if (command === 'verify') verifyNamedAlphaRedisIdentity(raw, JSON.parse(proof));
    else if (command === 'ping-ready') pingNamedAlphaRedis(raw, JSON.parse(proof));
    else throw new Error('Invalid Alpha Redis ownership operation');
  } catch (error) {
    process.stderr.write(`[alpha-redis-process] ${error.message}\n`);
    process.exitCode = 1;
  }
}
