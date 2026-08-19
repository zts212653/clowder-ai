import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, afterEach, describe, it } from 'node:test';
import { Worker } from 'node:worker_threads';
import { assignRedisDatabaseForTestFile, readRedisTestManifest } from '../scripts/redis-test-db-namespace.mjs';
import { assertRedisIsolationOrThrow } from './helpers/redis-test-helpers.js';

const originalAssignedDatabase = process.env.CAT_CAFE_REDIS_TEST_DB_ASSIGNED;
const originalIsolationFlag = process.env.CAT_CAFE_REDIS_TEST_ISOLATED;
const originalManifest = process.env.CAT_CAFE_REDIS_TEST_DB_MANIFEST;
const fixtureRoot = mkdtempSync(join(tmpdir(), 'redis-test-db-files.'));
const fixtureFiles = {
  a: join(fixtureRoot, 'a.test.js'),
  b: join(fixtureRoot, 'b.test.js'),
  missing: join(fixtureRoot, 'missing.test.js'),
};
for (const filePath of Object.values(fixtureFiles)) writeFileSync(filePath, '');

after(() => rmSync(fixtureRoot, { recursive: true, force: true }));

afterEach(() => {
  if (originalAssignedDatabase === undefined) delete process.env.CAT_CAFE_REDIS_TEST_DB_ASSIGNED;
  else process.env.CAT_CAFE_REDIS_TEST_DB_ASSIGNED = originalAssignedDatabase;

  if (originalIsolationFlag === undefined) delete process.env.CAT_CAFE_REDIS_TEST_ISOLATED;
  else process.env.CAT_CAFE_REDIS_TEST_ISOLATED = originalIsolationFlag;

  if (originalManifest === undefined) delete process.env.CAT_CAFE_REDIS_TEST_DB_MANIFEST;
  else process.env.CAT_CAFE_REDIS_TEST_DB_MANIFEST = originalManifest;
});

