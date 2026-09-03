import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import { runAlphaUat, unsupportedJourney } from '../../../scripts/f296-alpha-uat.mjs';

test('keeps dynamic presentation unsupported when the cold producer trace is unavailable', async (t) => {
  const originalFetch = globalThis.fetch;
  const sessionCookie = `cat_cafe_session=${'1'.repeat(64)}`;
  const deployedRevision = execFileSync('git', ['rev-parse', 'origin/main'], { encoding: 'utf8' }).trim();
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = async (input) => {
    const url = new URL(input);
    if (url.pathname === '/api/session') {
      return Response.json(
        { userId: 'default-user' },
        { headers: { 'set-cookie': `${sessionCookie}; Path=/; HttpOnly` } },
      );
    }
    if (url.pathname === '/health') return Response.json({ deploymentRevision: deployedRevision });
    if (url.pathname === '/ready') return Response.json({ status: 'ready' });
    if (url.pathname === '/api/cats') {
      return Response.json({
        cats: [{ id: 'codex', clientId: 'openai', codexCarrier: { effective: 'app_server' } }],
      });
    }
    if (url.pathname === '/api/threads') return Response.json({ id: 'canary-thread' });
    if (url.pathname === '/api/telemetry/metrics') return new Response('', { status: 200 });
    if (url.pathname === '/api/threads/canary-thread/f296-alpha-dynamic-canary') {
      return Response.json({
        status: 'processing',
        invocationId: 'parent-1',
        producer: 'meeting_artifact',
        opportunityKind: 'memory_write_opportunity',
      });
    }
    if (url.pathname === '/api/invocations/parent-1') return Response.json({ status: 'succeeded' });
    if (url.pathname === '/api/invocations/parent-1/executions') {
      return Response.json({ executionCount: 0, executions: [] });
    }
    if (url.pathname.endsWith('/compact-native')) {
      return Response.json({ code: 'NATIVE_COMPACTION_UNSUPPORTED' }, { status: 409 });
    }
    return Response.json({}, { status: 404 });
  };

  const manifest = await runAlphaUat({
    apiUrl: 'http://127.0.0.1:3012',
    redisUrl: 'redis://127.0.0.1:6398',
    catId: 'codex',
    userId: 'f296-alpha-uat',
    timeoutMs: 1000,
    pollMs: 100,
  });
  assert.deepEqual(manifest.journeys[0], unsupportedJourney('cold', 'telemetry_signal_missing'));
  assert.deepEqual(manifest.dynamicPresentation, {
    outcome: 'unsupported',
    reason: 'telemetry_signal_missing',
    observation: null,
  });
});
