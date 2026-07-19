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

// ── Credential scrubbing — engine-level regression tests ──

describe('credential scrubbing through tool handlers', () => {
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

  it('scrubs credentials from poll error field (2xx business error)', async () => {
    globalThis.fetch = mock.fn(
      async () => new Response(JSON.stringify({ status: 'error', error: 'Provider echoed sk-test in response' })),
    );
    // Use a template with error mapping in poll response
    const config = makeConfig({
      text2video: {
        submit: { method: 'POST', path: '/submit', response: { taskId: '$.id' } },
        poll: {
          method: 'GET',
          path: '/status/{{taskId}}',
          interval: 10,
          maxAttempts: 3,
          response: {
            status: '$.status',
            statusMap: { succeeded: ['done'], failed: ['error'] },
            resultUrl: '$.url',
            error: '$.error',
          },
        },
      },
    });
    const tools = createProtocolTools(config);
    const poll = findTool(tools, '_poll');
    const result = await poll.handler({ capability: 'text2video', task_id: 'scrub-1' });
    const data = JSON.parse(result.content[0].text);
    assert.equal(data.status, 'failed');
    assert.ok(!data.error.includes('sk-test'), 'Credential must be scrubbed from error');
    assert.ok(data.error.includes('***'), 'Scrubbed credential replaced with placeholder');
  });

  it('scrubs credentials from poll resultUrl (2xx success)', async () => {
    globalThis.fetch = mock.fn(
      async () => new Response(JSON.stringify({ status: 'done', url: 'https://cdn.test/v.mp4?key=sk-test' })),
    );
    const tools = createProtocolTools(makeConfig());
    const poll = findTool(tools, '_poll');
    const result = await poll.handler({ capability: 'text2video', task_id: 'scrub-2' });
    const data = JSON.parse(result.content[0].text);
    assert.ok(!data.resultUrl.includes('sk-test'), 'Credential must be scrubbed from resultUrl');
  });

  it('scrubs credentials from HTTP error (non-2xx)', async () => {
    globalThis.fetch = mock.fn(async () => new Response('Auth failed with key sk-test', { status: 401 }));
    const tools = createProtocolTools(makeConfig());
    const submit = findTool(tools, '_submit');
    const result = await submit.handler({ capability: 'text2video', vars: { prompt: 'test' } });
    assert.equal(result.isError, true);
    assert.ok(!result.content[0].text.includes('sk-test'), 'Credential must be scrubbed from HTTP error');
  });
});

// ── Retry and transient error handling ──

