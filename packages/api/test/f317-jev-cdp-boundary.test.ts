import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import {
  createConfiguredJevPageProfile,
  pageConfigSchema,
} from '../src/domains/concierge/action/jev/ConfiguredJevPage.js';
import { createOwnerCdpConnector } from '../src/domains/concierge/action/jev/OwnerCdpConnector.js';

test('local CDP discovery cannot redirect the owner grant to an external, different-port, credentialed or unbounded endpoint', async () => {
  let payload = '{}';
  const server = createServer((_req, res) => res.end(payload));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const config = {
    profileId: 'owner-note',
    pageUrl: 'http://127.0.0.1:5227/',
    browserURL: `http://127.0.0.1:${address.port}`,
    allowJevProjection: true,
    targets: [{ id: 'note', selector: '#note', operation: 'fill', expectedReadbackTemplate: '{value}' }],
    readback: { selector: '#note', kind: 'value' },
  };
  const parsed = pageConfigSchema.parse(config);
  const profile = createConfiguredJevPageProfile(parsed, {
    async select() {
      throw new Error('Must not select');
    },
  });
  try {
    for (const endpoint of [
      'ws://external.example/devtools/browser/owner',
      'ws://127.0.0.1:3004/devtools/browser/owner',
      `ws://user:pass@127.0.0.1:${address.port}/devtools/browser/owner`,
      `ws://127.0.0.1:${address.port}/devtools/browser/owner?secret=x`,
    ]) {
      payload = JSON.stringify({ webSocketDebuggerUrl: endpoint });
      await assert.rejects(createOwnerCdpConnector(parsed).open(profile, AbortSignal.timeout(1000)), /grant|endpoint/);
    }
    payload = 'x'.repeat(8193);
    await assert.rejects(createOwnerCdpConnector(parsed).open(profile, AbortSignal.timeout(1000)), /bound/);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
