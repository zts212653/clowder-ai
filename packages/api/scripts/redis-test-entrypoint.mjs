#!/usr/bin/env node
import { readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { isSelfOrDescendantOf } from '../../../scripts/lib/process-tree.mjs';
import {
  inspectExpectedProcess,
  inspectLeaseOwner,
  PROTECTED_REDIS_TEST_PORTS,
  readRedisTestLeases,
} from '../../../scripts/lib/redis-test-leases.mjs';
import { readRedisTestManifest } from './redis-test-db-namespace.mjs';

// The sandbox may re-enter inside pnpm test. Preserve only an endpoint issued
// by a still-live ancestor runner, never an arbitrary inherited URL or flag.
function runnerEndpoint() {
  const redisUrl = process.env.REDIS_URL;
  const parsed = new URL(redisUrl);
  const port = Number(parsed.port);
  const database = Number(parsed.pathname.slice(1));
  if (
    parsed.protocol !== 'redis:' ||
    parsed.hostname !== '127.0.0.1' ||
    !Number.isSafeInteger(port) ||
    port < 1 ||
    PROTECTED_REDIS_TEST_PORTS.has(port) ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    !/^\/\d+$/u.test(parsed.pathname) ||
    !Number.isSafeInteger(database) ||
    database < 15
  ) {
    throw new Error('isolated Redis URL is not a runner-issued local test endpoint');
  }

  const manifestPath = realpathSync(process.env.CAT_CAFE_REDIS_TEST_DB_MANIFEST);
  const { leases } = readRedisTestLeases();
  const matching = leases.filter(
    (lease) => lease.port === port && join(lease.dataDir, 'test-files.txt') === manifestPath,
  );
  if (matching.length !== 1) throw new Error('isolated Redis endpoint has no unique matching manifest lease');
  const lease = matching[0];
  if (
    inspectLeaseOwner(lease.owner).status !== 'live' ||
    inspectExpectedProcess(lease.redis).status !== 'live' ||
    isSelfOrDescendantOf(process.pid, lease.owner.pid) !== true
  ) {
    throw new Error('isolated Redis lease is not held by this live runner process tree');
  }
  const manifest = readRedisTestManifest(readFileSync(manifestPath, 'utf8'));
  if (database >= 15 + manifest.length) throw new Error('isolated Redis DB is outside the issued manifest');
  return redisUrl;
}

try {
  process.stdout.write(runnerEndpoint());
} catch (error) {
  console.error(`[redis-test] refusing sandbox reentry: ${error.message}`);
  process.exitCode = 1;
}
