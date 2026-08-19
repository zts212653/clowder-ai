import { readFileSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { isMainThread } from 'node:worker_threads';

const BASE_DATABASE = 15;
const MANIFEST_ENV = 'CAT_CAFE_REDIS_TEST_DB_MANIFEST';
const ASSIGNED_DATABASE_ENV = 'CAT_CAFE_REDIS_TEST_DB_ASSIGNED';

export function readRedisTestManifest(source) {
  return [
    ...new Set(
      source
        .split(/\r?\n/u)
        .map((entry) => entry.trim())
        .filter(Boolean),
    ),
  ].sort();
}

function canonicalizeTestFilePath(filePath) {
  return realpathSync(resolve(filePath));
}

export function assignRedisDatabaseForTestFile({ redisUrl, testFilePath, manifest, baseDatabase = BASE_DATABASE }) {
  const normalizedTestFile = canonicalizeTestFilePath(testFilePath);
  const normalizedManifest = manifest.map(canonicalizeTestFilePath);
  const manifestIndex = normalizedManifest.indexOf(normalizedTestFile);
  if (manifestIndex === -1) {
    throw new Error(`[redis-test] Node test file ${normalizedTestFile} is absent from the Redis DB manifest`);
  }

  const parsed = new URL(redisUrl);
  const database = baseDatabase + manifestIndex;
  parsed.pathname = `/${database}`;
  return { database, redisUrl: parsed.toString() };
}

function isNodeTestRunnerChild() {
  return (
    process.env.NODE_TEST_CONTEXT === 'child-v8' &&
    process.execArgv.some((argument) => argument === '--test' || argument.startsWith('--test-'))
  );
}

function preserveInheritedWorkerNamespace() {
  if (isMainThread) return false;

  const assignedDatabase = process.env[ASSIGNED_DATABASE_ENV];
  const redisUrl = process.env.REDIS_URL;
  if (!assignedDatabase || !redisUrl) {
    throw new Error('[redis-test] Worker inherited isolated Redis mode without a parent DB assignment');
  }

  const redisDatabase = new URL(redisUrl).pathname.replace(/^\/+/, '') || '0';
  const isValidAssignment =
    /^\d+$/u.test(assignedDatabase) && Number(assignedDatabase) >= BASE_DATABASE && assignedDatabase === redisDatabase;
  if (!isValidAssignment) {
    throw new Error(
      `[redis-test] Worker Redis DB /${redisDatabase} does not match parent assignment ${assignedDatabase}`,
    );
  }

  return true;
}

function applyRedisTestDatabaseNamespace() {
  if (process.env.CAT_CAFE_REDIS_TEST_ISOLATED !== '1' || !process.env[MANIFEST_ENV]) return;
  if (preserveInheritedWorkerNamespace()) return;
  if (!isNodeTestRunnerChild()) return;

  const testFilePath = process.argv[1];
  if (!testFilePath) {
    throw new Error('[redis-test] Node test child has no test-file argv for Redis DB assignment');
  }

  const manifest = readRedisTestManifest(readFileSync(process.env[MANIFEST_ENV], 'utf8'));
  const assignment = assignRedisDatabaseForTestFile({
    redisUrl: process.env.REDIS_URL,
    testFilePath,
    manifest,
  });
  process.env.REDIS_URL = assignment.redisUrl;
  process.env[ASSIGNED_DATABASE_ENV] = String(assignment.database);
}

applyRedisTestDatabaseNamespace();
