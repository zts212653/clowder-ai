/**
 * MediaHub — Phase B Tests
 * F139: Kling/Jimeng provider integration, generate_image tool, multi-provider.
 */

import assert from 'node:assert/strict';
import { beforeEach, describe, it, mock } from 'node:test';

// ==================== Provider Factory Tests ====================

describe('Kling provider factory', () => {
  it('returns null without KLING_ACCESS_KEY', async () => {
    const orig = process.env['KLING_ACCESS_KEY'];
    delete process.env['KLING_ACCESS_KEY'];
    delete process.env['KLING_SECRET_KEY'];
    try {
      const { createKlingProvider } = await import('../dist/mediahub/providers/kling.js');
      assert.equal(createKlingProvider(), null);
    } finally {
      if (orig) process.env['KLING_ACCESS_KEY'] = orig;
    }
  });

  it('creates provider when both AK/SK are set', async () => {
    const origAK = process.env['KLING_ACCESS_KEY'];
    const origSK = process.env['KLING_SECRET_KEY'];
    process.env['KLING_ACCESS_KEY'] = 'test-ak';
    process.env['KLING_SECRET_KEY'] = 'test-sk';
    try {
      const { createKlingProvider } = await import('../dist/mediahub/providers/kling.js');
      const p = createKlingProvider();
      assert.ok(p);
      assert.equal(p.info.id, 'kling');
      assert.deepEqual([...p.info.capabilities], ['text2video', 'image2video']);
    } finally {
      if (origAK === undefined) delete process.env['KLING_ACCESS_KEY'];
      else process.env['KLING_ACCESS_KEY'] = origAK;
      if (origSK === undefined) delete process.env['KLING_SECRET_KEY'];
      else process.env['KLING_SECRET_KEY'] = origSK;
    }
  });
});

describe('Jimeng provider factory', () => {
  it('returns null without VOLC_ACCESSKEY', async () => {
    const orig = process.env['VOLC_ACCESSKEY'];
    delete process.env['VOLC_ACCESSKEY'];
    delete process.env['VOLC_SECRETKEY'];
    try {
      const { createJimengProvider } = await import('../dist/mediahub/providers/jimeng.js');
      assert.equal(createJimengProvider(), null);
    } finally {
      if (orig) process.env['VOLC_ACCESSKEY'] = orig;
    }
  });

  it('creates provider with correct capabilities', async () => {
    const origAK = process.env['VOLC_ACCESSKEY'];
    const origSK = process.env['VOLC_SECRETKEY'];
    process.env['VOLC_ACCESSKEY'] = 'test-ak';
    process.env['VOLC_SECRETKEY'] = 'test-sk';
    try {
      const { createJimengProvider } = await import('../dist/mediahub/providers/jimeng.js');
      const p = createJimengProvider();
      assert.ok(p);
      assert.equal(p.info.id, 'jimeng');
      assert.deepEqual([...p.info.capabilities], ['text2video', 'image2video', 'text2image']);
      assert.ok(p.supports('text2image'));
      assert.ok(!p.supports('image2image'));
    } finally {
      if (origAK === undefined) delete process.env['VOLC_ACCESSKEY'];
      else process.env['VOLC_ACCESSKEY'] = origAK;
      if (origSK === undefined) delete process.env['VOLC_SECRETKEY'];
      else process.env['VOLC_SECRETKEY'] = origSK;
    }
  });
});

// ==================== Kling Provider Behavior ====================

