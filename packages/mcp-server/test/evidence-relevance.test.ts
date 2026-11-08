import assert from 'node:assert/strict';
import { test } from 'node:test';
import { handleSearchEvidence } from '../dist/tools/evidence-tools.js';

test('rank alone neither calls unrelated results high matches nor suppresses alternate navigation', async () => {
  const saved = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        degraded: false,
        results: [
          {
            title: 'Generic template',
            anchor: 'doc:template',
            snippet: 'Background and acceptance',
            matchRank: 'high',
            sourceType: 'plan',
          },
        ],
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  try {
    const result = await handleSearchEvidence({ query: '不存在的专有术语Quasar' });
    const text = result.content[0].text;
    assert.doesNotMatch(text, /高匹配/);
    assert.match(text, /Memory navigation/);
    assert.match(text, /unknown|未知/);
  } finally {
    globalThis.fetch = saved;
  }
});
