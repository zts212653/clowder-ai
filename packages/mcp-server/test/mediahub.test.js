/**
 * MediaHub — Behavioral Tests
 * F139: Tests for JobStore, MediaStorage, and bootstrap fallback.
 */

import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

// ==================== JobStore Tests ====================

describe('JobStore (in-memory RedisClient)', () => {
  /** @type {import('../dist/mediahub/job-store.js').RedisClient} */
  let redis;
  /** @type {import('../dist/mediahub/job-store.js').JobStore} */
  let store;

  beforeEach(async () => {
    // Use in-memory Map-based stub matching bootstrap.ts pattern
    const data = new Map();
    const sortedSets = new Map();

    redis = {
      async hset(key, obj) {
        const existing = data.get(key) ?? {};
        data.set(key, { ...existing, ...obj });
        return Object.keys(obj).length;
      },
      async hgetall(key) {
        return data.get(key) ?? {};
      },
      async expire() {
        return 1;
      },
      async zadd(key, ...args) {
        const set = sortedSets.get(key) ?? [];
        for (let i = 0; i < args.length; i += 2) {
          const score = Number(args[i]);
          const member = String(args[i + 1]);
          const idx = set.findIndex((e) => e.member === member);
          if (idx >= 0) set[idx].score = score;
          else set.push({ score, member });
        }
        set.sort((a, b) => b.score - a.score);
        sortedSets.set(key, set);
        return args.length / 2;
      },
      async zrevrangebyscore(key, _max, _min, ...args) {
        const set = sortedSets.get(key) ?? [];
        let limit = set.length;
        const li = args.indexOf('LIMIT');
        if (li >= 0 && args[li + 2]) limit = Number(args[li + 2]);
        return set.slice(0, limit).map((e) => e.member);
      },
      async del(key) {
        data.delete(key);
        return 1;
      },
    };

    const { JobStore } = await import('../dist/mediahub/job-store.js');
    store = new JobStore(redis);
  });

  /** @returns {import('../dist/mediahub/types.js').JobRecord} */
  function makeJob(overrides = {}) {
    return {
      jobId: 'test-job-1',
      providerId: 'cogvideox',
      capability: 'text2video',
      model: 'cogvideox-flash',
      prompt: 'a cat playing piano',
      status: 'queued',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      ...overrides,
    };
  }

  it('save and get round-trips a job record', async () => {
    const job = makeJob();
    await store.save(job);
    const retrieved = await store.get('test-job-1');
    assert.ok(retrieved);
    assert.equal(retrieved.jobId, 'test-job-1');
    assert.equal(retrieved.providerId, 'cogvideox');
    assert.equal(retrieved.status, 'queued');
    assert.equal(retrieved.prompt, 'a cat playing piano');
  });

  it('get returns null for nonexistent job', async () => {
    const result = await store.get('nonexistent');
    assert.equal(result, null);
  });

  it('updateStatus changes status and preserves other fields', async () => {
    await store.save(makeJob());
    await store.updateStatus('test-job-1', 'running', {
      providerTaskId: 'ext-123',
    });
    const job = await store.get('test-job-1');
    assert.ok(job);
    assert.equal(job.status, 'running');
    assert.equal(job.providerTaskId, 'ext-123');
    assert.equal(job.prompt, 'a cat playing piano');
  });

  it('updateStatus to succeeded with outputPath', async () => {
    await store.save(makeJob());
    await store.updateStatus('test-job-1', 'succeeded', {
      outputPath: '/data/output.mp4',
    });
    const job = await store.get('test-job-1');
    assert.ok(job);
    assert.equal(job.status, 'succeeded');
    assert.equal(job.outputPath, '/data/output.mp4');
  });

  it('updateStatus to failed with error message', async () => {
    await store.save(makeJob());
    await store.updateStatus('test-job-1', 'failed', {
      error: 'API rate limit',
    });
    const job = await store.get('test-job-1');
    assert.ok(job);
    assert.equal(job.status, 'failed');
    assert.equal(job.error, 'API rate limit');
  });

  it('listRecent returns jobs in reverse chronological order', async () => {
    const now = Date.now();
    await store.save(makeJob({ jobId: 'j1', createdAt: now - 2000 }));
    await store.save(makeJob({ jobId: 'j2', createdAt: now - 1000 }));
    await store.save(makeJob({ jobId: 'j3', createdAt: now }));

    const jobs = await store.listRecent(10);
    assert.equal(jobs.length, 3);
    assert.equal(jobs[0].jobId, 'j3');
    assert.equal(jobs[1].jobId, 'j2');
    assert.equal(jobs[2].jobId, 'j1');
  });

  it('listRecent respects limit', async () => {
    const now = Date.now();
    await store.save(makeJob({ jobId: 'j1', createdAt: now - 1000 }));
    await store.save(makeJob({ jobId: 'j2', createdAt: now }));

    const jobs = await store.listRecent(1);
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].jobId, 'j2');
  });
});

