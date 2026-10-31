import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { createCatId } from '@cat-cafe/shared';
import { validateCompanionReply } from '@clowder-ai/plugin-contract-beta27';
import { createCompanionClient } from '@clowder-ai/plugin-sdk-beta23/companion';
import { LivePresentationObservations } from '../src/domains/concierge/live/live-presentation-observations.js';
import { PUBLISHED_COMPANION_PRESENTATION } from '../src/domains/plugin/desktop-window-runtime/published-companion-v2.js';
import { FilePluginInventoryStore } from '../src/domains/plugin/host-inventory/stores.js';
import { modernCompanionInstallFixture } from './helpers/f317-companion-install-fixture.js';

test('installed alpha.24 archive carries one beta.27 ABI from package admission through Broker and the public SDK receipt', async (t) => {
  const callId = randomUUID();
  let port: LivePresentationObservations | undefined;
  const facts: string[] = [];
  const f = await modernCompanionInstallFixture(t, '0.1.0-alpha.24', undefined, (receipt, verifyHost) => {
    assert.ok(port);
    return port.observe(receipt, verifyHost);
  });
  f.config.dutyCatProfileId = 'codex';
  f.app.post('/api/concierge/live', async () => ({ callId, state: 'ready' }));
  f.app.get('/api/concierge/live/:id', async () => ({
    callId,
    catId: 'codex',
    state: 'ready',
    toolsReady: true,
    nativeActivity: 'none',
    nativeWork: { scopeId: null, revision: 0, active: [], recent: [] },
  }));
  f.app.post('/api/concierge/live/:id/stop', async () => ({ stopped: true }));
  port = new LivePresentationObservations({
    scope: { userId: 'modern-composition-owner', threadId: 'home', catId: 'codex', callId },
    session: () => 'rtc',
    available: () => true,
    verify: async () => true,
    store: f.messages,
    observed: (_receipt, nativeItemId) => {
      facts.push(nativeItemId);
    },
  });
  t.after(() => port?.close());
  const client = createCompanionClient({
    request: async (command) => {
      assert.ok(f.launch.request);
      const reply = await f.launch.request(command);
      assert.ok(validateCompanionReply(reply));
      return reply;
    },
    subscribe: () => () => {},
  });
  assert.equal((await client.prepare()).phase, 'ready');
  const message = f.messages.append({
    userId: 'modern-composition-owner',
    threadId: 'home',
    from: { kind: 'agent', catId: createCatId('codex') },
    content: 'Fixture visible answer',
    mentions: [],
    timestamp: Date.now(),
    extra: {
      liveCompanion: {
        modality: 'voice',
        callId,
        nativeThreadId: 'root',
        realtimeSessionId: 'rtc',
        nativeItemId: 'item',
      },
    },
  });
  const observation = {
    event: 'first_text_visible' as const,
    observedAt: Date.now(),
    callId,
    reference: { kind: 'message' as const, messageId: message.id },
  };
  assert.deepEqual(await client.observePresentation(observation), { kind: 'ok' });
  assert.deepEqual(facts, ['item']);
  const reopened = await new FilePluginInventoryStore(f.runtime.paths.inventorySnapshotPath).snapshot();
  const restored = reopened.packages.find((p) => p.pluginId === 'official.companion' && p.version === '0.1.0-alpha.24');
  assert.ok(restored, 'a fresh production inventory reader must preserve the newly admitted archive');
  if (f.actualArchive) {
    const snapshot = await f.runtime.inventoryStore.snapshot();
    const installed = snapshot.packages.find(
      (p) => p.pluginId === 'official.companion' && p.version === '0.1.0-alpha.24',
    );
    assert.ok(installed);
    assert.equal(installed.packageDigest, PUBLISHED_COMPANION_PRESENTATION.packageDigest);
    assert.deepEqual(restored.manifest, installed.manifest);
    assert.equal(restored.packageDigest, installed.packageDigest);
    const page = await fetch(f.launch.url);
    assert.equal(page.status, 200);
    const source = await (await fetch(new URL('surface.mjs', f.launch.url))).text();
    assert.match(source, /observePresentation|presentation/);
  }
  await client.disableCompanion();
  await assert.rejects(client.observePresentation(observation));
  assert.deepEqual(facts, ['item']);
  assert.equal(f.closes(), 1);
  assert.equal(await f.runtime.desktopWindows?.presence(), null);
});
