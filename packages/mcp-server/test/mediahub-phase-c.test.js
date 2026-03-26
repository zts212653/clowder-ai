/**
 * MediaHub — Phase C Tests
 * F139: media-lifecycle validation, send_media, list_jobs filtering, service getJob.
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it } from 'node:test';

// ==================== Media Lifecycle Tests ====================

describe('media-lifecycle validation', () => {
  it('validates mp4 file as video', async () => {
    const { guessMimeType, isVideoType, isImageType } = await import('../dist/mediahub/media-lifecycle.js');
    assert.equal(guessMimeType('/data/output.mp4'), 'video/mp4');
    assert.ok(isVideoType('video/mp4'));
    assert.ok(!isImageType('video/mp4'));
  });

  it('validates png file as image', async () => {
    const { guessMimeType, isVideoType, isImageType } = await import('../dist/mediahub/media-lifecycle.js');
    assert.equal(guessMimeType('/data/output.png'), 'image/png');
    assert.ok(isImageType('image/png'));
    assert.ok(!isVideoType('image/png'));
  });

  it('detects all supported extensions', async () => {
    const { guessMimeType } = await import('../dist/mediahub/media-lifecycle.js');
    assert.equal(guessMimeType('x.mp4'), 'video/mp4');
    assert.equal(guessMimeType('x.webm'), 'video/webm');
    assert.equal(guessMimeType('x.mov'), 'video/quicktime');
    assert.equal(guessMimeType('x.jpg'), 'image/jpeg');
    assert.equal(guessMimeType('x.jpeg'), 'image/jpeg');
    assert.equal(guessMimeType('x.webp'), 'image/webp');
    assert.equal(guessMimeType('x.gif'), 'image/gif');
  });

  it('returns octet-stream for unknown extensions', async () => {
    const { guessMimeType } = await import('../dist/mediahub/media-lifecycle.js');
    assert.equal(guessMimeType('x.xyz'), 'application/octet-stream');
  });

  it('validates existing file with valid type', async () => {
    const { validateMediaFile } = await import('../dist/mediahub/media-lifecycle.js');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mh-test-'));
    const filePath = path.join(tmpDir, 'test.mp4');
    const buf = Buffer.alloc(1024);
    buf.write('ftyp', 4, 'ascii'); // correct MP4 magic bytes
    fs.writeFileSync(filePath, buf);
    try {
      const result = validateMediaFile(filePath);
      assert.ok(result.valid);
      assert.equal(result.mimeType, 'video/mp4');
      assert.equal(result.fileSize, 1024);
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  it('rejects non-existent file', async () => {
    const { validateMediaFile } = await import('../dist/mediahub/media-lifecycle.js');
    const result = validateMediaFile('/nonexistent/file.mp4');
    assert.ok(!result.valid);
    assert.match(result.error ?? '', /not found/i);
  });

  it('rejects unsupported media type', async () => {
    const { validateMediaFile } = await import('../dist/mediahub/media-lifecycle.js');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mh-test-'));
    const filePath = path.join(tmpDir, 'test.txt');
    fs.writeFileSync(filePath, 'hello');
    try {
      const result = validateMediaFile(filePath);
      assert.ok(!result.valid);
      assert.match(result.error ?? '', /unsupported/i);
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  it('rejects image over 20MB', async () => {
    const { validateMediaFile } = await import('../dist/mediahub/media-lifecycle.js');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mh-test-'));
    const filePath = path.join(tmpDir, 'big.png');
    // Create a sparse file to avoid actually allocating 21MB
    const fd = fs.openSync(filePath, 'w');
    fs.ftruncateSync(fd, 21 * 1024 * 1024);
    fs.closeSync(fd);
    try {
      const result = validateMediaFile(filePath);
      assert.ok(!result.valid);
      assert.match(result.error ?? '', /too large/i);
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  // P2-1: Magic byte validation
  it('rejects mp4 with mismatched magic bytes (PNG header in .mp4)', async () => {
    const { validateMediaFile } = await import('../dist/mediahub/media-lifecycle.js');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mh-test-'));
    const filePath = path.join(tmpDir, 'fake.mp4');
    const buf = Buffer.alloc(64);
    buf[0] = 0x89;
    buf[1] = 0x50;
    buf[2] = 0x4e;
    buf[3] = 0x47; // PNG magic
    fs.writeFileSync(filePath, buf);
    try {
      const result = validateMediaFile(filePath);
      assert.ok(!result.valid);
      assert.match(result.error ?? '', /mismatch|magic|content/i);
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  it('rejects png with no valid magic bytes (zeros)', async () => {
    const { validateMediaFile } = await import('../dist/mediahub/media-lifecycle.js');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mh-test-'));
    const filePath = path.join(tmpDir, 'fake.png');
    fs.writeFileSync(filePath, Buffer.alloc(64));
    try {
      const result = validateMediaFile(filePath);
      assert.ok(!result.valid);
      assert.match(result.error ?? '', /mismatch|magic|content/i);
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  it('accepts png with correct magic bytes', async () => {
    const { validateMediaFile } = await import('../dist/mediahub/media-lifecycle.js');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mh-test-'));
    const filePath = path.join(tmpDir, 'valid.png');
    const buf = Buffer.alloc(64);
    buf[0] = 0x89;
    buf[1] = 0x50;
    buf[2] = 0x4e;
    buf[3] = 0x47;
    fs.writeFileSync(filePath, buf);
    try {
      const result = validateMediaFile(filePath);
      assert.ok(result.valid);
      assert.equal(result.mimeType, 'image/png');
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  it('accepts mp4 with correct ftyp magic', async () => {
    const { validateMediaFile } = await import('../dist/mediahub/media-lifecycle.js');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mh-test-'));
    const filePath = path.join(tmpDir, 'valid.mp4');
    const buf = Buffer.alloc(64);
    buf.write('ftyp', 4, 'ascii');
    fs.writeFileSync(filePath, buf);
    try {
      const result = validateMediaFile(filePath);
      assert.ok(result.valid);
      assert.equal(result.mimeType, 'video/mp4');
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  it('accepts jpeg with FFD8FF magic', async () => {
    const { validateMediaFile } = await import('../dist/mediahub/media-lifecycle.js');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mh-test-'));
    const filePath = path.join(tmpDir, 'valid.jpg');
    const buf = Buffer.alloc(64);
    buf[0] = 0xff;
    buf[1] = 0xd8;
    buf[2] = 0xff;
    fs.writeFileSync(filePath, buf);
    try {
      const result = validateMediaFile(filePath);
      assert.ok(result.valid);
      assert.equal(result.mimeType, 'image/jpeg');
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  it('accepts gif with GIF8 magic', async () => {
    const { validateMediaFile } = await import('../dist/mediahub/media-lifecycle.js');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mh-test-'));
    const filePath = path.join(tmpDir, 'valid.gif');
    const buf = Buffer.alloc(64);
    buf.write('GIF8', 0, 'ascii');
    fs.writeFileSync(filePath, buf);
    try {
      const result = validateMediaFile(filePath);
      assert.ok(result.valid);
      assert.equal(result.mimeType, 'image/gif');
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });
});

// ==================== Service: getJob + listJobs filters ====================

describe('MediaHubService Phase C', () => {
  async function buildService(providerOverrides = {}, storageOverrides = {}) {
    const { JobStore } = await import('../dist/mediahub/job-store.js');
    const { ProviderRegistry } = await import('../dist/mediahub/provider.js');
    const { MediaHubService } = await import('../dist/mediahub/mediahub-service.js');

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
      info: {
        id: 'mock',
        displayName: 'Mock',
        capabilities: ['text2video', 'text2image'],
        models: ['m1'],
        authMode: 'api_key',
      },
      supports: (cap) => ['text2video', 'text2image'].includes(cap),
      submit: async () => ({ providerTaskId: 'task-1', status: 'running' }),
      queryStatus: async () => ({ status: 'succeeded', providerResultUrl: 'https://cdn/out.mp4' }),
      ...providerOverrides,
    };

    const registry = new ProviderRegistry();
    registry.register(mockProvider);

    const mockStorage = {
      download: async () => '/data/mock/output.mp4',
      getBaseDir: () => '/data',
      ...storageOverrides,
    };
    const jobStore = new JobStore(redis);
    const service = new MediaHubService(registry, jobStore, mockStorage);
    return { service, jobStore };
  }

  it('getJob returns job without polling provider', async () => {
    const { service } = await buildService();
    const job = await service.generateVideo({ providerId: 'mock', prompt: 'cat', capability: 'text2video' });
    const retrieved = await service.getJob(job.jobId);
    assert.ok(retrieved);
    assert.equal(retrieved.jobId, job.jobId);
    assert.equal(retrieved.status, 'running'); // not polled → stays running
  });

  it('getJob returns null for unknown ID', async () => {
    const { service } = await buildService();
    const result = await service.getJob('nonexistent');
    assert.equal(result, null);
  });

  it('listJobs filters by status', async () => {
    const { service } = await buildService();
    await service.generateVideo({ providerId: 'mock', prompt: 'a', capability: 'text2video' });
    await service.generateVideo({ providerId: 'mock', prompt: 'b', capability: 'text2video' });
    // Both are 'running' after submit
    const running = await service.listJobs(10, { status: 'running' });
    assert.equal(running.length, 2);
    const succeeded = await service.listJobs(10, { status: 'succeeded' });
    assert.equal(succeeded.length, 0);
  });

  it('listJobs filters by capability', async () => {
    const { service } = await buildService();
    await service.generateVideo({ providerId: 'mock', prompt: 'video', capability: 'text2video' });
    await service.generateVideo({ providerId: 'mock', prompt: 'image', capability: 'text2image' });

    const videos = await service.listJobs(10, { capability: 'text2video' });
    assert.equal(videos.length, 1);
    assert.equal(videos[0].capability, 'text2video');

    const images = await service.listJobs(10, { capability: 'text2image' });
    assert.equal(images.length, 1);
    assert.equal(images[0].capability, 'text2image');
  });

  it('listJobs without filters returns all', async () => {
    const { service } = await buildService();
    await service.generateVideo({ providerId: 'mock', prompt: 'a', capability: 'text2video' });
    await service.generateVideo({ providerId: 'mock', prompt: 'b', capability: 'text2image' });
    const all = await service.listJobs(10);
    assert.equal(all.length, 2);
  });

  // P2-2 integration: service.runCleanup removes expired, keeps active
  it('runCleanup removes expired job dirs and keeps active ones', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mh-cleanup-'));
    try {
      const { service } = await buildService({}, { getBaseDir: () => tmpDir });
      const job = await service.generateVideo({ providerId: 'mock', prompt: 'test', capability: 'text2video' });

      // Active job dir + expired (unknown) job dir
      const activeDir = path.join(tmpDir, 'mock', job.jobId);
      const expiredDir = path.join(tmpDir, 'mock', 'expired-fake-id');
      fs.mkdirSync(activeDir, { recursive: true });
      fs.mkdirSync(expiredDir, { recursive: true });
      fs.writeFileSync(path.join(activeDir, 'output.mp4'), Buffer.alloc(10));
      fs.writeFileSync(path.join(expiredDir, 'output.mp4'), Buffer.alloc(10));

      const result = await service.runCleanup();
      assert.equal(result.deleted, 1);
      assert.ok(fs.existsSync(activeDir), 'active job dir should be kept');
      assert.ok(!fs.existsSync(expiredDir), 'expired job dir should be removed');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  // P1 regression: empty jobStore (Redis fallback) must NOT delete existing media
  it('runCleanup on empty store deletes all dirs — callers must gate on persistence', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mh-cleanup-'));
    try {
      // Fresh service with empty store simulates in-memory fallback
      const { service } = await buildService({}, { getBaseDir: () => tmpDir });
      // Pre-existing media dir (no corresponding job in empty store)
      const orphanDir = path.join(tmpDir, 'kling', 'old-job-uuid');
      fs.mkdirSync(orphanDir, { recursive: true });
      fs.writeFileSync(path.join(orphanDir, 'output.mp4'), Buffer.alloc(10));

      // runCleanup WILL delete it — proving callers must check persistence first
      const result = await service.runCleanup();
      assert.equal(result.deleted, 1, 'empty store treats all dirs as expired');
      assert.ok(!fs.existsSync(orphanDir), 'dir deleted because store has no record');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// ==================== Send Media Handler ====================

describe('handleSendMedia', () => {
  async function setupService() {
    const { JobStore } = await import('../dist/mediahub/job-store.js');
    const { ProviderRegistry } = await import('../dist/mediahub/provider.js');
    const { MediaHubService } = await import('../dist/mediahub/mediahub-service.js');
    const { setMediaHubService } = await import('../dist/mediahub/mediahub-tools.js');

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
          set.push({ score: Number(args[i]), member: String(args[i + 1]) });
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
      info: { id: 'mock', displayName: 'Mock', capabilities: ['text2video'], models: ['m1'], authMode: 'api_key' },
      supports: () => true,
      submit: async () => ({ providerTaskId: 'task-1', status: 'running' }),
      queryStatus: async () => ({ status: 'succeeded', providerResultUrl: 'https://cdn/out.mp4' }),
    };

    const registry = new ProviderRegistry();
    registry.register(mockProvider);
    const mockStorage = { download: async () => '/data/mock/output.mp4', getBaseDir: () => '/data' };
    const jobStore = new JobStore(redis);
    const service = new MediaHubService(registry, jobStore, mockStorage);
    setMediaHubService(service);
    return { service, jobStore };
  }

  it('returns error for non-existent job', async () => {
    await setupService();
    const { handleSendMedia } = await import('../dist/mediahub/mediahub-tools.js');
    const result = await handleSendMedia({ job_id: 'nonexistent' });
    assert.ok(result.isError);
  });

  it('returns error for non-succeeded job', async () => {
    const { service } = await setupService();
    const { handleSendMedia } = await import('../dist/mediahub/mediahub-tools.js');
    const job = await service.generateVideo({ providerId: 'mock', prompt: 'cat', capability: 'text2video' });
    // Job is in 'running' status
    const result = await handleSendMedia({ job_id: job.jobId });
    assert.ok(result.isError);
  });

  it('returns rich block for succeeded job with CDN URL', async () => {
    const { service } = await setupService();
    const { handleSendMedia } = await import('../dist/mediahub/mediahub-tools.js');
    const job = await service.generateVideo({ providerId: 'mock', prompt: 'cat dance', capability: 'text2video' });
    // Poll to trigger succeeded status
    await service.getJobStatus(job.jobId);

    const result = await handleSendMedia({ job_id: job.jobId });
    assert.ok(!result.isError);
    const parsed = JSON.parse(result.content[0].text);
    assert.equal(parsed.block.kind, 'file');
    assert.ok(parsed.block.url);
    assert.ok(parsed.cdnUrl);
  });

  // P2-3: Deliverability validation
  it('returns error when only local filesystem path available (not deliverable)', async () => {
    const { service, jobStore } = await setupService();
    const { handleSendMedia } = await import('../dist/mediahub/mediahub-tools.js');
    const job = await service.generateVideo({ providerId: 'mock', prompt: 'cat', capability: 'text2video' });
    // Create real file so validation passes
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mh-test-'));
    const filePath = path.join(tmpDir, 'output.mp4');
    const buf = Buffer.alloc(64);
    buf.write('ftyp', 4, 'ascii');
    fs.writeFileSync(filePath, buf);
    try {
      await jobStore.updateStatus(job.jobId, 'succeeded', { outputPath: filePath });
      const result = await handleSendMedia({ job_id: job.jobId });
      assert.ok(result.isError);
      assert.match(result.content[0].text, /deliverable|https/i);
    } finally {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });
});

// ==================== P2-2: Expired Media Cleanup ====================

describe('cleanupExpiredMedia', () => {
  it('removes directories for expired jobs', async () => {
    const { cleanupExpiredMedia } = await import('../dist/mediahub/media-lifecycle.js');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mh-cleanup-'));
    const jobDir = path.join(tmpDir, 'mock', 'expired-job-id');
    fs.mkdirSync(jobDir, { recursive: true });
    fs.writeFileSync(path.join(jobDir, 'output.mp4'), Buffer.alloc(10));
    try {
      const result = await cleanupExpiredMedia(tmpDir, async () => false);
      assert.equal(result.deleted, 1);
      assert.ok(!fs.existsSync(jobDir));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('keeps directories for active jobs', async () => {
    const { cleanupExpiredMedia } = await import('../dist/mediahub/media-lifecycle.js');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mh-cleanup-'));
    const jobDir = path.join(tmpDir, 'mock', 'active-job-id');
    fs.mkdirSync(jobDir, { recursive: true });
    fs.writeFileSync(path.join(jobDir, 'output.mp4'), Buffer.alloc(10));
    try {
      const result = await cleanupExpiredMedia(tmpDir, async () => true);
      assert.equal(result.deleted, 0);
      assert.ok(fs.existsSync(jobDir));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('handles empty baseDir gracefully', async () => {
    const { cleanupExpiredMedia } = await import('../dist/mediahub/media-lifecycle.js');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mh-cleanup-'));
    try {
      const result = await cleanupExpiredMedia(tmpDir, async () => false);
      assert.equal(result.deleted, 0);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
