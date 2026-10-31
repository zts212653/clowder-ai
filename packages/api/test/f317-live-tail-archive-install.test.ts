import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { COMPANION_ARCHIVE_CONTRACTS } from '../src/domains/plugin/desktop-window-runtime/published-companion-v2.js';
import { modernCompanionInstallFixture as fixture } from './helpers/f317-companion-install-fixture.js';

test('live-tail archive keeps beta.24 through production installation and serves the verified renderer', async (t) => {
  const f = await fixture(t, '0.1.0-alpha.20');
  assert.equal((await f.launch.request!({ kind: 'settings.read' })).kind, 'settings');
  assert.equal(f.closes(), 0);
  assert.equal((await f.messages.getById(f.saved.id))?.content, 'preserved');
  assert.equal(f.config.dutyCatProfileId, 'composition-selected');
  if (f.actualArchive) {
    const response = await fetch(new URL('recent-bubble.mjs', f.launch.url));
    assert.equal(response.status, 200);
    const source = await response.text();
    assert.equal(
      createHash('sha256').update(source).digest('hex'),
      '3143d2f918e5dfeb79791dc67c7d9614385bc17069dc5cf6573c1b407321aa3e',
    );
    assert.match(source, /Array\.from/);
    assert.match(source, /reverse\(\)/);
    const pkg = (await f.runtime.inventoryStore.snapshot()).packages.find(
      (row) => row.pluginId === 'official.companion' && row.version === '0.1.0-alpha.20',
    );
    assert.equal(
      pkg?.packageDigest,
      COMPANION_ARCHIVE_CONTRACTS.find((row) => row.version === '0.1.0-alpha.20')?.packageDigest,
    );
  }
});

test('a changed live-tail archive is rejected by the production installer before window admission', async (t) => {
  await assert.rejects(
    fixture(t, '0.1.0-alpha.20', (original) => {
      const changed = Buffer.from(original);
      changed[changed.length - 1] ^= 1;
      return changed;
    }),
    /digest|integrity/i,
  );
});
