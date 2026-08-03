#!/usr/bin/env node
import {
  cleanupStaleRedisTestLeases,
  redisTestRegistryDir,
  removeRedisTestLease,
  writeRedisTestLease,
} from '../../../scripts/lib/redis-test-leases.mjs';

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const args = { command };
  for (let index = 0; index < rest.length; index += 2) {
    const key = rest[index];
    const value = rest[index + 1];
    if (!key?.startsWith('--') || value === undefined) throw new Error(`invalid argument near ${key ?? '<end>'}`);
    args[key.slice(2)] = value;
  }
  return args;
}

function positiveInteger(value, label) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${label} must be a positive integer`);
  return parsed;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const registryDir = redisTestRegistryDir();
  if (args.command === 'cleanup') {
    const result = cleanupStaleRedisTestLeases(registryDir);
    for (const lease of result.live) {
      console.error(`[redis-test] preserving live lease on port ${lease.port} (owner pid ${lease.owner.pid})`);
    }
    for (const lease of result.unknown) {
      console.error(`[redis-test] cannot prove lease owner dead on port ${lease.port}; preserving instance`);
    }
    for (const file of result.invalidFiles) {
      console.error(`[redis-test] invalid lease metadata preserved for manual inspection: ${file}`);
    }
    return;
  }
  if (args.command === 'register') {
    const leaseFile = writeRedisTestLease({
      port: positiveInteger(args.port, 'port'),
      redisPid: positiveInteger(args['redis-pid'], 'redis-pid'),
      dataDir: args['data-dir'],
      ownerPid: positiveInteger(args['owner-pid'], 'owner-pid'),
      registryDir,
    });
    process.stdout.write(`${leaseFile}\n`);
    return;
  }
  if (args.command === 'remove') {
    if (!args['lease-file']) throw new Error('remove requires --lease-file');
    removeRedisTestLease(args['lease-file'], registryDir);
    return;
  }
  throw new Error('usage: redis-test-lease-cli.mjs <cleanup|register|remove> [options]');
}

try {
  main();
} catch (error) {
  console.error(`[redis-test] lease error: ${error.message}`);
  process.exit(1);
}
