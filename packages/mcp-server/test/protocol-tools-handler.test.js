/**
 * Protocol tool handler tests — poll loop, MIME heuristic, auth paramName.
 * Uses mocked fetch to verify runtime behavior without network.
 */

import assert from 'node:assert/strict';
import { after, before, describe, it, mock } from 'node:test';

import {
  createProtocolTools,
  deriveFileName,
  deriveMimeType,
  isImageOutputCapability,
} from '../dist/tools/protocol-tools.js';

/** Minimal async template for testing poll loop behavior. */
function makeTemplate(overrides = {}) {
  return {
    name: 'test-provider',
    version: 1,
    mode: 'async',
    baseUrl: 'https://api.test.local',
    capabilities: {
      text2video: {
        submit: {
          method: 'POST',
          path: '/submit',
          response: { taskId: '$.id' },
        },
        poll: {
          method: 'GET',
          path: '/status/{{taskId}}',
          interval: 10, // 10ms for fast tests
          maxAttempts: 3,
          response: {
            status: '$.status',
            statusMap: { succeeded: ['done'], failed: ['error'] },
            resultUrl: '$.url',
          },
        },
      },
      image2video: {
        submit: {
          method: 'POST',
          path: '/submit',
          response: { taskId: '$.id' },
        },
        poll: {
          method: 'GET',
          path: '/status/{{taskId}}',
          interval: 10,
          maxAttempts: 2,
          response: {
            status: '$.status',
            statusMap: { succeeded: ['done'], failed: ['error'] },
            resultUrl: '$.url',
          },
        },
      },
      ...overrides,
    },
  };
}

function makeConfig(templateOverrides = {}) {
  return {
    prefix: 'test',
    provider: { id: 'test', name: 'test', protocol: 'test', baseUrl: 'https://api.test.local', authType: 'apikey' },
    template: makeTemplate(templateOverrides),
    credentials: { apiKey: 'sk-test' },
  };
}

/** Find tool by name suffix. */
function findTool(tools, suffix) {
  return tools.find((t) => t.name.endsWith(suffix));
}

describe('poll tool handler — loop semantics', () => {
  let origFetch;
  let origApiUrl;

  before(() => {
    origFetch = globalThis.fetch;
    // Clear callback config so emitMediaRichBlock skips (no extra fetch).
    origApiUrl = process.env.CAT_CAFE_API_URL;
    delete process.env.CAT_CAFE_API_URL;
  });
  after(() => {
    globalThis.fetch = origFetch;
    if (origApiUrl !== undefined) process.env.CAT_CAFE_API_URL = origApiUrl;
  });

  it('returns on first attempt when poll succeeds immediately', async () => {
    let fetchCount = 0;
    globalThis.fetch = mock.fn(async () => {
      fetchCount++;
      return new Response(JSON.stringify({ status: 'done', url: 'https://cdn.test/v.mp4' }));
    });
    const tools = createProtocolTools(makeConfig());
    const poll = findTool(tools, '_poll');
    const result = await poll.handler({ capability: 'text2video', task_id: 'task-1' });
    const data = JSON.parse(result.content[0].text);
    assert.equal(data.status, 'succeeded');
    assert.equal(data.attempt, 1);
    assert.equal(fetchCount, 1);
  });

  it('retries and succeeds on second attempt', async () => {
    let fetchCount = 0;
    globalThis.fetch = mock.fn(async () => {
      fetchCount++;
      if (fetchCount === 1) return new Response(JSON.stringify({ status: 'processing' }));
      return new Response(JSON.stringify({ status: 'done', url: 'https://cdn.test/v.mp4' }));
    });
    const tools = createProtocolTools(makeConfig());
    const poll = findTool(tools, '_poll');
    const result = await poll.handler({ capability: 'text2video', task_id: 'task-2' });
    const data = JSON.parse(result.content[0].text);
    assert.equal(data.status, 'succeeded');
    assert.equal(data.attempt, 2);
    assert.equal(fetchCount, 2);
  });

  it('returns failed status immediately without retrying', async () => {
    let fetchCount = 0;
    globalThis.fetch = mock.fn(async () => {
      fetchCount++;
      return new Response(JSON.stringify({ status: 'error', error: 'bad prompt' }));
    });
    const tools = createProtocolTools(makeConfig());
    const poll = findTool(tools, '_poll');
    const result = await poll.handler({ capability: 'text2video', task_id: 'task-3' });
    const data = JSON.parse(result.content[0].text);
    assert.equal(data.status, 'failed');
    assert.equal(data.attempt, 1);
    assert.equal(fetchCount, 1);
  });

  it('returns error when succeeded but no resultUrl (malformed)', async () => {
    globalThis.fetch = mock.fn(async () => new Response(JSON.stringify({ status: 'done' })));
    const tools = createProtocolTools(makeConfig());
    const poll = findTool(tools, '_poll');
    const result = await poll.handler({ capability: 'text2video', task_id: 'task-4' });
    assert.equal(result.isError, true);
    assert.ok(result.content[0].text.includes('malformed result'));
  });

  it('exhausts maxAttempts with exactly N requests (no extra poll)', async () => {
    let fetchCount = 0;
    globalThis.fetch = mock.fn(async () => {
      fetchCount++;
      return new Response(JSON.stringify({ status: 'processing' }));
    });
    const config = makeConfig({
      text2video: {
        submit: { method: 'POST', path: '/s', response: { taskId: '$.id' } },
        poll: {
          method: 'GET',
          path: '/p/{{taskId}}',
          interval: 10,
          maxAttempts: 2,
          response: { status: '$.status', statusMap: { succeeded: ['done'] }, resultUrl: '$.url' },
        },
      },
    });
    const tools = createProtocolTools(config);
    const poll = findTool(tools, '_poll');
    const result = await poll.handler({ capability: 'text2video', task_id: 'task-5' });
    assert.equal(result.isError, true);
    assert.ok(result.content[0].text.includes('timed out'));
    assert.equal(fetchCount, 2, 'Should make exactly maxAttempts requests, not maxAttempts+1');
  });
});

