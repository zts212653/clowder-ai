#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { randomInt } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  cleanupStaleRedisTestLeases,
  PROTECTED_REDIS_TEST_PORTS,
  redisTestRegistryDir,
  removeRedisTestLease,
  writeRedisTestLease,
} from '../../../scripts/lib/redis-test-leases.mjs';
import { runTestCommand, spawnTracked, stopTracked } from './redis-test-processes.mjs';

const exec = promisify(execFile);
const scriptDir = dirname(fileURLToPath(import.meta.url));
const apiDir = dirname(scriptDir);

function positiveInteger(value, label) {
  const parsed = Number(value);
  if (!/^[0-9]+$/u.test(value) || !Number.isSafeInteger(parsed) || parsed < 1) {
    throw Object.assign(new Error(`invalid ${label}: ${value}`), { exitCode: 2 });
  }
  return parsed;
}

function parseArguments(argv) {
  let repeat = 1;
  while (argv[0] === '--repeat') {
    repeat = positiveInteger(argv[1], '--repeat value');
    argv = argv.slice(2);
  }
  if (argv[0] === '--') argv = argv.slice(1);
  let port;
  if (process.env.REDIS_TEST_PORT) {
    port = positiveInteger(process.env.REDIS_TEST_PORT, 'Redis test port');
    if (port > 65535 || PROTECTED_REDIS_TEST_PORTS.has(port)) {
      throw Object.assign(new Error(`refusing invalid or protected Redis port: ${port}`), { exitCode: 2 });
    }
  }
  return { repeat, port, command: argv.length ? argv : ['pnpm', 'test'] };
}

function testFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const name = join(directory, entry.name);
    return entry.isDirectory()
      ? testFiles(name)
      : entry.isFile() && /\.test\.(?:js|cjs|mjs|ts)$/u.test(name)
        ? [name]
        : [];
  });
}

async function redisCommand(port, args, signal) {
  return (
    await exec('redis-cli', ['--raw', '-h', '127.0.0.1', '-p', String(port), ...args], {
      timeout: 500,
      signal,
      encoding: 'utf8',
      maxBuffer: 64 * 1024,
    })
  ).stdout.trim();
}

async function awaitRedis(instance, dataDir, signal) {
  const deadline = performance.now() + 5000;
  while (performance.now() < deadline) {
    signal.throwIfAborted();
    if (instance.process.ended) throw new Error(`Redis exited before readiness on port ${instance.port}`);
    let pong, info, directory;
    try {
      pong = await redisCommand(instance.port, ['PING'], signal);
      info = await redisCommand(instance.port, ['INFO', 'server'], signal);
      directory = await redisCommand(instance.port, ['CONFIG', 'GET', 'dir'], signal);
    } catch (error) {
      signal.throwIfAborted();
      if (error.code === 'ENOENT') throw error;
      await delay(50, undefined, { signal });
      continue;
    }
    const pid = Number(info.match(/^process_id:(\d+)\r?$/mu)?.[1]);
    const returnedDir = directory.split(/\r?\n/u)[1];
    if (pong !== 'PONG' || pid !== instance.process.child.pid || returnedDir !== dataDir) {
      throw new Error(`Redis endpoint ownership mismatch on port ${instance.port}`);
    }
    if (instance.process.ended) throw new Error('Redis exited during readiness');
    return;
  }
  throw new Error(`Redis readiness timeout on port ${instance.port}`);
}

async function stopInstance(instance, registryDir) {
  if (!instance) return;
  await stopTracked(instance.process);
  if (instance.lease) removeRedisTestLease(instance.lease, registryDir);
}

async function allocateRedis(resources, { dataDir, registryDir, explicitPort, testFileCount, signal }) {
  const logfile = join(dataDir, 'redis.log');
  for (let attempt = 0; attempt < (explicitPort ? 1 : 30); attempt++) {
    signal.throwIfAborted();
    const port = explicitPort ?? randomInt(6300, 7000);
    if (PROTECTED_REDIS_TEST_PORTS.has(port)) continue;
    writeFileSync(logfile, '');
    resources.instance = {
      port,
      process: spawnTracked(
        'redis-server',
        [
          '--bind',
          '127.0.0.1',
          '--port',
          String(port),
          '--databases',
          String(15 + testFileCount),
          '--dir',
          dataDir,
          '--dbfilename',
          'dump.rdb',
          '--save',
          '',
          '--appendonly',
          'no',
          '--daemonize',
          'no',
          '--logfile',
          logfile,
        ],
        { stdio: 'ignore' },
      ),
    };
    try {
      // Capture the spawned process before readiness, so a killed runner leaves
      // reclaimable identity evidence. This lease is not endpoint readiness.
      if (!resources.instance.process.child.pid) {
        await resources.instance.process.done;
        throw resources.instance.process.result.error;
      }
      resources.instance.lease = writeRedisTestLease({
        port,
        redisPid: resources.instance.process.child.pid,
        dataDir,
        ownerPid: process.pid,
        registryDir,
      });
      await awaitRedis(resources.instance, dataDir, signal);
      break;
    } catch (error) {
      await stopInstance(resources.instance, registryDir);
      resources.instance = null;
      signal.throwIfAborted();
      const bindCollision = /Address already in use/iu.test(readFileSync(logfile, 'utf8'));
      if (explicitPort || !bindCollision || attempt === 29) throw error;
    }
  }
  if (!resources.instance) throw new Error('failed to allocate an isolated Redis port');
}

