/**
 * Redis keyPrefix isolation tests
 * 验证 REDIS_KEY_PREFIX 环境变量正确隔离不同实例的 Redis 数据
 */

import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { cleanupPrefixedRedisKeys } from './helpers/redis-test-helpers.js';

const REDIS_URL = process.env.REDIS_URL;

describe('createRedisClient keyPrefix isolation', { skip: !REDIS_URL ? 'REDIS_URL not set' : false }, () => {
  let createRedisClient;
  let redis1, redis2, redis3;
  let connected = false;

  before(async () => {
    const redisModule = await import('@cat-cafe/shared/utils');
    createRedisClient = redisModule.createRedisClient;

    // Create three clients with different prefixes
    redis1 = createRedisClient({ url: REDIS_URL, keyPrefix: 'instance-a:' });
    redis2 = createRedisClient({ url: REDIS_URL, keyPrefix: 'instance-b:' });
    redis3 = createRedisClient({ url: REDIS_URL }); // uses default prefix

    try {
      await redis1.ping();
      connected = true;
    } catch {
      console.warn('[redis-key-prefix.test] Redis unreachable, skipping tests');
      await Promise.all([redis1.quit(), redis2.quit(), redis3.quit()].map(p => p.catch(() => {})));
      return;
    }
  });

  after(async () => {
    if (connected) {
      await cleanupPrefixedRedisKeys(redis1, ['test:*']);
      await cleanupPrefixedRedisKeys(redis2, ['test:*']);
      await cleanupPrefixedRedisKeys(redis3, ['test:*']);
      await Promise.all([redis1.quit(), redis2.quit(), redis3.quit()]);
    }
  });

  beforeEach(async () => {
    if (!connected) return;
    // Clean up test keys before each test
    await cleanupPrefixedRedisKeys(redis1, ['test:*']);
    await cleanupPrefixedRedisKeys(redis2, ['test:*']);
    await cleanupPrefixedRedisKeys(redis3, ['test:*']);
  });

  it('uses default cat-cafe: prefix when no keyPrefix is specified', async () => {
    if (!connected) return;

    // Get the actual keyPrefix from the Redis instance options
    const defaultPrefix = redis3.options.keyPrefix;
    assert.equal(defaultPrefix, 'cat-cafe:', 'Default prefix should be cat-cafe:');
  });

  it('isolates data between clients with different prefixes', async () => {
    if (!connected) return;

    // Set same key with different values in different prefixed clients
    await redis1.set('test:isolation', 'value-from-a');
    await redis2.set('test:isolation', 'value-from-b');

    // Each client should only see its own value
    const value1 = await redis1.get('test:isolation');
    const value2 = await redis2.get('test:isolation');

    assert.equal(value1, 'value-from-a', 'instance-a should see its own value');
    assert.equal(value2, 'value-from-b', 'instance-b should see its own value');
  });

  it('creates independent key namespaces', async () => {
    if (!connected) return;

    // Set key in redis1 (instance-a:)
    await redis1.set('test:shared', 'a-value');

    // redis2 (instance-b:) should not see this key
    const notFound = await redis2.get('test:shared');
    assert.equal(notFound, null, 'instance-b should not see instance-a keys');

    // But redis1 should still see it
    const found = await redis1.get('test:shared');
    assert.equal(found, 'a-value', 'instance-a should see its own key');
  });

  it('creates client with custom keyPrefix via parameter', async () => {
    if (!connected) return;

    // Parameter should always override default/env
    const customClient = createRedisClient({
      url: REDIS_URL,
      keyPrefix: 'test-custom:',
    });

    assert.equal(customClient.options.keyPrefix, 'test-custom:', 'Parameter should set prefix');

    // Verify the custom prefix works independently
    await customClient.set('test:key', 'custom-value');
    const value = await customClient.get('test:key');
    assert.equal(value, 'custom-value', 'Custom prefix client should work');

    await cleanupPrefixedRedisKeys(customClient, ['test:*']);
    await customClient.quit();
  });

  it('reads REDIS_KEY_PREFIX from environment', async () => {
    if (!connected) return;

    // Use a subprocess to test env var behavior (ESM module cache makes
    // in-process env changes ineffective for already-loaded modules)
    const { spawn } = await import('node:child_process');
    const { readFile, writeFile, unlink } = await import('node:fs/promises');
    const { join } = await import('node:path');

    // Create a temp test script in the api package directory (where modules are resolvable)
    const apiDir = process.cwd();
    const tempScript = join(apiDir, 'test-redis-env-prefix.mjs');
    const scriptContent = `
import { createRedisClient } from '@cat-cafe/shared/utils';

const redis = createRedisClient({ url: '${REDIS_URL}' });
console.log('PREFIX:', redis.options.keyPrefix);
await redis.quit();
`;

    await writeFile(tempScript, scriptContent);

    // Test 1: without env var (explicitly empty), should use default
    const testDefault = new Promise((resolve, reject) => {
      const env = { ...process.env };
      delete env.REDIS_KEY_PREFIX;
      const proc = spawn(process.execPath, [tempScript], {
        cwd: apiDir,
        env,
      });
      let output = '';
      let stderr = '';
      proc.stdout.on('data', (d) => { output += d.toString(); });
      proc.stderr.on('data', (d) => { stderr += d.toString(); });
      proc.on('close', (code) => {
        if (code !== 0) return reject(new Error(`Exit ${code}: ${stderr}`));
        resolve(output);
      });
    });
    const defaultResult = await testDefault;
    assert.equal(
      defaultResult.includes('PREFIX: cat-cafe:'),
      true,
      `Expected default prefix, got: ${defaultResult}`
    );

    // Test 2: with env var set, should use the env value
    const testWithEnv = new Promise((resolve, reject) => {
      const proc = spawn(process.execPath, [tempScript], {
        cwd: apiDir,
        env: { ...process.env, REDIS_KEY_PREFIX: 'env-test-prefix:' }
      });
      let output = '';
      let stderr = '';
      proc.stdout.on('data', (d) => { output += d.toString(); });
      proc.stderr.on('data', (d) => { stderr += d.toString(); });
      proc.on('close', (code) => {
        if (code !== 0) return reject(new Error(`Exit ${code}: ${stderr}`));
        resolve(output);
      });
    });
    const envResult = await testWithEnv;
    assert.equal(
      envResult.includes('PREFIX: env-test-prefix:'),
      true,
      `Expected env prefix, got: ${envResult}`
    );

    // Cleanup
    await unlink(tempScript);
  });

  it('uses cat-cafe: as default prefix when no config provided', async () => {
    if (!connected) return;

    // redis3 was created without keyPrefix parameter, should use default
    assert.equal(redis3.options.keyPrefix, 'cat-cafe:', 'Default prefix should be cat-cafe:');
  });
});
