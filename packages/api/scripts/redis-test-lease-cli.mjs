#!/usr/bin/env node
import {
  cleanupStaleRedisDevLeases,
  cleanupStaleRedisTestLeases,
  redisDevRegistryDir,
  redisTestRegistryDir,
  removeRedisDevLease,
  removeRedisTestLease,
  writeRedisDevLease,
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

function reportCleanup(result, prefix, preservedNoun) {
  for (const lease of result.live) {
    console.error(`[${prefix}] preserving live lease on port ${lease.port} (owner pid ${lease.owner.pid})`);
  }
  for (const lease of result.unknown) {
    console.error(`[${prefix}] cannot prove lease owner dead on port ${lease.port}; preserving ${preservedNoun}`);
  }
  for (const file of result.invalidFiles) {
    console.error(`[${prefix}] invalid lease metadata preserved for manual inspection: ${file}`);
  }
}

function requiredLeaseFile(args) {
  if (!args['lease-file']) throw new Error(`${args.command} requires --lease-file`);
  return args['lease-file'];
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const registryDir = redisTestRegistryDir();
  const devRegistryDir = redisDevRegistryDir();
  const handlers = {
    cleanup: () => reportCleanup(cleanupStaleRedisTestLeases(registryDir), 'redis-test', 'instance'),
    'cleanup-dev': () => reportCleanup(cleanupStaleRedisDevLeases(devRegistryDir), 'redis-dev', 'metadata'),
    register: () => {
      const leaseFile = writeRedisTestLease({
        port: positiveInteger(args.port, 'port'),
        redisPid: positiveInteger(args['redis-pid'], 'redis-pid'),
        dataDir: args['data-dir'],
        ownerPid: positiveInteger(args['owner-pid'], 'owner-pid'),
        registryDir,
      });
      process.stdout.write(`${leaseFile}\n`);
    },
    'register-dev': () => {
      const leaseFile = writeRedisDevLease({
        port: positiveInteger(args.port, 'port'),
        redisPid: positiveInteger(args['redis-pid'], 'redis-pid'),
        dataDir: args['data-dir'],
        ownerPid: positiveInteger(args['owner-pid'], 'owner-pid'),
        projectRoot: args['project-root'],
        registryDir: devRegistryDir,
      });
      process.stdout.write(`${leaseFile}\n`);
    },
    remove: () => removeRedisTestLease(requiredLeaseFile(args), registryDir),
    'remove-dev': () => removeRedisDevLease(requiredLeaseFile(args), devRegistryDir),
  };
  const handler = handlers[args.command];
  if (!handler) {
    throw new Error(
      'usage: redis-test-lease-cli.mjs <cleanup|register|remove|cleanup-dev|register-dev|remove-dev> [options]',
    );
  }
  handler();
}

try {
  main();
} catch (error) {
  console.error(`[redis-test] lease error: ${error.message}`);
  process.exit(1);
}
