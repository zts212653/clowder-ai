import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mediaHostFixture } from './collective-media-host.fixture.js';
import { mediaRangeFixture } from './collective-media-range.fixture.js';
import { after, before, test } from './helpers/f202-collective-installed-business.js';

const configuredOwner = process.env.DEFAULT_OWNER_USER_ID;
before(() => {
  delete process.env.DEFAULT_OWNER_USER_ID;
});
after(() => {
  if (configuredOwner !== undefined) process.env.DEFAULT_OWNER_USER_ID = configuredOwner;
});

test('the normal local picker lists only freshly authorized retained PNG/MP4 without exposing private source coordinates', async (t) => {
  const f = await mediaRangeFixture(t);
  const host = await mediaHostFixture(t, join(f.f.media.root, 'connector'), f.f.media.port);
  const path = `${host.url}/api/plugins/official.collective-connector/connections/${f.f.connection.connectionId}/artifacts/retained-media`;
  const response = await fetch(path, { headers: { cookie: 'test-session=publisher' } });
  assert.equal(response.status, 200, await response.clone().text());
  const body = await response.json();
  assert.equal(body.items.length, 1);
  assert.equal(body.items[0].contentRef, f.f.media.asset.contentRef);
  assert.equal(body.items[0].ownerRevision, 1);
  assert.doesNotMatch(JSON.stringify(body), /sourcePublication|ownerUserId|\/uploads|threadId|taskId|credential/);
  for (const headers of [
    {},
    { cookie: 'test-session=reader' },
    { cookie: 'test-session=publisher', origin: 'https://foreign.invalid' },
  ]) {
    const denied = await fetch(path, { headers });
    assert.ok([401, 403].includes(denied.status));
  }
  f.f.media.task.current = null;
  const recalled = await fetch(path, { headers: { cookie: 'test-session=publisher' } });
  assert.equal(recalled.status, 200);
  assert.deepEqual((await recalled.json()).items, []);
});
