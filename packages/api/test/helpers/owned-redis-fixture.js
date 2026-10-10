import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before } from 'node:test';
import { Redis } from 'ioredis';

/** Own a portless Redis child; retain all keys, RDB/AOF and logs, never use inherited REDIS_URL. */
export function ownedRedisFixture(label) {
  let directory;
  let child;
  let exited;
  let admin;
  let log = '';
  const clients = [];
  function connect(keyPrefix = '') {
    const client = new Redis({
      path: join(directory, 'redis.sock'),
      keyPrefix,
      lazyConnect: true,
      retryStrategy: () => null,
      maxRetriesPerRequest: 0,
    });
    client.on('error', () => {});
    return client;
  }
  before(async () => {
    directory = await mkdtemp(`/tmp/${label}-`);
    child = spawn(
      'redis-server',
      [
        '--port',
        '0',
        '--unixsocket',
        join(directory, 'redis.sock'),
        '--unixsocketperm',
        '700',
        '--dir',
        directory,
        '--appendonly',
        'yes',
        '--appendfsync',
        'always',
        '--dbfilename',
        'dump.rdb',
        '--daemonize',
        'no',
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    exited = once(child, 'exit');
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('owned Redis readiness timeout')), 5000);
      const collect = (chunk) => {
        log += chunk;
        if (/Ready to accept connections/i.test(log)) {
          clearTimeout(timer);
          resolve();
        }
      };
      child.stdout.on('data', collect);
      child.stderr.on('data', collect);
      child.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once('exit', (code) => {
        clearTimeout(timer);
        reject(new Error(`owned Redis exited ${code}`));
      });
    });
    admin = connect();
    await admin.connect();
    assert.equal(await admin.ping(), 'PONG');
  });
  after(async () => {
    try {
      for (const client of clients) client.disconnect();
      if (child && child.exitCode === null) {
        if (admin?.status === 'ready') {
          await admin.save();
          await admin.shutdown('SAVE').catch((error) => {
            if (!/Connection is closed|Connection is closed by server/i.test(error.message)) throw error;
          });
          admin.disconnect();
        } else {
          child.kill('SIGTERM'); // Only the directly spawned fixture child, not a runtime process.
        }
        const [code, signal] = await exited;
        assert.equal(code, 0, `owned Redis exit signal=${signal}`);
      }
    } finally {
      if (directory) {
        await writeFile(join(directory, 'redis.log'), log);
        console.log(`retained owned Redis data: ${directory}`);
      }
    }
  });
  return {
    client(keyPrefix) {
      assert.ok(directory, 'fixture before hook has started the owned Redis');
      const client = connect(keyPrefix);
      clients.push(client);
      return client;
    },
  };
}
