import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';

describe('cat_cafe_publish_verdict task-outcome wrapper', () => {
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

  it('posts task-outcome-snapshot sourceRefs through callbackPost unchanged', async () => {
    const fetchMock = mock.method(
      globalThis,
      'fetch',
      async (url, init) =>
        new Response(
          JSON.stringify({
            ok: true,
            echo: {
              url,
              body: JSON.parse(init.body),
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    );
    const { handlePublishVerdict } = await import('../dist/tools/publish-verdict-tool.js');

    const result = await handlePublishVerdict({
      domainId: 'eval:task-outcome',
      packet: {
        id: 'vhp-task-outcome-mcp-test',
        domainId: 'eval:task-outcome',
        createdAt: '2026-06-09T03:30:00.000Z',
        phenomenon: 'mcp wrapper test',
        verdict: 'keep_observe',
      },
      sourceRefs: {
        kind: 'task-outcome-snapshot',
        windowStartMs: 1700000000000,
        windowEndMs: 1700086400000,
        episodeVerdicts: [{ episodeId: 'ep-123', verdict: 'corrected_success' }],
      },
    });

    assert.equal(fetchMock.mock.calls.length, 1);
    assert.deepEqual(result, {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            ok: true,
            echo: {
              url: 'http://localhost:3004/api/eval-domains/eval%3Atask-outcome/publish-verdict',
              body: {
                packet: {
                  id: 'vhp-task-outcome-mcp-test',
                  domainId: 'eval:task-outcome',
                  createdAt: '2026-06-09T03:30:00.000Z',
                  phenomenon: 'mcp wrapper test',
                  verdict: 'keep_observe',
                },
                sourceRefs: {
                  kind: 'task-outcome-snapshot',
                  windowStartMs: 1700000000000,
                  windowEndMs: 1700086400000,
                  episodeVerdicts: [{ episodeId: 'ep-123', verdict: 'corrected_success' }],
                },
              },
            },
          }),
        },
      ],
    });
  });
});