// ==================== MediaStorage Tests ====================

describe('MediaStorage', () => {
  it('rejects non-http protocols (SSRF protection)', async () => {
    const { MediaStorage } = await import('../dist/mediahub/media-storage.js');
    const storage = new MediaStorage('/tmp/mediahub-test');
    await assert.rejects(() => storage.download('test', 'j1', 'file:///etc/passwd'), /protocol "file:" not allowed/);
  });

  it('rejects ftp protocol', async () => {
    const { MediaStorage } = await import('../dist/mediahub/media-storage.js');
    const storage = new MediaStorage('/tmp/mediahub-test');
    await assert.rejects(
      () => storage.download('test', 'j1', 'ftp://evil.com/file.mp4'),
      /protocol "ftp:" not allowed/,
    );
  });

  it('blocks localhost (SSRF)', async () => {
    const { MediaStorage } = await import('../dist/mediahub/media-storage.js');
    const storage = new MediaStorage('/tmp/mediahub-test');
    await assert.rejects(
      () => storage.download('test', 'j1', 'http://localhost/secret'),
      /host "localhost" is internal/,
    );
  });

  it('blocks 127.0.0.1 loopback (SSRF)', async () => {
    const { MediaStorage } = await import('../dist/mediahub/media-storage.js');
    const storage = new MediaStorage('/tmp/mediahub-test');
    await assert.rejects(
      () => storage.download('test', 'j1', 'http://127.0.0.1/secret'),
      /host "127.0.0.1" is internal/,
    );
  });

  it('blocks 169.254.x.x link-local (SSRF)', async () => {
    const { MediaStorage } = await import('../dist/mediahub/media-storage.js');
    const storage = new MediaStorage('/tmp/mediahub-test');
    await assert.rejects(
      () => storage.download('test', 'j1', 'http://169.254.169.254/metadata'),
      /host "169.254.169.254" is internal/,
    );
  });

  it('blocks 10.x.x.x private range (SSRF)', async () => {
    const { MediaStorage } = await import('../dist/mediahub/media-storage.js');
    const storage = new MediaStorage('/tmp/mediahub-test');
    await assert.rejects(
      () => storage.download('test', 'j1', 'http://10.0.0.1/internal'),
      /host "10.0.0.1" is internal/,
    );
  });

  it('blocks 192.168.x.x private range (SSRF)', async () => {
    const { MediaStorage } = await import('../dist/mediahub/media-storage.js');
    const storage = new MediaStorage('/tmp/mediahub-test');
    await assert.rejects(
      () => storage.download('test', 'j1', 'http://192.168.1.1/admin'),
      /host "192.168.1.1" is internal/,
    );
  });

  it('blocks IPv4-mapped IPv6 dotted form ::ffff:127.0.0.1 (SSRF)', async () => {
    const { MediaStorage } = await import('../dist/mediahub/media-storage.js');
    const storage = new MediaStorage('/tmp/mediahub-test');
    await assert.rejects(() => storage.download('test', 'j1', 'http://[::ffff:127.0.0.1]/x'), /is internal/);
  });

  it('blocks IPv4-mapped IPv6 hex form ::ffff:7f00:1 (SSRF)', async () => {
    const { MediaStorage } = await import('../dist/mediahub/media-storage.js');
    const storage = new MediaStorage('/tmp/mediahub-test');
    await assert.rejects(() => storage.download('test', 'j1', 'http://[::ffff:7f00:1]/x'), /is internal/);
  });

  it('blocks IPv4-mapped IPv6 with private 10.x (SSRF)', async () => {
    const { MediaStorage } = await import('../dist/mediahub/media-storage.js');
    const storage = new MediaStorage('/tmp/mediahub-test');
    await assert.rejects(() => storage.download('test', 'j1', 'http://[::ffff:10.0.0.1]/x'), /is internal/);
  });
});