describe('Redis test-file DB namespace', () => {
  it('assigns distinct deterministic databases from manifest order', () => {
    const manifest = [fixtureFiles.a, fixtureFiles.b];

    const first = assignRedisDatabaseForTestFile({
      redisUrl: 'redis://127.0.0.1:6300/15',
      testFilePath: manifest[0],
      manifest,
    });
    const second = assignRedisDatabaseForTestFile({
      redisUrl: 'redis://127.0.0.1:6300/15',
      testFilePath: manifest[1],
      manifest,
    });

    assert.equal(first.database, 15);
    assert.equal(first.redisUrl, 'redis://127.0.0.1:6300/15');
    assert.equal(second.database, 16);
    assert.equal(second.redisUrl, 'redis://127.0.0.1:6300/16');
  });

  it('preserves Redis credentials and query parameters while replacing only the DB', () => {
    const assignment = assignRedisDatabaseForTestFile({
      redisUrl: 'redis://user:secret@127.0.0.1:6300/15?family=test',
      testFilePath: fixtureFiles.b,
      manifest: [fixtureFiles.a, fixtureFiles.b],
    });

    assert.equal(assignment.redisUrl, 'redis://user:secret@127.0.0.1:6300/16?family=test');
  });

  it('fails closed when the Node test child is absent from the manifest', () => {
    assert.throws(
      () =>
        assignRedisDatabaseForTestFile({
          redisUrl: 'redis://127.0.0.1:6300/15',
          testFilePath: fixtureFiles.missing,
          manifest: [fixtureFiles.a],
        }),
      /missing\.test\.js.*manifest/,
    );
  });

  it('matches a test file when the manifest path crosses a directory symlink', () => {
    const root = mkdtempSync(join(tmpdir(), 'redis-test-db-namespace.'));
    const realDirectory = join(root, 'real');
    const linkedDirectory = join(root, 'linked');
    mkdirSync(realDirectory);
    symlinkSync(realDirectory, linkedDirectory, 'dir');
    writeFileSync(join(realDirectory, 'sample.test.js'), '');

    try {
      const assignment = assignRedisDatabaseForTestFile({
        redisUrl: 'redis://127.0.0.1:6300/15',
        testFilePath: join(realDirectory, 'sample.test.js'),
        manifest: [join(linkedDirectory, 'sample.test.js')],
      });

      assert.equal(assignment.database, 15);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('parses a sorted manifest without blank entries or duplicates', () => {
    assert.deepEqual(readRedisTestManifest(`${fixtureFiles.b}\n\n${fixtureFiles.a}\n${fixtureFiles.b}\n`), [
      fixtureFiles.a,
      fixtureFiles.b,
    ]);
  });

  it('preserves the parent test-file namespace inside eval workers', async () => {
    const worker = new Worker(
      `
        import { parentPort, workerData } from 'node:worker_threads';
        await import(workerData.namespaceModuleUrl);
        parentPort.postMessage({
          assignedDatabase: process.env.CAT_CAFE_REDIS_TEST_DB_ASSIGNED,
          redisUrl: process.env.REDIS_URL,
        });
      `,
      {
        eval: true,
        type: 'module',
        env: {
          ...process.env,
          CAT_CAFE_REDIS_TEST_ISOLATED: '1',
          CAT_CAFE_REDIS_TEST_DB_MANIFEST: process.env.CAT_CAFE_REDIS_TEST_DB_MANIFEST,
          CAT_CAFE_REDIS_TEST_DB_ASSIGNED: '23',
          REDIS_URL: 'redis://127.0.0.1:6300/23',
        },
        workerData: {
          namespaceModuleUrl: new URL('../scripts/redis-test-db-namespace.mjs', import.meta.url).href,
        },
      },
    );

    const result = await new Promise((resolve, reject) => {
      worker.once('message', resolve);
      worker.once('error', reject);
      worker.once('exit', (code) => {
        if (code !== 0) reject(new Error(`worker exited ${code}`));
      });
    });

    assert.deepEqual(result, {
      assignedDatabase: '23',
      redisUrl: 'redis://127.0.0.1:6300/23',
    });
  });
});

describe('Redis isolation guard namespace contract', () => {
  it(
    'applies the preload before an isolated test module runs',
    { skip: originalIsolationFlag !== '1' || originalManifest === undefined },
    () => {
      const database = new URL(process.env.REDIS_URL).pathname.slice(1);
      assert.equal(originalAssignedDatabase, database);
    },
  );

  it('accepts a manifest-assigned non-15 database', () => {
    process.env.CAT_CAFE_REDIS_TEST_ISOLATED = '1';
    process.env.CAT_CAFE_REDIS_TEST_DB_ASSIGNED = '16';

    assert.doesNotThrow(() => assertRedisIsolationOrThrow('redis://127.0.0.1:6300/16', 'namespace-test'));
  });

  it('continues to reject a non-15 database without a matching manifest assignment', () => {
    process.env.CAT_CAFE_REDIS_TEST_ISOLATED = '1';
    delete process.env.CAT_CAFE_REDIS_TEST_DB_ASSIGNED;

    assert.throws(
      () => assertRedisIsolationOrThrow('redis://127.0.0.1:6300/16', 'namespace-test'),
      /must use \/15.*manifest-assigned/,
    );
  });

  it('rejects legacy DB15 when a manifest-backed runner has not assigned the test file', () => {
    process.env.CAT_CAFE_REDIS_TEST_ISOLATED = '1';
    process.env.CAT_CAFE_REDIS_TEST_DB_MANIFEST = '/tmp/test-files.txt';
    delete process.env.CAT_CAFE_REDIS_TEST_DB_ASSIGNED;

    assert.throws(
      () => assertRedisIsolationOrThrow('redis://127.0.0.1:6300/15', 'namespace-test'),
      /manifest-assigned/,
    );
  });

  it('rejects a forged assignment that is not a valid namespaced DB number', () => {
    process.env.CAT_CAFE_REDIS_TEST_ISOLATED = '1';
    process.env.CAT_CAFE_REDIS_TEST_DB_ASSIGNED = 'not-a-db';

    assert.throws(
      () => assertRedisIsolationOrThrow('redis://127.0.0.1:6300/not-a-db', 'namespace-test'),
      /must use \/15.*manifest-assigned/,
    );
  });
});