describe('poll tool handler — inherited poll config', () => {
  let origFetch;
  let origApiUrl;
  before(() => {
    origFetch = globalThis.fetch;
    origApiUrl = process.env.CAT_CAFE_API_URL;
    delete process.env.CAT_CAFE_API_URL;
  });
  after(() => {
    globalThis.fetch = origFetch;
    if (origApiUrl !== undefined) process.env.CAT_CAFE_API_URL = origApiUrl;
  });

  it('resolves poll config from inherited capability', async () => {
    let fetchCount = 0;
    globalThis.fetch = mock.fn(async () => {
      fetchCount++;
      return new Response(JSON.stringify({ status: 'processing' }));
    });
    const config = makeConfig({
      text2video: {
        submit: { method: 'POST', path: '/s', response: { taskId: '$.id' } },
        poll: {
          method: 'GET',
          path: '/p/{{taskId}}',
          interval: 10,
          maxAttempts: 2,
          response: { status: '$.status', statusMap: { succeeded: ['done'] }, resultUrl: '$.url' },
        },
      },
      // child inherits from text2video
      text2video_hd: { inherit: 'text2video' },
    });
    const tools = createProtocolTools(config);
    const poll = findTool(tools, '_poll');
    const result = await poll.handler({ capability: 'text2video_hd', task_id: 'task-6' });
    assert.equal(result.isError, true);
    assert.equal(fetchCount, 2, 'Should use inherited maxAttempts=2');
  });
});

describe('MIME type heuristic — direct regression tests', () => {
  it('image2video (image input, video output) → video/mp4', () => {
    assert.equal(deriveMimeType('https://cdn.test/signed?token=abc', 'image2video'), 'video/mp4');
    assert.equal(deriveFileName('https://cdn.test/signed?token=abc', 'test', 't1', 'image2video'), 'test_t1.mp4');
  });

  it('text2video → video/mp4', () => {
    assert.equal(deriveMimeType('https://cdn.test/signed?token=abc', 'text2video'), 'video/mp4');
  });

  it('text2image → image/png', () => {
    assert.equal(deriveMimeType('https://cdn.test/signed?token=abc', 'text2image'), 'image/png');
    assert.equal(deriveFileName('https://cdn.test/signed?token=abc', 'test', 't2', 'text2image'), 'test_t2.png');
  });

  it('img2img → image/png', () => {
    assert.equal(isImageOutputCapability('img2img'), true);
    assert.equal(deriveMimeType('https://cdn.test/no-ext', 'img2img'), 'image/png');
  });

  it('URL with extension overrides capability heuristic', () => {
    assert.equal(deriveMimeType('https://cdn.test/video.webm', 'text2image'), 'video/webm');
    assert.equal(deriveMimeType('https://cdn.test/photo.jpg', 'text2video'), 'image/jpeg');
  });

  it('isImageOutputCapability boundary cases', () => {
    assert.equal(isImageOutputCapability('image2video'), false, 'image is INPUT not output');
    assert.equal(isImageOutputCapability('text2video'), false);
    assert.equal(isImageOutputCapability('text2image'), true);
    assert.equal(isImageOutputCapability(undefined), false);
  });
});