// ==================== ProviderRegistry Tests ====================

describe('ProviderRegistry', () => {
  /** @type {import('../dist/mediahub/provider.js').ProviderRegistry} */
  let registry;

  beforeEach(async () => {
    const { ProviderRegistry } = await import('../dist/mediahub/provider.js');
    registry = new ProviderRegistry();
  });

  const mockProvider = {
    id: 'test-provider',
    info: {
      id: 'test-provider',
      name: 'Test Provider',
      capabilities: ['text2video'],
      models: ['test-model'],
      authMode: 'api_key',
    },
    supports: (cap) => cap === 'text2video',
    submit: async () => ({ taskId: 't1', status: 'queued' }),
    queryStatus: async () => ({
      status: 'succeeded',
      resultUrl: 'https://example.com/out.mp4',
    }),
  };

  it('register and get provider', () => {
    registry.register(mockProvider);
    const p = registry.get('test-provider');
    assert.ok(p);
    assert.equal(p.id, 'test-provider');
  });

  it('get returns undefined for unknown provider', () => {
    assert.equal(registry.get('unknown'), undefined);
  });

  it('list returns all registered providers', () => {
    registry.register(mockProvider);
    const list = registry.list();
    assert.equal(list.length, 1);
    assert.equal(list[0].id, 'test-provider');
  });

  it('listByCapability filters correctly', () => {
    registry.register(mockProvider);
    const video = registry.listByCapability('text2video');
    assert.equal(video.length, 1);
    const image = registry.listByCapability('text2image');
    assert.equal(image.length, 0);
  });
});

// ==================== Bootstrap Fallback Tests ====================

describe('bootstrapMediaHub fallback', () => {
  it('falls back to in-memory when Redis is unreachable', async () => {
    const origUrl = process.env['REDIS_URL'];
    process.env['REDIS_URL'] = 'redis://127.0.0.1:1'; // unreachable port
    try {
      const { bootstrapMediaHub } = await import('../dist/mediahub/bootstrap.js');
      // Should not throw — falls back to in-memory
      await bootstrapMediaHub();

      // Service is wired — listProviders should not throw
      const { handleListProviders } = await import('../dist/mediahub/mediahub-tools.js');
      const result = await handleListProviders();
      assert.ok(result);
    } finally {
      if (origUrl === undefined) delete process.env['REDIS_URL'];
      else process.env['REDIS_URL'] = origUrl;
    }
  });
});

// ==================== MediaHubService Tests ====================

