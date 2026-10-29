import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import Fastify from 'fastify';
import { RedisSessionChainStore } from '../dist/domains/cats/services/stores/redis/RedisSessionChainStore.js';
import { registerConnectionDiagnostics } from '../dist/routes/connection-diagnostics.js';
import { sessionChainRoutes } from '../dist/routes/session-chain.js';

function signal() {
  let release;
  const promise = new Promise((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
// The real Redis store and route run against controlled transport waits. No Redis connection.
function redisFixture(recordFailure, heldStage) {
  const scan = new Readable({ objectMode: true, read() {} });
  const scanning = signal();
  const writing = signal();
  const writeGate = signal();
  const reading = signal();
  const readGate = signal();
  async function waitRead(stage) {
    if (heldStage === stage) {
      reading.release();
      await readGate.promise;
    }
  }
  let scans = 0;
  const record = {
    id: 'private-session',
    threadId: 'private-thread',
    catId: 'opus',
    userId: 'user-1',
    status: 'sealed',
    seq: '0',
    messageCount: '1',
    createdAt: '1',
    updatedAt: '2',
  };
  const client = {
    options: { keyPrefix: 'test:' },
    async get() {
      return null;
    },
    async set() {
      return 'OK';
    },
    scanStream() {
      scans++;
      scanning.release();
      return scan;
    },
    async smembers() {
      await waitRead('chain_keys');
      return ['session-chain:opus:private-thread'];
    },
    async zrange() {
      await waitRead('chain_members');
      return [record.id];
    },
    pipeline() {
      let backfill = false;
      const pipeline = {
        sadd() {
          backfill = true;
          return pipeline;
        },
        hgetall() {
          return pipeline;
        },
        async exec() {
          if (backfill) {
            writing.release();
            await writeGate.promise;
          }
          if (!backfill && recordFailure) throw recordFailure;
          if (!backfill) await waitRead('session_records');
          return [[null, backfill ? 1 : record]];
        },
      };
      return pipeline;
    },
  };
  let scanReleased = false;
  return {
    store: new RedisSessionChainStore(client),
    scanning,
    writing,
    writeGate,
    reading,
    readGate,
    scans: () => scans,
    releaseScan() {
      if (scanReleased) return;
      scanReleased = true;
      scan.push(['test:session-chain:opus:private-thread']);
      scan.push(null);
    },
  };
}
test(
  'request diagnostics distinguish shared index scan, backfill and runtime metadata without changing the response',
  { timeout: 5_000 },
  async () => {
    const redis = redisFixture();
    const metadata = signal();
    const metadataGate = signal();
    let holdMetadata = false;
    const records = [];
    const listeners = new Set();
    const app = Fastify({
      logger: {
        stream: {
          write(line) {
            const record = JSON.parse(line);
            records.push(record);
            for (const listener of listeners) listener(record);
          },
        },
      },
    });
    registerConnectionDiagnostics(app, 20);
    await app.register(sessionChainRoutes, {
      sessionChainStore: redis.store,
      threadStore: {
        async get(id) {
          return { id, createdBy: 'user-1' };
        },
      },
      runtimeSessionStore: {
        async getBySessionId() {
          if (holdMetadata) {
            metadata.release();
            await metadataGate.promise;
          }
          return null;
        },
      },
    });
    await app.ready();
    const scoped = await app.inject({
      url: '/api/threads/private-thread/sessions?limit=10&offset=0',
      headers: {
        'x-cat-cafe-user': 'user-1',
        'x-cat-id': 'opus',
      },
    });
    assert.equal(scoped.statusCode, 200);
    assert.equal(redis.scans(), 0, 'a cat-scoped MCP list bypasses the global index even before its first build');
    holdMetadata = true;
    function nextPending(client) {
      return new Promise((resolve) => {
        const listener = (record) => {
          if (
            record.event === 'connection_diagnostic' &&
            record.state === 'pending' &&
            record.clientRequestId === client
          ) {
            listeners.delete(listener);
            resolve(record);
          }
        };
        listeners.add(listener);
      });
    }
    function request(client, thread) {
      return app
        .inject({
          url: `/api/threads/${thread}/sessions`,
          headers: {
            'x-cat-cafe-user': 'user-1',
            'x-clowder-client-request': client,
          },
        })
        .then((response) => response);
    }
    const firstId = randomUUID();
    const secondId = randomUUID();
    const pendingFirst = nextPending(firstId);
    const first = request(firstId, 'private-thread');
    let second;
    try {
      await redis.scanning.promise;
      const scanning = await pendingFirst;
      assert.equal(scanning.sessionRead?.phase, 'index_wait', 'a pending request must name its actual store wait');
      assert.equal(scanning.sessionRead.index?.mode, 'started');
      assert.equal(scanning.sessionRead.index.build?.phase, 'scan');
      const pendingSecond = nextPending(secondId);
      second = request(secondId, 'other-private-thread');
      const joined = await pendingSecond;
      assert.equal(joined.sessionRead?.index?.mode, 'joined');
      assert.equal(joined.sessionRead.index.build?.id, scanning.sessionRead.index.build?.id);
      assert.equal(redis.scans(), 1, 'observing two requests must not start two builds');
      redis.releaseScan();
      await redis.writing.promise;
      const backfill = await nextPending(secondId);
      assert.equal(backfill.sessionRead?.index?.build?.phase, 'backfill');
      assert.equal(backfill.sessionRead.index.build.scanBatches, 1);
      assert.equal(backfill.sessionRead.index.build.chainKeys, 1);
      redis.writeGate.release();
      await metadata.promise;
      const attached = await nextPending(secondId);
      assert.equal(attached.sessionRead?.phase, 'runtime_metadata');
      assert.equal(attached.sessionRead.index?.build?.phase, 'ready');
      assert.ok((attached.sessionRead.phases.index_wait ?? 0) > 0);
      metadataGate.release();
      for (const response of await Promise.all([first, second])) {
        assert.equal(response.statusCode, 200);
        assert.equal(response.json().sessions[0].id, 'private-session');
      }
      const diagnostics = records.filter((record) => record.event === 'connection_diagnostic');
      const final = diagnostics.findLast((record) => record.clientRequestId === firstId);
      assert.equal(final?.state, 'finish');
      assert.equal(final.sessionRead?.phase, 'response');
      assert.equal(final.reqId, scanning.reqId);
      assert.ok(!JSON.stringify(diagnostics).includes('private-thread'));
      assert.ok(!JSON.stringify(diagnostics).includes('private-session'));
      await request(randomUUID(), 'private-thread');
      assert.equal(redis.scans(), 1, 'warm requests preserve the existing index reuse');
    } finally {
      redis.releaseScan();
      redis.writeGate.release();
      metadataGate.release();
      await Promise.allSettled([first, ...(second ? [second] : [])]);
      await app.close();
    }
  },
);
test('failing observation preserves store results and the original Redis error', async () => {
  const failure = new Error('controlled Redis read failure');
  for (const recordFailure of [undefined, failure]) {
    const redis = redisFixture(recordFailure);
    let observations = 0;
    const result = redis.store.getChainByThread('private-thread', {
      onReadStage() {
        observations++;
        throw new Error('observer failed');
      },
    });
    redis.releaseScan();
    redis.writeGate.release();
    if (recordFailure) await assert.rejects(result, (error) => error === failure);
    else assert.equal((await result)[0]?.id, 'private-session');
    assert.ok(observations > 0);
  }
});
test('post-index transport waits identify the blocked chain or record read', { timeout: 5_000 }, async () => {
  for (const heldStage of ['chain_keys', 'chain_members', 'session_records']) {
    const redis = redisFixture(undefined, heldStage);
    let phase;
    const result = redis.store.getChainByThread('private-thread', {
      onReadStage(stage) {
        phase = stage.phase;
      },
    });
    redis.releaseScan();
    redis.writeGate.release();
    try {
      await redis.reading.promise;
      assert.equal(phase, heldStage, 'a slow post-index read must not remain attributed to index initialization');
    } finally {
      redis.readGate.release();
      assert.equal((await result)[0]?.id, 'private-session');
    }
  }
});
