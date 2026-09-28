import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';

/*
 * Registering tracking reads a live GitHub baseline and installs the next wait generation, so it is
 * not idempotent. The shared callback transport gives each attempt 10 s and replays a failed POST
 * three times. A registration slower than 10 s was therefore sent up to four times, each replay
 * rerunning the whole registration against the same slow GitHub, and after 47 s the caller was told
 * it had timed out, although a registration had landed.
 */
describe('tracking registration is one attempt that waits for a slow GitHub', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env.CAT_CAFE_API_URL = 'http://localhost:3004';
    process.env.CAT_CAFE_INVOCATION_ID = 'inv-test';
    process.env.CAT_CAFE_CALLBACK_TOKEN = 'cb-test';
    // The shared transport defaults, shrunk: a 10 ms attempt and immediate replays.
    process.env.CAT_CAFE_CALLBACK_FETCH_TIMEOUT_MS = '10';
    process.env.CAT_CAFE_CALLBACK_RETRY_DELAYS_MS = '0,0,0';
  });

  afterEach(() => {
    mock.restoreAll();
    process.env = { ...originalEnv };
  });

  /** A server that answers only after `ms`, as a registration reading a slow GitHub does. */
  function slowServer(ms) {
    return mock.method(
      globalThis,
      'fetch',
      (_url, init) =>
        new Promise((resolve, reject) => {
          const timer = setTimeout(
            () =>
              resolve(
                new Response(JSON.stringify({ status: 'ok' }), {
                  status: 200,
                  headers: { 'content-type': 'application/json' },
                }),
              ),
            ms,
          );
          init?.signal?.addEventListener('abort', () => {
            clearTimeout(timer);
            reject(init.signal.reason ?? new DOMException('The operation was aborted', 'AbortError'));
          });
        }),
    );
  }

  const registrations = [
    ['register_pr_tracking', 'handleRegisterPrTracking', { repoFullName: 'owner/repo', prNumber: 7 }],
    ['register_issue_tracking', 'handleRegisterIssueTracking', { repoFullName: 'owner/repo', issueNumber: 8 }],
  ];

  for (const [tool, handler, input] of registrations) {
    it(`${tool}: a slow registration is sent once and its answer comes back`, async () => {
      const fetchMock = slowServer(60);
      const tools = await import('../dist/tools/callback-tools.js');

      const result = await tools[handler](input);

      assert.equal(fetchMock.mock.calls.length, 1, 'a registration is never replayed');
      assert.ok(!result.isError, `the server's answer is returned: ${result.content[0].text}`);
      assert.deepEqual(JSON.parse(result.content[0].text), { status: 'ok' });
    });

    it(`${tool}: a transport failure says the registration may still have been applied`, async () => {
      const fetchMock = mock.method(globalThis, 'fetch', async () => {
        throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
      });
      const tools = await import('../dist/tools/callback-tools.js');

      const result = await tools[handler](input);

      assert.equal(fetchMock.mock.calls.length, 1, 'a registration is never replayed');
      assert.equal(result.isError, true);
      const text = result.content[0].text;
      assert.match(text, /^Callback request failed: The operation was aborted due to timeout/);
      assert.match(text, /may still have been applied/);
      assert.match(text, /cat_cafe_list_tasks/, 'and where to check before registering again');
    });

    for (const status of [500, 502, 504]) {
      it(`${tool}: an HTTP ${status} is sent once and says the registration may still have been applied`, async () => {
        // A 5xx proves nothing about the write: the route may have thrown after its CAS, and a
        // gateway in front of CAT_CAFE_API_URL may answer 502/504 after the upstream committed.
        const fetchMock = mock.method(globalThis, 'fetch', async () => new Response('upstream error', { status }));
        const tools = await import('../dist/tools/callback-tools.js');

        const result = await tools[handler](input);

        assert.equal(fetchMock.mock.calls.length, 1, 'a registration is never replayed');
        assert.equal(result.isError, true);
        assert.match(result.content[0].text, new RegExp(`^Callback failed \\(${status}\\)`));
        assert.match(result.content[0].text, /may still have been applied/);
      });
    }

    it(`${tool}: an HTTP 408 is a request the server never received, so it carries no note`, async () => {
      // RFC 9110 §15.5.9: the server did not receive a complete request within its timeout.
      mock.method(globalThis, 'fetch', async () => new Response('request timeout', { status: 408 }));
      const tools = await import('../dist/tools/callback-tools.js');

      const result = await tools[handler](input);

      assert.equal(result.isError, true);
      assert.match(result.content[0].text, /^Callback failed \(408\)/);
      assert.doesNotMatch(result.content[0].text, /may still have been applied/);
    });

    it(`${tool}: an auth rejection keeps its F174 degrade hint and gets no note`, async () => {
      const fetchMock = mock.method(
        globalThis,
        'fetch',
        async () =>
          new Response(JSON.stringify({ error: 'callback_auth_failed', reason: 'unknown_invocation' }), {
            status: 401,
          }),
      );
      const tools = await import('../dist/tools/callback-tools.js');

      const result = await tools[handler](input);

      assert.equal(fetchMock.mock.calls.length, 1);
      assert.equal(result.isError, true);
      assert.match(result.content[0].text, new RegExp(`\\[degrade\\] tool=${tool} reason=unknown_invocation`));
      assert.doesNotMatch(result.content[0].text, /may still have been applied/);
    });

    it(`${tool}: an agent-key registration is sent once as well`, async () => {
      delete process.env.CAT_CAFE_INVOCATION_ID;
      delete process.env.CAT_CAFE_CALLBACK_TOKEN;
      delete process.env.CAT_CAFE_CREDENTIAL_FILE;
      delete process.env.CAT_CAFE_AGENT_KEY_FILE;
      delete process.env.CAT_CAFE_AGENT_KEY_FILES;
      delete process.env.CAT_CAFE_AGENT_KEY_BOUND_CAT_ID;
      process.env.CAT_CAFE_AGENT_KEY_SECRET = 'agent-key-only';
      const fetchMock = slowServer(60);
      const tools = await import('../dist/tools/callback-tools.js');

      const result = await tools[handler](input);

      assert.equal(fetchMock.mock.calls.length, 1, 'a registration is never replayed');
      assert.ok(!result.isError, `the server's answer is returned: ${result.content[0].text}`);
      assert.equal(fetchMock.mock.calls[0].arguments[1].headers['x-agent-key-secret'], 'agent-key-only');
    });

    it(`${tool}: a definitive rejection carries no such note`, async () => {
      mock.method(
        globalThis,
        'fetch',
        async () => new Response(JSON.stringify({ error: 'PR not found' }), { status: 400 }),
      );
      const tools = await import('../dist/tools/callback-tools.js');

      const result = await tools[handler](input);

      assert.equal(result.isError, true);
      assert.match(result.content[0].text, /^Callback failed \(400\)/);
      assert.doesNotMatch(result.content[0].text, /may still have been applied/);
    });
  }
});