describe('KlingProvider', () => {
  it('submit encodes capability in providerTaskId', async () => {
    const { KlingProvider } = await import('../dist/mediahub/providers/kling.js');
    const provider = new KlingProvider('ak', 'sk');

    // Mock fetch to return a valid Kling response
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ code: 0, message: 'ok', data: { task_id: 'abc123', task_status: 'submitted' } }));
    try {
      const result = await provider.submit({
        providerId: 'kling',
        capability: 'text2video',
        prompt: 'a cat',
      });
      assert.ok(result.providerTaskId.startsWith('t2v::'));
      assert.ok(result.providerTaskId.includes('abc123'));

      const i2vResult = await provider.submit({
        providerId: 'kling',
        capability: 'image2video',
        prompt: 'a cat',
        imageUrl: 'https://example.com/img.jpg',
      });
      assert.ok(i2vResult.providerTaskId.startsWith('i2v::'));
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('queryStatus uses correct endpoint for i2v tasks', async () => {
    const { KlingProvider } = await import('../dist/mediahub/providers/kling.js');
    const provider = new KlingProvider('ak', 'sk');

    let calledUrl = '';
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      calledUrl = String(url);
      return new Response(
        JSON.stringify({
          code: 0,
          message: 'ok',
          data: {
            task_id: 'abc123',
            task_status: 'succeed',
            task_result: { videos: [{ url: 'https://cdn.kling.com/out.mp4' }] },
          },
        }),
      );
    };
    try {
      await provider.queryStatus('i2v::abc123');
      assert.ok(calledUrl.includes('/image2video/abc123'));

      await provider.queryStatus('t2v::def456');
      assert.ok(calledUrl.includes('/text2video/def456'));

      // Backward compat: raw task_id without prefix defaults to t2v
      await provider.queryStatus('ghi789');
      assert.ok(calledUrl.includes('/text2video/ghi789'));
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('maps Kling status values correctly', async () => {
    const { KlingProvider } = await import('../dist/mediahub/providers/kling.js');
    const provider = new KlingProvider('ak', 'sk');
    const originalFetch = globalThis.fetch;

    for (const [klingStatus, expected] of [
      ['submitted', 'queued'],
      ['processing', 'running'],
      ['failed', 'failed'],
    ]) {
      globalThis.fetch = async () =>
        new Response(
          JSON.stringify({
            code: 0,
            message: 'ok',
            data: { task_id: 't1', task_status: klingStatus, task_status_msg: 'err' },
          }),
        );
      const result = await provider.queryStatus(`t2v::t1`);
      assert.equal(result.status, expected, `${klingStatus} should map to ${expected}`);
    }

    globalThis.fetch = originalFetch;
  });
});

// ==================== Jimeng Provider Behavior ====================

describe('JimengProvider', () => {
  it('submit encodes req_key in providerTaskId', async () => {
    const { JimengProvider } = await import('../dist/mediahub/providers/jimeng.js');
    const provider = new JimengProvider('ak', 'sk');

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ code: 10000, message: 'Success', data: { task_id: 'jmtask1' } }));
    try {
      const result = await provider.submit({
        providerId: 'jimeng',
        capability: 'text2video',
        prompt: 'a sunset',
      });
      assert.ok(result.providerTaskId.startsWith('jimeng_t2v_v30::'));
      assert.ok(result.providerTaskId.includes('jmtask1'));

      const imgResult = await provider.submit({
        providerId: 'jimeng',
        capability: 'text2image',
        prompt: 'a flower',
      });
      assert.ok(imgResult.providerTaskId.startsWith('jimeng_high_aes_general_v21::'));
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('queryStatus parses resp_data JSON on success', async () => {
    const { JimengProvider } = await import('../dist/mediahub/providers/jimeng.js');
    const provider = new JimengProvider('ak', 'sk');

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          code: 10000,
          message: 'Success',
          data: {
            status: 'done',
            resp_data: JSON.stringify([{ url: 'https://cdn.jimeng.com/out.mp4' }]),
          },
        }),
      );
    try {
      const result = await provider.queryStatus('jimeng_t2v_v30::task42');
      assert.equal(result.status, 'succeeded');
      assert.equal(result.providerResultUrl, 'https://cdn.jimeng.com/out.mp4');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('queryStatus returns failed for failed/not_found', async () => {
    const { JimengProvider } = await import('../dist/mediahub/providers/jimeng.js');
    const provider = new JimengProvider('ak', 'sk');

    const originalFetch = globalThis.fetch;
    for (const s of ['failed', 'not_found']) {
      globalThis.fetch = async () => new Response(JSON.stringify({ code: 10000, message: 'ok', data: { status: s } }));
      const result = await provider.queryStatus('jimeng_t2v_v30::t1');
      assert.equal(result.status, 'failed');
    }
    globalThis.fetch = originalFetch;
  });

  it('queryStatus returns running for in-progress tasks', async () => {
    const { JimengProvider } = await import('../dist/mediahub/providers/jimeng.js');
    const provider = new JimengProvider('ak', 'sk');

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ code: 10000, message: 'ok', data: { status: 'running' } }));
    try {
      const result = await provider.queryStatus('jimeng_t2v_v30::t1');
      assert.equal(result.status, 'running');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('queryStatus succeeds with image_urls on data (text2image format)', async () => {
    const { JimengProvider } = await import('../dist/mediahub/providers/jimeng.js');
    const provider = new JimengProvider('ak', 'sk');

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          code: 10000,
          message: 'ok',
          data: { status: 'done', image_urls: ['https://cdn.jimeng.com/img.png'] },
        }),
      );
    try {
      const result = await provider.queryStatus('jimeng_high_aes_general_v21::t1');
      assert.equal(result.status, 'succeeded');
      assert.equal(result.providerResultUrl, 'https://cdn.jimeng.com/img.png');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('queryStatus succeeds with video_url on data (video format)', async () => {
    const { JimengProvider } = await import('../dist/mediahub/providers/jimeng.js');
    const provider = new JimengProvider('ak', 'sk');

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          code: 10000,
          message: 'ok',
          data: { status: 'done', video_url: 'https://cdn.jimeng.com/vid.mp4' },
        }),
      );
    try {
      const result = await provider.queryStatus('jimeng_t2v_v30::t1');
      assert.equal(result.status, 'succeeded');
      assert.equal(result.providerResultUrl, 'https://cdn.jimeng.com/vid.mp4');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('queryStatus succeeds with resp_data as object with urls', async () => {
    const { JimengProvider } = await import('../dist/mediahub/providers/jimeng.js');
    const provider = new JimengProvider('ak', 'sk');

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          code: 10000,
          message: 'ok',
          data: { status: 'done', resp_data: JSON.stringify({ urls: ['https://cdn.jimeng.com/obj.mp4'] }) },
        }),
      );
    try {
      const result = await provider.queryStatus('jimeng_t2v_v30::t1');
      assert.equal(result.status, 'succeeded');
      assert.equal(result.providerResultUrl, 'https://cdn.jimeng.com/obj.mp4');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('V4 signature produces valid Authorization header', async () => {
    const { JimengProvider } = await import('../dist/mediahub/providers/jimeng.js');
    const provider = new JimengProvider('test-ak', 'test-sk');

    let capturedHeaders = {};
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (_url, opts) => {
      capturedHeaders = opts?.headers ?? {};
      return new Response(JSON.stringify({ code: 10000, message: 'ok', data: { task_id: 't1' } }));
    };
    try {
      await provider.submit({ providerId: 'jimeng', capability: 'text2video', prompt: 'test' });
      assert.ok(capturedHeaders['Authorization']?.startsWith('HMAC-SHA256 Credential=test-ak/'));
      assert.ok(capturedHeaders['X-Date']);
      assert.ok(capturedHeaders['X-Content-Sha256']);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

// ==================== Multi-Provider Service ====================

describe('MediaHubService multi-provider', () => {
  async function buildMultiProviderService() {
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

    const videoProvider = {
      info: {
        id: 'vid-only',
        displayName: 'Video Only',
        capabilities: ['text2video'],
        models: ['v1'],
        authMode: 'api_key',
      },
      supports: (cap) => cap === 'text2video',
      submit: async () => ({ providerTaskId: 'vt1', status: 'running' }),
      queryStatus: async () => ({ status: 'succeeded', providerResultUrl: 'https://cdn/v.mp4' }),
    };

    const imageProvider = {
      info: {
        id: 'img-only',
        displayName: 'Image Only',
        capabilities: ['text2image'],
        models: ['i1'],
        authMode: 'api_key',
      },
      supports: (cap) => cap === 'text2image',
      submit: async () => ({ providerTaskId: 'it1', status: 'running' }),
      queryStatus: async () => ({ status: 'succeeded', providerResultUrl: 'https://cdn/i.png' }),
    };

    const registry = new ProviderRegistry();
    registry.register(videoProvider);
    registry.register(imageProvider);

    const mockStorage = {
      download: async () => '/data/output.mp4',
      getBaseDir: () => '/data',
    };

    const service = new MediaHubService(registry, new JobStore(redis), mockStorage);
    return { service, registry };
  }

  it('routes text2video to video provider', async () => {
    const { service } = await buildMultiProviderService();
    const job = await service.generateVideo({
      providerId: 'vid-only',
      prompt: 'cat dance',
      capability: 'text2video',
    });
    assert.equal(job.providerId, 'vid-only');
    assert.equal(job.status, 'running');
  });

  it('routes text2image to image provider', async () => {
    const { service } = await buildMultiProviderService();
    const job = await service.generateVideo({
      providerId: 'img-only',
      prompt: 'cat portrait',
      capability: 'text2image',
    });
    assert.equal(job.providerId, 'img-only');
    assert.equal(job.status, 'running');
  });

  it('rejects unsupported capability for provider', async () => {
    const { service } = await buildMultiProviderService();
    await assert.rejects(
      () =>
        service.generateVideo({
          providerId: 'vid-only',
          prompt: 'cat',
          capability: 'text2image',
        }),
      /does not support text2image/,
    );
  });

  it('listByCapability filters providers correctly', async () => {
    const { registry } = await buildMultiProviderService();
    const videoProviders = registry.listByCapability('text2video');
    assert.equal(videoProviders.length, 1);
    assert.equal(videoProviders[0].id, 'vid-only');

    const imageProviders = registry.listByCapability('text2image');
    assert.equal(imageProviders.length, 1);
    assert.equal(imageProviders[0].id, 'img-only');
  });
});