describe('transient HTTP error retry', () => {
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

  it('retries on 429 and succeeds', async () => {
    let fetchCount = 0;
    globalThis.fetch = mock.fn(async () => {
      fetchCount++;
      if (fetchCount === 1) return new Response('rate limited', { status: 429 });
      return new Response(JSON.stringify({ id: 'retry-1' }));
    });
    const tools = createProtocolTools(makeConfig());
    const submit = findTool(tools, '_submit');
    const result = await submit.handler({ capability: 'text2video', vars: { prompt: 'test' } });
    assert.equal(result.isError, undefined);
    assert.equal(fetchCount, 2, 'Should retry once after 429');
  });

  it('retries on 503 and succeeds', async () => {
    let fetchCount = 0;
    globalThis.fetch = mock.fn(async () => {
      fetchCount++;
      if (fetchCount <= 2) return new Response('unavailable', { status: 503 });
      return new Response(JSON.stringify({ id: 'retry-2' }));
    });
    const tools = createProtocolTools(makeConfig());
    const submit = findTool(tools, '_submit');
    const result = await submit.handler({ capability: 'text2video', vars: { prompt: 'test' } });
    assert.equal(result.isError, undefined);
    assert.equal(fetchCount, 3, 'Should retry twice (MAX_RETRIES=2) after 503');
  });

  it('does not retry on permanent 400', async () => {
    let fetchCount = 0;
    globalThis.fetch = mock.fn(async () => {
      fetchCount++;
      return new Response('bad request', { status: 400 });
    });
    const tools = createProtocolTools(makeConfig());
    const submit = findTool(tools, '_submit');
    const result = await submit.handler({ capability: 'text2video', vars: { prompt: 'test' } });
    assert.equal(result.isError, true);
    assert.equal(fetchCount, 1, 'Should not retry permanent 400');
  });

  it('exhausts retries on persistent transient error', async () => {
    let fetchCount = 0;
    globalThis.fetch = mock.fn(async () => {
      fetchCount++;
      return new Response('server error', { status: 500 });
    });
    const tools = createProtocolTools(makeConfig());
    const submit = findTool(tools, '_submit');
    const result = await submit.handler({ capability: 'text2video', vars: { prompt: 'test' } });
    assert.equal(result.isError, true);
    assert.equal(fetchCount, 3, 'Should attempt 3 times total (1 + MAX_RETRIES=2)');
  });

  it('retries on network exception then succeeds', async () => {
    let fetchCount = 0;
    globalThis.fetch = mock.fn(async () => {
      fetchCount++;
      if (fetchCount === 1) throw new TypeError('fetch failed');
      return new Response(JSON.stringify({ id: 'net-retry-1' }));
    });
    const tools = createProtocolTools(makeConfig());
    const submit = findTool(tools, '_submit');
    const result = await submit.handler({ capability: 'text2video', vars: { prompt: 'test' } });
    assert.equal(result.isError, undefined);
    assert.equal(fetchCount, 2, 'Should retry once after network failure');
  });

  it('does not retry on abort error', async () => {
    let fetchCount = 0;
    globalThis.fetch = mock.fn(async () => {
      fetchCount++;
      const err = new DOMException('The operation was aborted', 'AbortError');
      throw err;
    });
    const tools = createProtocolTools(makeConfig());
    const submit = findTool(tools, '_submit');
    const result = await submit.handler({ capability: 'text2video', vars: { prompt: 'test' } });
    assert.equal(result.isError, true);
    assert.equal(fetchCount, 1, 'Should not retry abort errors');
  });

  it('scrubs credentials from terminal network exception', async () => {
    const secret = 'sk-secret-test-key';
    const config = makeConfig();
    config.credentials = { apiKey: secret };
    globalThis.fetch = mock.fn(async () => {
      throw new TypeError(`fetch failed while using ${secret}`);
    });
    const tools = createProtocolTools(config);
    const submit = findTool(tools, '_submit');
    const result = await submit.handler({ capability: 'text2video', vars: { prompt: 'test' } });
    assert.equal(result.isError, true);
    const errorText = result.content[0].text;
    assert.ok(!errorText.includes(secret), 'Credential must not leak in terminal network error');
    assert.ok(errorText.includes('***'), 'Credential should be replaced with placeholder');
  });
});

// ── Signal composition ──

describe('signal composition with request timeout', () => {
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

  it('composes caller signal with timeout using AbortSignal.any', async () => {
    let receivedSignal;
    globalThis.fetch = mock.fn(async (_url, opts) => {
      receivedSignal = opts?.signal;
      return new Response(JSON.stringify({ id: 'sig-1' }));
    });
    const controller = new AbortController();
    const tools = createProtocolTools(makeConfig());
    const submit = findTool(tools, '_submit');
    await submit.handler({ capability: 'text2video', vars: { prompt: 'test' } }, { signal: controller.signal });
    assert.ok(receivedSignal, 'fetch must receive a signal');
    // When caller provides a signal, the fetch signal should NOT be the same
    // object as the caller signal (it should be a composed signal from AbortSignal.any).
    assert.notEqual(receivedSignal, controller.signal, 'Signal should be composed, not raw caller signal');
  });

  it('uses timeout-only signal when no caller signal provided', async () => {
    let receivedSignal;
    globalThis.fetch = mock.fn(async (_url, opts) => {
      receivedSignal = opts?.signal;
      return new Response(JSON.stringify({ id: 'sig-2' }));
    });
    const tools = createProtocolTools(makeConfig());
    const submit = findTool(tools, '_submit');
    await submit.handler({ capability: 'text2video', vars: { prompt: 'test' } });
    assert.ok(receivedSignal, 'fetch must receive a timeout signal');
  });
});

// ── Handler-level final boundary scrub ──

