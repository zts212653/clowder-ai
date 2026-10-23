/**
 * F232 KD-9 / F322: the recent-works route must be bounded by raw owner-index
 * entries and may only publish a canonical prefix whose timestamp tie group is
 * complete. These are Redis contract tests because an in-memory visible-page
 * stub cannot expose refill or sorted-set tie ordering.
 */

import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import { projectRecentWorks } from '@cat-cafe/shared/recent-works';
import Fastify from 'fastify';
import Redis from 'ioredis';
import { projectMessageArtifacts } from '../dist/domains/cats/services/agents/routing/thread-artifacts-aggregator.js';
import { RedisMessageStore } from '../dist/domains/cats/services/stores/redis/RedisMessageStore.js';
import { threadsRoutes } from '../dist/routes/threads.js';
import {
  assertRedisIsolationOrThrow,
  cleanupClientKeyspace,
  redisIsolationSkipReason,
} from './helpers/redis-test-helpers.js';

const REDIS_URL = process.env.REDIS_URL;
const OWNER = 'f232-recent-boundary-owner';
const THREADS = [
  { id: 'thread-a', title: 'Thread A', createdBy: OWNER },
  { id: 'thread-z', title: 'Thread Z', createdBy: OWNER },
];
const AUTH = { 'x-cat-cafe-user': OWNER };