function reportRedisLog(dataDir) {
  try {
    console.error(readFileSync(join(dataDir, 'redis.log'), 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') console.error(`[redis-test] cannot read Redis log: ${error.message}`);
  }
}

async function runRepeatedCommand(command, repeat, env, signal) {
  for (let run = 1; run <= repeat; run++) {
    console.log(`[redis-test] run ${run}/${repeat}: ${command.join(' ')}`);
    const result = await runTestCommand(command, { cwd: apiDir, env, signal });
    if (result) return result;
  }
  return 0;
}

async function main() {
  const { repeat, port: explicitPort, command } = parseArguments(process.argv.slice(2));
  const registryDir = redisTestRegistryDir();
  const stale = cleanupStaleRedisTestLeases(registryDir);
  for (const lease of [...stale.live, ...stale.unknown])
    console.error(`[redis-test] preserving lease on port ${lease.port}`);
  for (const file of stale.invalidFiles) console.error(`[redis-test] invalid lease metadata preserved: ${file}`);

  const controller = new AbortController();
  let exitCode = 0;
  let resultCode = 0;
  let stopping = false;
  const cancel = (signal) => {
    exitCode = signal === 'SIGINT' ? 130 : 143;
    controller.abort(new Error(`received ${signal}`));
  };
  const intHandler = () => cancel('SIGINT');
  const termHandler = () => cancel('SIGTERM');
  const fatal = (error) => {
    if (exitCode === 0) exitCode = 1;
    console.error(`[redis-test] ${error instanceof Error ? error.message : String(error)}`);
    controller.abort(error instanceof Error ? error : new Error(String(error)));
  };
  process.on('SIGINT', intHandler);
  process.on('SIGTERM', termHandler);
  process.on('uncaughtException', fatal);
  process.on('unhandledRejection', fatal);
  let dataDir;
  const resources = { instance: null };
  try {
    dataDir = realpathSync(mkdtempSync(join(tmpdir(), 'cat-cafe-redis-test.')));
    const files = testFiles(join(apiDir, 'test')).sort();
    if (files.length === 0) throw new Error('failed to build test-file DB manifest');
    const manifest = join(dataDir, 'test-files.txt');
    writeFileSync(manifest, `${files.join('\n')}\n`);
    await allocateRedis(resources, {
      dataDir,
      registryDir,
      explicitPort,
      testFileCount: files.length,
      signal: controller.signal,
    });
    const env = {
      ...process.env,
      REDIS_URL: `redis://127.0.0.1:${resources.instance.port}/15`,
      CAT_CAFE_REDIS_TEST_ISOLATED: '1',
      CAT_CAFE_REDIS_TEST_DB_MANIFEST: manifest,
      NODE_OPTIONS: `--import=${join(scriptDir, 'redis-test-db-namespace.mjs')}${process.env.NODE_OPTIONS ? ` ${process.env.NODE_OPTIONS}` : ''}`,
    };
    console.log(`[redis-test] isolated redis started: ${env.REDIS_URL}`);
    resources.instance.process.done.then(() => {
      if (!stopping) fatal(new Error('Redis exited while test command was running'));
    });
    resultCode = await runRepeatedCommand(command, repeat, env, controller.signal);
  } catch (error) {
    console.error(`[redis-test] ${error.message}`);
    if (dataDir) reportRedisLog(dataDir);
    resultCode = error.exitCode || (error.code === 'ENOENT' ? 127 : 1);
  } finally {
    stopping = true;
    try {
      await stopInstance(resources.instance, registryDir);
      if (dataDir) rmSync(dataDir, { recursive: true, force: true });
    } finally {
      process.off('SIGINT', intHandler);
      process.off('SIGTERM', termHandler);
      process.off('uncaughtException', fatal);
      process.off('unhandledRejection', fatal);
    }
  }
  return exitCode || resultCode;
}

try {
  process.exitCode = await main();
} catch (error) {
  console.error(`[redis-test] ${error.message}`);
  process.exitCode = error.exitCode || 1;
}
