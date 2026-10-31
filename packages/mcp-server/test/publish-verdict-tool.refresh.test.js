import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import { z } from 'zod';

import { handlePublishVerdict, publishVerdictInputSchema } from '../dist/tools/publish-verdict-tool.js';

describe('cat_cafe_publish_verdict refresh action', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env.CAT_CAFE_API_URL = 'http://localhost:3004';
    process.env.CAT_CAFE_INVOCATION_ID = 'inv-test';
    process.env.CAT_CAFE_CALLBACK_TOKEN = 'cb-test';
  });

  afterEach(() => {
    mock.restoreAll();
    process.env = { ...originalEnv };
  });

  it('accepts an exact-head refresh action without replaying packet or sourceRefs', () => {
    const result = z.object(publishVerdictInputSchema).safeParse({
      domainId: 'eval:a2a',
      action: {
        kind: 'refresh_pr',
        verdictId: '2026-08-02-eval-a2a-refresh',
        expectedHeadSha: 'a'.repeat(40),
      },
    });
    assert.ok(result.success, JSON.stringify(result));
  });

  it('routes refresh through the existing resource tool and the dedicated API transition', async () => {
    const fetchMock = mock.method(
      globalThis,
      'fetch',
      async () =>
        new Response(JSON.stringify({ ok: true, outcome: 'updated' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );

    const result = await handlePublishVerdict({
      domainId: 'eval:a2a',
      action: {
        kind: 'refresh_pr',
        verdictId: '2026-08-02-eval-a2a-refresh',
        expectedHeadSha: 'a'.repeat(40),
      },
    });

    assert.equal(fetchMock.mock.calls.length, 1);
    const [url, init] = fetchMock.mock.calls[0].arguments;
    assert.equal(url, 'http://localhost:3004/api/eval-domains/eval%3Aa2a/publish-verdict/refresh');
    assert.deepEqual(JSON.parse(init.body), {
      verdictId: '2026-08-02-eval-a2a-refresh',
      expectedHeadSha: 'a'.repeat(40),
    });
    assert.deepEqual(result, {
      content: [{ type: 'text', text: JSON.stringify({ ok: true, outcome: 'updated' }) }],
    });
  });

  it('rejects mixed publish and refresh forms before either network path runs', async () => {
    const fetchMock = mock.method(globalThis, 'fetch', async () => {
      throw new Error('network must not run');
    });

    const result = await handlePublishVerdict({
      domainId: 'eval:a2a',
      action: {
        kind: 'refresh_pr',
        verdictId: '2026-08-02-eval-a2a-refresh',
        expectedHeadSha: 'a'.repeat(40),
      },
      packet: { id: 'mixed' },
      sourceRefs: { snapshotName: 'snap.yaml', attributionName: 'attr.yaml' },
    });

    assert.equal(fetchMock.mock.calls.length, 0);
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /exactly one lifecycle form/i);
  });
});