describe('MediaHubService', () => {
  /** Helper: build a service with mock provider and in-memory store */
  async function buildTestService(providerOverrides = {}) {
    const { JobStore } = await import('../dist/mediahub/job-store.js');
    const { ProviderRegistry } = await import('../dist/mediahub/provider.js');
    const { MediaHubService } = await import('../dist/mediahub/mediahub-service.js');

    // In-memory Redis stub
    const data = new Map();
    const sortedSets = new Map();
    const redis = {
      async hset(key, obj) {
        data.set(key, { ...(data.get(key) ?? {}), ...obj });
        return Object.keys(obj).length;
      },
      async hgetall(key) {
        return data.get(key) ?? {};
      },
      async expire() {
        return 1;
      },
      async zadd(key, ...args) {
        const set = sortedSets.get(key) ?? [];
        for (let i = 0; i < args.length; i += 2) {
          const score = Number(args[i]);
          const member = String(args[i + 1]);
          const idx = set.findIndex((e) => e.member === member);
          if (idx >= 0) set[idx].score = score;
          else set.push({ score, member });
        }
        set.sort((a, b) => b.score - a.score);
        sortedSets.set(key, set);
        return args.length / 2;
      },
      async zrevrangebyscore(key, _max, _min, ...args) {
        const set = sortedSets.get(key) ?? [];
        let limit = set.length;
        const li = args.indexOf('LIMIT');
        if (li >= 0 && args[li + 2]) limit = Number(args[li + 2]);
        return set.slice(0, limit).map((e) => e.member);
      },
      async del(key) {
        data.delete(key);
        return 1;
      },
    };

    const mockProvider = {
      id: 'mock',
      info: { id: 'mock', name: 'Mock', capabilities: ['text2video'], models: ['m1'], authMode: 'api_key' },
      supports: (cap) => cap === 'text2video',
      submit: async () => ({ providerTaskId: 'task-1', status: 'running' }),
      queryStatus: async () => ({ status: 'succeeded', providerResultUrl: 'https://cdn.example.com/out.mp4' }),
      ...providerOverrides,
    };

    const registry = new ProviderRegistry();
    registry.register(mockProvider);

    const mockStorage = {
      download: async () => '/data/mock/output.mp4',
      getBaseDir: () => '/data',
    };

    const jobStore = new JobStore(redis);
    const service = new MediaHubService(registry, jobStore, mockStorage);
    return { service, jobStore };
  }

  it('generateVideo creates job and submits to provider', async () => {
    const { service } = await buildTestService();
    const job = await service.generateVideo({
      providerId: 'mock',
      prompt: 'cat dancing',
      capability: 'text2video',
    });
    assert.ok(job.jobId);
    assert.equal(job.providerId, 'mock');
    assert.equal(job.status, 'running');
    assert.equal(job.providerTaskId, 'task-1');
  });

  it('generateVideo returns failed when provider throws', async () => {
    const { service } = await buildTestService({
      submit: async () => {
        throw new Error('API key invalid');
      },
    });
    const job = await service.generateVideo({
      providerId: 'mock',
      prompt: 'cat dancing',
      capability: 'text2video',
    });
    assert.equal(job.status, 'failed');
    assert.equal(job.error, 'API key invalid');
  });

  it('generateVideo throws for unknown provider', async () => {
    const { service } = await buildTestService();
    await assert.rejects(
      () =>
        service.generateVideo({
          providerId: 'nonexistent',
          prompt: 'test',
          capability: 'text2video',
        }),
      /Unknown provider: nonexistent/,
    );
  });

  it('generateVideo throws for unsupported capability', async () => {
    const { service } = await buildTestService();
    await assert.rejects(
      () =>
        service.generateVideo({
          providerId: 'mock',
          prompt: 'test',
          capability: 'text2image',
        }),
      /does not support text2image/,
    );
  });

  it('getJobStatus returns not-found for unknown job', async () => {
    const { service } = await buildTestService();
    const result = await service.getJobStatus('no-such-id');
    assert.equal(result.status, 'failed');
    assert.match(result.error, /not found/i);
  });

  it('getJobStatus polls provider and downloads on success', async () => {
    const { service } = await buildTestService();
    const job = await service.generateVideo({
      providerId: 'mock',
      prompt: 'cat singing',
      capability: 'text2video',
    });

    const status = await service.getJobStatus(job.jobId);
    assert.equal(status.status, 'succeeded');
    assert.equal(status.outputPath, '/data/mock/output.mp4');
    assert.equal(status.providerResultUrl, 'https://cdn.example.com/out.mp4');
  });

  it('getJobStatus returns cached terminal state without re-polling', async () => {
    let pollCount = 0;
    const { service } = await buildTestService({
      queryStatus: async () => {
        pollCount++;
        return { status: 'succeeded', providerResultUrl: 'https://cdn.example.com/out.mp4' };
      },
    });

    const job = await service.generateVideo({
      providerId: 'mock',
      prompt: 'test',
      capability: 'text2video',
    });
    await service.getJobStatus(job.jobId); // first poll → succeeds
    const before = pollCount;
    await service.getJobStatus(job.jobId); // second call → should use cached
    assert.equal(pollCount, before); // no additional poll
  });

  it('listJobs returns submitted jobs', async () => {
    const { service } = await buildTestService();
    await service.generateVideo({ providerId: 'mock', prompt: 'a', capability: 'text2video' });
    await service.generateVideo({ providerId: 'mock', prompt: 'b', capability: 'text2video' });
    const jobs = await service.listJobs(10);
    assert.equal(jobs.length, 2);
  });
});