describe('F232 recent works — bounded Redis boundaries', { skip: redisIsolationSkipReason(REDIS_URL) }, () => {
  let app;
  let redis;
  let store;
  let hydratedRawMessages = 0;

  const registerApp = async (artifactWorkLineage) => {
    app = Fastify();
    await app.register(threadsRoutes, {
      threadStore: {
        get: async (id) => THREADS.find((thread) => thread.id === id) ?? null,
        list: async (userId) => (userId === OWNER ? THREADS : []),
        getThreadMemory: async () => null,
      },
      messageStore: store,
      taskStore: { listByThread: async () => [] },
      artifactWorkLineage: {
        current: artifactWorkLineage ?? { resolve: async ({ artifacts }) => artifacts.map(() => undefined) },
        independent: {
          readRecent: async () => ({ artifacts: [], complete: true }),
          readThread: async () => ({ artifacts: [], snapshot: 'empty' }),
        },
      },
    });
  };

  before(async () => {
    assertRedisIsolationOrThrow(REDIS_URL, 'F232RecentWorksBoundaries');
    redis = new Redis(REDIS_URL, { keyPrefix: `f232-recent-boundaries-${process.pid}:` });
    await redis.ping();
  });

  beforeEach(async () => {
    await cleanupClientKeyspace(redis);
    store = new RedisMessageStore(redis, { ttlSeconds: 0 });
    const hydrate = store.hydrateMessages.bind(store);
    store.hydrateMessages = async (ids, options) => {
      hydratedRawMessages += ids.length;
      return hydrate(ids, options);
    };
    hydratedRawMessages = 0;
    await registerApp();
  });

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  after(async () => {
    if (!redis) return;
    await cleanupClientKeyspace(redis);
    await redis.quit();
  });

  const appendFile = (timestamp, name, overrides = {}) =>
    store.append({
      userId: OWNER,
      threadId: 'thread-a',
      from: { kind: 'agent', catId: 'codex61-sol' },
      content: name,
      mentions: [],
      timestamp,
      extra: {
        rich: {
          v: 1,
          blocks: [
            {
              kind: 'file',
              v: 1,
              id: name,
              url: `/uploads/${name}`,
              fileName: name,
              mimeType: 'application/pdf',
            },
          ],
        },
      },
      ...overrides,
    });

  const read = async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/artifacts?view=recent-works&limit=3',
      headers: AUTH,
    });
    assert.equal(response.statusCode, 200, response.body);
    return response.json();
  };

  const familyCoordinate = (artifact) => {
    const match = /^family-(\d+)\.png$/.exec(artifact.name);
    return match
      ? { contentRef: 'controlled-owner-content-family', ownerRevision: Number(match[1]), currentOwnerRevision: 20 }
      : undefined;
  };

  const registerLineageApp = async (observation) => {
    await app.close();
    await registerApp({
      resolve: async ({ artifacts }) => {
        observation.calls += 1;
        observation.candidates = artifacts.length;
        return artifacts.map(familyCoordinate);
      },
    });
  };

  it('late rich publication invalidates material projections while prose and thinking updates do not', async () => {
    const message = await store.append({
      userId: OWNER,
      threadId: THREADS[0].id,
      from: { kind: 'agent', catId: 'codex61-sol' },
      content: 'already saved response',
      mentions: [],
      timestamp: Date.now(),
    });
    const changed = [];
    store.onTimelineChanged = (updated) => changed.push(updated);
    await store.augmentStreamMetadata(message.id, { thinking: 'still writing' });
    assert.equal(changed.length, 0);
    await store.augmentStreamMetadata(message.id, {
      extra: {
        rich: {
          v: 1,
          blocks: [{ kind: 'file', v: 1, id: 'late-file', url: '/uploads/current.pdf', fileName: 'current.pdf' }],
        },
      },
    });
    assert.equal(changed.length, 1);
    assert.equal(changed[0].extra.rich.blocks[0].fileName, 'current.pdf');
    await store.augmentStreamMetadata(message.id, { extra: { rich: changed[0].extra.rich } });
    assert.equal(changed.length, 1, 'replaying the same rich result is not a new material invalidation');
    await store.updateExtra(message.id, {
      rich: {
        v: 1,
        blocks: [{ kind: 'file', v: 1, id: 'revision', url: '/uploads/revision.pdf', fileName: 'revision.pdf' }],
      },
    });
    assert.equal(changed.length, 2);
    assert.equal(changed[1].extra.rich.blocks[0].fileName, 'revision.pdf');
  });

  it('bounds actual Redis hydration across invisible-message refill', async () => {
    const time = Date.now();
    await appendFile(time, 'old-visible-work.pdf');
    for (let index = 1; index <= 700; index += 1) {
      await appendFile(time + index, `queued-${index}.pdf`, {
        from: { kind: 'user', userId: OWNER },
        deliveryStatus: 'queued',
      });
    }

    hydratedRawMessages = 0;
    const result = await read();

    assert.ok(hydratedRawMessages <= 512, `raw hydration ${hydratedRawMessages} exceeds the 512-message budget`);
    assert.equal(result.complete, false);
    assert.deepEqual(result.artifacts, []);
  });

  it('completes a same-timestamp group before applying cross-thread and publication tie order', async () => {
    const time = Date.now();
    for (let index = 0; index < 100; index += 1) {
      await appendFile(time, `equal-time-${index}.pdf`, {
        threadId: index % 2 === 0 ? 'thread-z' : 'thread-a',
      });
    }
    await store.append({
      userId: OWNER,
      threadId: 'thread-a',
      from: { kind: 'agent', catId: 'opus55' },
      content: 'gallery',
      mentions: [],
      timestamp: time,
      extra: {
        rich: {
          v: 1,
          blocks: [
            {
              kind: 'media_gallery',
              v: 1,
              id: 'tie-gallery',
              items: Array.from({ length: 5 }, (_, index) => ({
                url: `/uploads/gallery-${index}.png`,
                caption: `gallery-${index}.png`,
              })),
            },
          ],
        },
      },
    });

    const result = await read();
    const completeProjection = [];
    for (const thread of THREADS) {
      const history = await store.getByThread(thread.id, 1_000, OWNER, { includeQueuedCatMessages: true });
      completeProjection.push(
        ...projectMessageArtifacts(history).map((artifact) => ({
          ...artifact,
          threadId: thread.id,
          threadTitle: thread.title,
        })),
      );
    }
    const expected = projectRecentWorks(completeProjection, 'unavailable', 3);

    assert.deepEqual(
      result.artifacts.map((artifact) => [artifact.threadId, artifact.sourceMessageId, artifact.name]),
      expected.map((artifact) => [artifact.threadId, artifact.sourceMessageId, artifact.name]),
    );
    assert.equal(result.complete, true);
  });

  it('projects lineage before limiting versions from separate messages', async () => {
    const time = Date.now();
    await appendFile(time + 1, 'independent-b.pdf');
    await appendFile(time + 2, 'independent-a.pdf');
    for (let revision = 1; revision <= 20; revision += 1) {
      const name = `family-${revision}.png`;
      await appendFile(time + 100 + revision, name, {
        extra: {
          rich: {
            v: 1,
            blocks: [
              {
                kind: 'media_gallery',
                v: 1,
                id: `gallery-${revision}`,
                items: [{ url: `/uploads/${name}`, caption: name }],
              },
            ],
          },
        },
      });
    }
    const observation = { calls: 0, candidates: 0 };
    await registerLineageApp(observation);

    const result = await read();

    assert.equal(result.complete, true);
    assert.equal(observation.calls, 1);
    assert.equal(observation.candidates, 22);
    assert.deepEqual(
      result.artifacts.map((artifact) => artifact.name),
      ['family-20.png', 'independent-a.pdf', 'independent-b.pdf'],
    );
  });

  it('projects lineage before limiting versions published together in one gallery', async () => {
    const time = Date.now();
    const familyItems = Array.from({ length: 20 }, (_, index) => ({
      url: `/uploads/family-${index + 1}.png`,
      caption: `family-${index + 1}.png`,
    }));
    await store.append({
      userId: OWNER,
      threadId: 'thread-a',
      from: { kind: 'agent', catId: 'opus55' },
      content: 'version gallery',
      mentions: [],
      timestamp: time,
      extra: {
        rich: {
          v: 1,
          blocks: [
            {
              kind: 'media_gallery',
              v: 1,
              id: 'version-gallery',
              items: [
                ...familyItems,
                { url: '/uploads/independent-a.pdf', caption: 'independent-a.pdf' },
                { url: '/uploads/independent-b.pdf', caption: 'independent-b.pdf' },
              ],
            },
          ],
        },
      },
    });
    const observation = { calls: 0, candidates: 0 };
    await registerLineageApp(observation);

    const result = await read();

    assert.equal(result.complete, true);
    assert.equal(observation.calls, 1);
    assert.equal(observation.candidates, 22);
    assert.deepEqual(
      result.artifacts.map((artifact) => artifact.name),
      ['family-20.png', 'independent-a.pdf', 'independent-b.pdf'],
    );
  });

  it('withholds only an incomplete older tie group and retains its proven newer prefix', async () => {
    const time = Date.now();
    for (let index = 0; index < 600; index += 1) {
      await appendFile(time, `oversized-tie-${index}.pdf`, {
        threadId: index % 2 === 0 ? 'thread-z' : 'thread-a',
      });
    }
    await appendFile(time + 10, 'safe-older.pdf');
    await appendFile(time + 20, 'safe-newest.pdf');

    hydratedRawMessages = 0;
    const result = await read();

    assert.ok(hydratedRawMessages <= 512, `raw hydration ${hydratedRawMessages} exceeds the 512-message budget`);
    assert.equal(result.complete, false);
    assert.deepEqual(
      result.artifacts.map((artifact) => artifact.name),
      ['safe-newest.pdf', 'safe-older.pdf'],
    );
  });

  it('keeps foreign-owner and unlisted-thread works private', async () => {
    const time = Date.now();
    await appendFile(time, 'owned.pdf');
    await appendFile(time + 1, 'foreign-owner.pdf', { userId: 'foreign-owner' });
    await appendFile(time + 2, 'unlisted-thread.pdf', { threadId: 'foreign-thread' });

    const result = await read();

    assert.deepEqual(
      result.artifacts.map((artifact) => artifact.name),
      ['owned.pdf'],
    );
  });
});