describe('fetch receives AbortSignal timeout', () => {
  let origFetch;
  let origApiUrl;
  before(() => {
    origFetch = globalThis.fetch;
    origApiUrl = process.env.CAT_CAFE_API_URL;
    delete process.env.CAT_CAFE_API_URL;
  });
  after(() => {
    globalThis.fetch = origFetch;
    if (origApiUrl !== undefined) process.env.CAT_CAFE_API_URL = origApiUrl;
  });

  it('AbortSignal.timeout is called with exactly 30_000 ms', async () => {
    const capturedMs = [];
    const origAbortTimeout = AbortSignal.timeout;
    AbortSignal.timeout = (ms) => {
      capturedMs.push(ms);
      return origAbortTimeout(ms);
    };
    try {
      globalThis.fetch = mock.fn(
        async () => new Response(JSON.stringify({ status: 'done', url: 'https://cdn.test/v.mp4' })),
      );
      const tools = createProtocolTools(makeConfig());
      await findTool(tools, '_poll').handler({ capability: 'text2video', task_id: 'task-timeout' });
      assert.ok(capturedMs.length >= 1, 'AbortSignal.timeout must be called at least once');
      for (const ms of capturedMs) assert.equal(ms, 30_000, 'Timeout must be exactly 30 seconds');
    } finally {
      AbortSignal.timeout = origAbortTimeout;
    }
  });
});

describe('tool description variable name contract', () => {
  it('submit description uses camelCase imageUrl, not snake_case image_url', () => {
    const tools = createProtocolTools(makeConfig());
    const submit = findTool(tools, '_submit');
    assert.ok(submit.description.includes('imageUrl'), 'Should mention imageUrl');
    assert.ok(!submit.description.includes('image_url'), 'Should NOT mention image_url');
  });

  it('execute description uses camelCase videoUrl, not snake_case video_url', () => {
    const syncConfig = {
      prefix: 'test',
      provider: { id: 't', name: 't', protocol: 't', baseUrl: 'https://test.local', authType: 'apikey' },
      template: {
        name: 'test-sync',
        version: 1,
        mode: 'sync',
        capabilities: {
          analyze: {
            request: { method: 'POST', path: '/a', response: { result: '$.r' } },
          },
        },
      },
      credentials: { apiKey: 'k' },
    };
    const tools = createProtocolTools(syncConfig);
    const execute = findTool(tools, '_execute');
    assert.ok(execute, 'execute tool must exist');
    const varsDesc = execute.inputSchema.vars?.description ?? '';
    assert.ok(varsDesc.includes('videoUrl'), 'vars description should mention videoUrl');
    assert.ok(!varsDesc.includes('video_url'), 'vars description should NOT mention video_url');
  });
});

describe('template variable wiring — vars reach request body', () => {
  let origFetch;
  let origApiUrl;
  before(() => {
    origFetch = globalThis.fetch;
    origApiUrl = process.env.CAT_CAFE_API_URL;
    delete process.env.CAT_CAFE_API_URL;
  });
  after(() => {
    globalThis.fetch = origFetch;
    if (origApiUrl !== undefined) process.env.CAT_CAFE_API_URL = origApiUrl;
  });

  it('imageUrl var renders into submit request body', async () => {
    let body;
    globalThis.fetch = mock.fn(async (_u, o) => {
      if (o?.body) body = JSON.parse(o.body);
      return new Response(JSON.stringify({ id: 'tb1' }));
    });
    const config = makeConfig({
      image2video: {
        submit: {
          method: 'POST',
          path: '/submit',
          body: { image: '{{imageUrl}}', prompt: '{{prompt}}' },
          response: { taskId: '$.id' },
        },
        poll: {
          method: 'GET',
          path: '/s/{{taskId}}',
          interval: 10,
          maxAttempts: 2,
          response: { status: '$.status', statusMap: { succeeded: ['done'] }, resultUrl: '$.url' },
        },
      },
    });
    const tools = createProtocolTools(config);
    await findTool(tools, '_submit').handler({
      capability: 'image2video',
      vars: { imageUrl: 'https://t.co/img.png', prompt: 'dance' },
    });
    assert.ok(body, 'fetch must receive body');
    assert.equal(body.image, 'https://t.co/img.png', 'imageUrl must render into request body');
    assert.equal(body.prompt, 'dance');
  });

  it('videoUrl var renders into execute request body', async () => {
    let body;
    globalThis.fetch = mock.fn(async (_u, o) => {
      if (o?.body) body = JSON.parse(o.body);
      return new Response(JSON.stringify({ r: 'text result' }));
    });
    const cfg = {
      prefix: 'test',
      provider: { id: 't', name: 't', protocol: 't', baseUrl: 'https://test.local', authType: 'apikey' },
      template: {
        name: 'test-sync',
        version: 1,
        mode: 'sync',
        capabilities: {
          analyze: {
            request: {
              method: 'POST',
              path: '/a',
              body: { video_url: '{{videoUrl}}' },
              response: { result: '$.r' },
            },
          },
        },
      },
      credentials: { apiKey: 'k' },
    };
    const tools = createProtocolTools(cfg);
    await findTool(tools, '_execute').handler({
      capability: 'analyze',
      vars: { videoUrl: 'https://t.co/v.mp4', prompt: 'describe' },
    });
    assert.ok(body, 'fetch must receive body');
    assert.equal(body.video_url, 'https://t.co/v.mp4', 'videoUrl must render into body');
  });
});