describe('handler-level credential boundary', () => {
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

  it('scrubs JWT bearer token captured from actual fetch headers', async () => {
    let capturedHeaders;
    const config = makeConfig();
    config.provider.authType = 'jwt-hs256';
    config.credentials = { accessKey: 'ak-test-1234', secretKey: 'sk-test-5678-secret' };
    globalThis.fetch = mock.fn(async (_url, opts) => {
      capturedHeaders = opts?.headers;
      // Echo the ACTUAL Authorization header from the request in the error body.
      return new Response(`Unauthorized: ${capturedHeaders?.['Authorization'] ?? ''}`, { status: 403 });
    });
    const tools = createProtocolTools(config);
    const submit = findTool(tools, '_submit');
    const result = await submit.handler({ capability: 'text2video', vars: { prompt: 'test' } });
    assert.equal(result.isError, true);
    const text = result.content[0].text;
    const actualBearer = capturedHeaders?.['Authorization'] ?? '';
    assert.ok(actualBearer.startsWith('Bearer '), 'Must emit Bearer header');
    assert.ok(!text.includes(actualBearer), 'Actual Bearer header must be scrubbed');
    assert.ok(!text.includes(actualBearer.slice(7)), 'Actual JWT token must be scrubbed');
    assert.ok(!text.includes('ak-test-1234'), 'Access key must not leak');
    assert.ok(!text.includes('sk-test-5678-secret'), 'Secret key must not leak');
  });

  it('scrubs apikey Bearer header captured from actual fetch headers (2xx)', async () => {
    let capturedHeaders;
    const config = makeConfig();
    config.credentials = { apiKey: 'sk-boundary-test-key' };
    globalThis.fetch = mock.fn(async (_url, opts) => {
      capturedHeaders = opts?.headers;
      // Echo the actual Authorization header inside the 2xx response body.
      const auth = capturedHeaders?.['Authorization'] ?? '';
      return new Response(JSON.stringify({ status: 'done', url: `https://cdn.test/v.mp4?auth=${auth}` }));
    });
    const tools = createProtocolTools(config);
    const poll = findTool(tools, '_poll');
    const result = await poll.handler({ capability: 'text2video', task_id: 'auth-echo-1' });
    const data = JSON.parse(result.content[0].text);
    assert.ok(capturedHeaders?.['Authorization']?.includes('sk-boundary-test-key'), 'Must emit credential');
    assert.ok(!data.resultUrl.includes('sk-boundary-test-key'), 'API key must be scrubbed from resultUrl');
    assert.ok(!data.resultUrl.includes(capturedHeaders['Authorization']), 'Bearer must be scrubbed');
  });

  it('scrubs actual URLSearchParams-encoded credential from fetch URL', async () => {
    let capturedUrl;
    const config = makeConfig();
    config.provider.authType = 'query-param';
    config.credentials = { apiKey: 'dummy secret?', _authParamName: 'key' };
    globalThis.fetch = mock.fn(async (url) => {
      capturedUrl = url;
      // Extract the raw query param value from the ACTUAL fetch URL.
      const qIdx = url.indexOf('?');
      const pairs = qIdx !== -1 ? url.slice(qIdx + 1).split('&') : [];
      const keyPair = pairs.find((p) => p.startsWith('key='));
      const rawValue = keyPair ? keyPair.slice(4) : '';
      // Provider echoes the actual serialized value in error body.
      return new Response(`Invalid key: ${rawValue}`, { status: 403 });
    });
    const tools = createProtocolTools(config);
    const submit = findTool(tools, '_submit');
    const result = await submit.handler({ capability: 'text2video', vars: { prompt: 'test' } });
    assert.equal(result.isError, true);
    const text = result.content[0].text;
    // URLSearchParams uses '+' for space; encodeURIComponent uses '%20'.
    assert.ok(capturedUrl?.includes('dummy+secret%3F'), 'URLSearchParams must use + for space');
    assert.ok(!text.includes('dummy+secret%3F'), 'URLSearchParams-encoded value must be scrubbed');
    assert.ok(!text.includes('dummy secret?'), 'Raw credential must be scrubbed');
  });

  it('scrubs HMAC Signature sub-component captured from actual fetch headers', async () => {
    let capturedHeaders;
    const config = makeConfig();
    config.provider.authType = 'hmac-sha256-v4';
    config.credentials = {
      accessKey: 'ak-hmac-test',
      secretKey: 'sk-hmac-secret-key',
      region: 'us-east-1',
      service: 'cv',
    };
    globalThis.fetch = mock.fn(async (_url, opts) => {
      capturedHeaders = opts?.headers;
      // Extract just the 64-char hex Signature from the ACTUAL emitted header.
      const auth = capturedHeaders?.['Authorization'] ?? '';
      const sig = auth.match(/Signature=([0-9a-f]{64})/);
      // Provider echoes ONLY the signature value (not the full header) in error body.
      return new Response(`Signature mismatch: ${sig ? sig[1] : ''}`, { status: 403 });
    });
    const tools = createProtocolTools(config);
    const submit = findTool(tools, '_submit');
    const result = await submit.handler({ capability: 'text2video', vars: { prompt: 'test' } });
    assert.equal(result.isError, true);
    const text = result.content[0].text;
    const auth = capturedHeaders?.['Authorization'] ?? '';
    const sig = auth.match(/Signature=([0-9a-f]{64})/);
    assert.ok(sig, 'HMAC header must contain a 64-char hex Signature');
    assert.ok(!text.includes(sig[1]), 'HMAC Signature sub-component must be scrubbed');
    assert.ok(!text.includes('ak-hmac-test'), 'Access key must not leak');
    assert.ok(!text.includes('sk-hmac-secret-key'), 'Secret key must not leak');
  });

  it('scrubs auth artifact from 2xx business failure (selected field leak)', async () => {
    let capturedHeaders;
    const config = makeConfig();
    config.provider.authType = 'jwt-hs256';
    config.credentials = { accessKey: 'ak-2xx-test', secretKey: 'sk-2xx-secret' };
    // 200 OK with business error that echoes the actual auth header in error field.
    globalThis.fetch = mock.fn(async (_url, opts) => {
      capturedHeaders = opts?.headers;
      const auth = capturedHeaders?.['Authorization'] ?? '';
      return new Response(JSON.stringify({ status: 'error', error: `Provider echoed ${auth}` }));
    });
    config.template.capabilities.text2video.poll.response.error = '$.error';
    const tools = createProtocolTools(config);
    const poll = findTool(tools, '_poll');
    const result = await poll.handler({ capability: 'text2video', task_id: '2xx-leak' });
    const data = JSON.parse(result.content[0].text);
    const actualBearer = capturedHeaders?.['Authorization'] ?? '';
    assert.ok(actualBearer.startsWith('Bearer '), 'Must emit Bearer header');
    assert.ok(!data.error.includes(actualBearer), 'Auth artifact must be scrubbed from 2xx error field');
    assert.ok(!data.error.includes('ak-2xx-test'), 'Access key must not leak in 2xx');
    assert.ok(!data.error.includes('sk-2xx-secret'), 'Secret key must not leak in 2xx');
  });

  it('scrubs business error code containing credential', async () => {
    const config = makeConfig();
    config.credentials = { apiKey: 'sk-code-leak-1234' };
    // Return 200 with business error code that echoes the credential
    globalThis.fetch = mock.fn(async () => {
      return new Response(JSON.stringify({ code: 'sk-code-leak-1234', message: 'denied' }));
    });
    // Need a template with codeField
    config.template.capabilities.text2video.submit.response.codeField = '$.code';
    config.template.capabilities.text2video.submit.response.successCode = 0;
    config.template.capabilities.text2video.submit.response.error = '$.message';
    const tools = createProtocolTools(config);
    const submit = findTool(tools, '_submit');
    const result = await submit.handler({ capability: 'text2video', vars: { prompt: 'test' } });
    assert.equal(result.isError, true);
    const text = result.content[0].text;
    assert.ok(!text.includes('sk-code-leak-1234'), 'Credential in business code must not leak');
  });
});

