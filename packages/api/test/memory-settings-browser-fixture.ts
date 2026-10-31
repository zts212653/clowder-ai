/** Owner maintenance samples from the production route, in-memory SQLite; no listener/Redis. */
import assert from 'node:assert/strict';
import { recallFixture } from './memory-recall-fixture.js';

const fixture = await recallFixture();
try {
  await fixture.evidence.upsert([
    {
      anchor: 'settings-maintenance-proof',
      kind: 'feature',
      status: 'active',
      title: '索引维护样本',
      authority: 'observed',
      updatedAt: '2026-10-05',
    },
  ]);
  const samples: Record<string, { status: number; body: unknown }> = {};
  for (const url of ['/api/memory/maintenance', '/api/memory/catalog', '/api/memory/library-feed']) {
    const response = await fixture.app.inject({
      url,
      remoteAddress: '192.0.2.2',
      headers: { 'x-test-session': 'owner' },
    });
    assert.equal(response.statusCode, 200);
    samples[url] = { status: response.statusCode, body: response.json() };
    for (const session of [undefined, 'other']) {
      const denied = await fixture.app.inject({
        url,
        remoteAddress: '192.0.2.2',
        headers: session ? { 'x-test-session': session } : {},
      });
      assert.equal(denied.statusCode, session ? 403 : 401);
    }
  }
  console.log(`F321_SETTINGS_JSON=${JSON.stringify(samples)}`);
} finally {
  await fixture.close();
}
