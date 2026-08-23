import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { describe, test } from 'node:test';
import { RESUMED_LARGE_CONTENT, runAlphaUat, selectProviderExecution } from '../../../scripts/f296-alpha-uat.mjs';
import { estimateTokens } from '../dist/utils/token-counter.js';

const options = {
  apiUrl: 'http://127.0.0.1:3012',
  redisUrl: 'redis://127.0.0.1:6398',
  catId: 'codex',
  userId: 'f296-alpha-uat',
  timeoutMs: 1000,
  pollMs: 100,
};

describe('F296 B4c Alpha UAT runner child and session guards', () => {
  test('bootstraps a real API session and carries its cookie into telemetry reads', async (t) => {
    const originalFetch = globalThis.fetch;
    const calls = [];
    const sessionCookie = `cat_cafe_session=${'0'.repeat(64)}`;
    const deployedRevision = execFileSync('git', ['rev-parse', 'origin/main'], { encoding: 'utf8' }).trim();
    t.after(() => {
      globalThis.fetch = originalFetch;
    });
    globalThis.fetch = async (input, init = {}) => {
      const path = new URL(input).pathname;
      const cookie = init.headers?.cookie;
      calls.push({ path, cookie });
      if (path === '/api/session') {
        return new Response(JSON.stringify({ userId: 'default-user' }), {
          status: 200,
          headers: { 'content-type': 'application/json', 'set-cookie': `${sessionCookie}; Path=/; HttpOnly` },
        });
      }
      if (path === '/health') return Response.json({ deploymentRevision: deployedRevision });
      if (path === '/ready') return Response.json({ status: 'ready' });
      if (path === '/api/cats') {
        return Response.json({
          cats: [{ id: 'codex', clientId: 'openai', codexCarrier: { effective: 'app_server' } }],
        });
      }
      if (path === '/api/telemetry/metrics') {
        return cookie === sessionCookie ? new Response('', { status: 200 }) : Response.json({}, { status: 401 });
      }
      if (path === '/api/threads') return Response.json({ id: '' });
      return Response.json({}, { status: 404 });
    };

    await assert.rejects(runAlphaUat(options), (error) => error?.reason === 'thread_creation_failed');
    assert.equal(calls[0].path, '/api/session');
    assert.equal(
      calls.filter((call) => call.path !== '/api/session').every((call) => call.cookie === sessionCookie),
      true,
    );
  });

  test('selects only the requested cat successful ordinary execution', () => {
    const ordinary = {
      invocationId: 'ordinary-child',
      catId: 'codex',
      status: 'succeeded',
      executionKind: 'ordinary',
    };
    assert.equal(selectProviderExecution([ordinary], 'codex'), ordinary);
    assert.equal(selectProviderExecution([{ ...ordinary, catId: 'sonnet' }], 'codex'), null);
    for (const status of ['running', 'failed']) {
      assert.equal(selectProviderExecution([{ ...ordinary, status }], 'codex'), null);
    }
    for (const executionKind of ['routing_guard', 'freshness_supplement', 'future_kind']) {
      assert.equal(selectProviderExecution([{ ...ordinary, executionKind }], 'codex'), null);
    }
  });

  test('rejects missing, misnamed, and malformed API session cookies', async (t) => {
    const originalFetch = globalThis.fetch;
    t.after(() => {
      globalThis.fetch = originalFetch;
    });
    for (const setCookie of [undefined, `other_cookie=${'0'.repeat(64)}`, 'cat_cafe_session=not-hex']) {
      globalThis.fetch = async () =>
        Response.json(
          { userId: 'default-user' },
          setCookie === undefined ? undefined : { headers: { 'set-cookie': setCookie } },
        );
      await assert.rejects(runAlphaUat(options), (error) => error?.reason === 'api_unavailable');
    }
  });

  test('keeps the resumed-large message inside the API limit and above the real unread-token threshold', () => {
    assert.equal(RESUMED_LARGE_CONTENT.length <= 100_000, true);
    assert.equal(estimateTokens(RESUMED_LARGE_CONTENT) > 10_000, true);
  });
});