describe('query-param auth — paramName wiring', () => {
  it('uses custom paramName from credentials', async () => {
    const { getAuthStrategy } = await import('../dist/protocol-engine/auth/index.js');
    const strategy = getAuthStrategy('query-param');
    const result = strategy.sign({ apiKey: 'test-key', _authParamName: 'customKey' }, { method: 'GET', url: '' });
    assert.equal(result.queryParams?.customKey, 'test-key');
    assert.equal(result.queryParams?.key, undefined);
  });

  it('defaults to "key" when no paramName', async () => {
    const { getAuthStrategy } = await import('../dist/protocol-engine/auth/index.js');
    const strategy = getAuthStrategy('query-param');
    const result = strategy.sign({ apiKey: 'test-key' }, { method: 'GET', url: '' });
    assert.equal(result.queryParams?.key, 'test-key');
  });
});

describe('query-param auth — full YAML-to-URL chain via production assembly', () => {
  let origFetch;
  let origApiUrl;
  before(() => {
    origFetch = globalThis.fetch;
    origApiUrl = process.env.CAT_CAFE_API_URL;
    delete process.env.CAT_CAFE_API_URL;
  });
  after(() => {
    globalThis.fetch = origFetch;
    if (origApiUrl !== undefined) process.env.CAT_CAFE_API_URL = origApiUrl;
  });

  it('template.auth.paramName → buildProtocolToolConfig → final URL', async () => {
    const origApiKey = process.env.TESTAUTH_API_KEY;
    process.env.TESTAUTH_API_KEY = 'sk-custom';
    try {
      // Import the PRODUCTION assembly function (not replicated logic)
      const { buildProtocolToolConfig } = await import('../dist/protocol-server.js');
      let capturedUrl;
      globalThis.fetch = mock.fn(async (url) => {
        capturedUrl = url;
        return new Response(JSON.stringify({ id: 'ta1' }));
      });
      const template = makeTemplate();
      template.auth = { method: 'query-param', paramName: 'api_key' };
      const provider = {
        id: 't',
        name: 't',
        protocol: 't',
        baseUrl: 'https://api.test.local',
        authType: 'query-param',
      };
      // Call production wiring — if injection line is deleted, this fails
      const config = buildProtocolToolConfig('TESTAUTH', provider, template);
      assert.equal(config.credentials._authParamName, 'api_key', 'Production must inject _authParamName');
      const tools = createProtocolTools(config);
      await findTool(tools, '_submit').handler({ capability: 'text2video', vars: { prompt: 'test' } });
      assert.ok(capturedUrl, 'fetch must be called');
      const parsed = new URL(capturedUrl);
      assert.equal(parsed.searchParams.get('api_key'), 'sk-custom', 'Custom paramName in URL');
      assert.equal(parsed.searchParams.get('key'), null, 'Default key param must be absent');
    } finally {
      if (origApiKey !== undefined) process.env.TESTAUTH_API_KEY = origApiKey;
      else delete process.env.TESTAUTH_API_KEY;
    }
  });
});

describe('auth method schema validation', () => {
  it('rejects unknown auth method in template', async () => {
    const { ProtocolTemplateSchema } = await import('../dist/protocol-engine/index.js');
    assert.throws(
      () =>
        ProtocolTemplateSchema.parse({
          name: 'test',
          version: 1,
          mode: 'async',
          auth: { method: 'totally-unknown' },
          capabilities: {},
        }),
      /Invalid enum value/,
    );
  });

  it('accepts valid auth method', async () => {
    const { ProtocolTemplateSchema } = await import('../dist/protocol-engine/index.js');
    const result = ProtocolTemplateSchema.parse({
      name: 'test',
      version: 1,
      mode: 'async',
      auth: { method: 'query-param', paramName: 'api_key' },
      capabilities: {},
    });
    assert.equal(result.auth?.method, 'query-param');
    assert.equal(result.auth?.paramName, 'api_key');
  });
});