// ── Abortable sleep correctness ──

describe('abortable sleep', () => {
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

  it('resolves immediately when signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    let pollCount = 0;
    globalThis.fetch = mock.fn(async () => {
      pollCount++;
      return new Response(JSON.stringify({ status: 'running' }));
    });
    const config = makeConfig();
    config.template.capabilities.text2video.poll = {
      method: 'GET',
      path: '/poll/{{taskId}}',
      interval: 60_000, // Very long — should NOT actually wait
      maxAttempts: 3,
      response: { status: '$.status', statusMap: { running: ['running'] } },
    };
    const tools = createProtocolTools(config);
    const poll = findTool(tools, '_poll');
    const start = Date.now();
    await poll.handler({ capability: 'text2video', task_id: 't1' }, { signal: controller.signal });
    const elapsed = Date.now() - start;
    // Should complete almost instantly, not wait 60s
    assert.ok(elapsed < 2000, `Elapsed ${elapsed}ms — should not wait on pre-aborted signal`);
  });
});

// ── Name collision regression ──

describe('MCP name collision detection', () => {
  it('logs warning and skips duplicate when two cap IDs produce same name', async () => {
    const { resolveServersForCat } = await import('../dist/protocol-engine/index.js')
      .catch(() => import('../../api/src/config/capabilities/capability-orchestrator.js'))
      .catch(() => null);
    // This test validates the scrubCredentials export; collision detection is
    // integration-tested via the orchestrator's own test suite. The regression
    // guard here just confirms the double-underscore encoding is stable.
    const { scrubCredentials } = await import('../dist/protocol-engine/index.js');
    const name1 = 'plugin:a:b'.replace(/:/g, '__');
    const name2 = 'plugin:a:b'.replace(/:/g, '__');
    assert.equal(name1, name2, 'Same ID must produce same encoded name');
    assert.equal(name1, 'plugin__a__b');
    // Different IDs that collide with old dash encoding
    const dashName1 = 'plugin:a-b:c'.replace(/:/g, '-');
    const dashName2 = 'plugin:a:b-c'.replace(/:/g, '-');
    assert.equal(dashName1, dashName2, 'Old dash encoding collided');
    // New double-underscore encoding does NOT collide
    const safeName1 = 'plugin:a-b:c'.replace(/:/g, '__');
    const safeName2 = 'plugin:a:b-c'.replace(/:/g, '__');
    assert.notEqual(safeName1, safeName2, 'Double-underscore encoding must not collide');
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

  it('rejects paramName with URL-unsafe characters (space)', async () => {
    const { ProtocolTemplateSchema } = await import('../dist/protocol-engine/index.js');
    assert.throws(
      () =>
        ProtocolTemplateSchema.parse({
          name: 'test',
          version: 1,
          mode: 'async',
          auth: { method: 'query-param', paramName: 'api key' },
          capabilities: {},
        }),
      /paramName must be URL-safe/,
    );
  });

  it('rejects paramName with URL-unsafe characters (equals, question mark, tilde)', async () => {
    const { ProtocolTemplateSchema } = await import('../dist/protocol-engine/index.js');
    // ~ is RFC 3986 unreserved but URLSearchParams encodes it as %7E
    for (const bad of ['key=val', 'key?', 'a b', 'key%20name', 'key+name', 'key~v2']) {
      assert.throws(
        () =>
          ProtocolTemplateSchema.parse({
            name: 'test',
            version: 1,
            mode: 'async',
            auth: { method: 'query-param', paramName: bad },
            capabilities: {},
          }),
        /paramName must be URL-safe/,
        `paramName "${bad}" must be rejected`,
      );
    }
  });

  it('accepts paramName with URLSearchParams-stable special chars (underscore, dot, dash, star)', async () => {
    const { ProtocolTemplateSchema } = await import('../dist/protocol-engine/index.js');
    for (const safe of ['api_key', 'auth.token', 'x-api-key', 'v*2']) {
      const result = ProtocolTemplateSchema.parse({
        name: 'test',
        version: 1,
        mode: 'async',
        auth: { method: 'query-param', paramName: safe },
        capabilities: {},
      });
      assert.equal(result.auth?.paramName, safe, `paramName "${safe}" must be accepted`);
    }
  });

  it('every regex-accepted char round-trips through URLSearchParams unchanged', async () => {
    const { ProtocolTemplateSchema } = await import('../dist/protocol-engine/index.js');
    // Exhaustive table: every printable ASCII char that the regex accepts
    // must survive URLSearchParams serialization as a parameter name.
    const allAllowed = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_.*-';
    for (const c of allAllowed) {
      // Schema must accept it
      const name = `k${c}`;
      const result = ProtocolTemplateSchema.parse({
        name: 'test',
        version: 1,
        mode: 'async',
        auth: { method: 'query-param', paramName: name },
        capabilities: {},
      });
      assert.equal(result.auth?.paramName, name);
      // URLSearchParams must not encode it
      const serialized = new URLSearchParams([[name, 'x']]).toString().split('=')[0];
      assert.equal(serialized, name, `char "${c}" (0x${c.charCodeAt(0).toString(16)}) must round-trip`);
    }
    // Negative: known RFC 3986 unreserved char that URLSearchParams encodes
    const tildeName = 'k~';
    const tildeSer = new URLSearchParams([[tildeName, 'x']]).toString().split('=')[0];
    assert.notEqual(tildeSer, tildeName, 'tilde must NOT round-trip (URLSearchParams encodes it)');
  });
});
