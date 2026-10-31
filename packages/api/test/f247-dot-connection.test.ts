import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mock, test } from 'node:test';
import { createCatId } from '@cat-cafe/shared';
import { AgentKeyRegistry } from '../src/domains/cats/services/agents/agent-key/AgentKeyRegistry.js';
import { DotConnectionRuntime } from '../src/domains/cats/services/cloud-bridge/dot/DotConnectionRuntime.js';
import { DotConnectionService } from '../src/domains/cats/services/cloud-bridge/dot/DotConnectionService.js';
import { DotConnectionStore } from '../src/domains/cats/services/cloud-bridge/dot/DotConnectionStore.js';
import { DotPluginStateProjection } from '../src/domains/cats/services/cloud-bridge/dot/DotPluginStateProjection.js';
import { CHATGPT_DOT_PLUGIN_MANIFEST } from '../src/domains/plugin/chatgpt-dot-manifest.js';
import { OFFICIAL_PLUGIN_CATALOG } from '../src/domains/plugin/official-catalog.js';
import { OfficialPluginManagerCatalogAdapter } from '../src/domains/plugin/runtime-composition.js';

async function harness() {
  const directory = await mkdtemp(join(tmpdir(), 'f247-dot-'));
  const path = join(directory, 'connection.json');
  const keys = new AgentKeyRegistry();
  const store = new DotConnectionStore(path);
  let now = Date.now();
  let installed = true;
  let webhookCalls = 0;
  const options = {
    keys,
    store,
    ensureIdentity: async () => {},
    now: () => now,
    authority: async () => (installed ? { ownerUserId: 'owner', pluginInstanceId: 'pi_dot' } : null),
    sendWebhook: async (_url: string, _headers: Record<string, string>, body: string) => {
      webhookCalls++;
      return { status: 200, body: JSON.stringify({ challenge: JSON.parse(body).challenge }) };
    },
  };
  return {
    service: new DotConnectionService(options),
    keys,
    store,
    path,
    directory,
    options,
    webhookCalls: () => webhookCalls,
    advance: (milliseconds: number) => {
      now += milliseconds;
    },
    uninstall: () => {
      installed = false;
    },
  };
}
const signingSecret = `whsec_${Buffer.alloc(32, 4).toString('base64')}`;

test('legacy summon lists are discarded on recovery without rotating the connection or subscription', async () => {
  const h = await harness();
  try {
    const setup = await h.service.begin('owner');
    await h.service.subscribe(setup.credentialSecret, {
      attemptId: setup.attemptId!,
      pairingCode: setup.pairingCode!,
      url: 'https://example.com/dot',
      secret: signingSecret,
    });
    const original = JSON.parse(await readFile(h.path, 'utf8'));
    for (const allowedCatIds of [[], ['sonnet']]) {
      await writeFile(h.path, JSON.stringify({ ...original, allowedCatIds }));
      const restarted = new DotConnectionService({ ...h.options, store: new DotConnectionStore(h.path) });
      const state = (await restarted.current())!;
      assert.equal(Object.hasOwn(state, 'allowedCatIds'), false);
      const status = await restarted.status('owner');
      assert.equal(Object.hasOwn(status, 'allowedCatIds'), false);
      assert.equal(status.paired, true);
      assert.equal(status.subscription, 'active');
      assert.equal(state.attemptId, original.attemptId);
      assert.deepEqual(state.subscription, original.subscription);
      await restarted.setOwnerPreferences('owner', { testEventIds: [] });
      assert.equal(Object.hasOwn(JSON.parse(await readFile(h.path, 'utf8')), 'allowedCatIds'), false);
    }
    await writeFile(h.path, JSON.stringify({ ...original, unexpectedAuthority: true }));
    await assert.rejects(() => h.store.read(), /unrecognized_keys/);
  } finally {
    await rm(h.directory, { recursive: true, force: true });
  }
});

test('owner setup can recover an unsubscribed dot after the old pairing window', async () => {
  const h = await harness();
  try {
    const first = await h.service.begin('owner');
    const input = {
      attemptId: first.attemptId!,
      pairingCode: first.pairingCode!,
      url: 'https://example.com/dot',
      secret: signingSecret,
    };
    await h.service.subscribe(first.credentialSecret, input);
    h.advance(31 * 60_000);
    await h.service.unsubscribe(first.credentialSecret, input.url, input.attemptId);
    const next = await h.service.begin('owner');
    assert.notEqual(next.attemptId, first.attemptId);
    await h.service.subscribe(next.credentialSecret, {
      ...input,
      attemptId: next.attemptId!,
      pairingCode: next.pairingCode!,
    });
    assert.equal((await h.service.status()).subscription, 'active');
  } finally {
    await rm(h.directory, { recursive: true, force: true });
  }
});

test('a non-expiring dot subscription retains its credential beyond 45 days while Pro keeps its default expiry', async () => {
  let now = Date.now();
  const clock = mock.method(Date, 'now', () => now);
  const h = await harness();
  try {
    const pro = await h.keys.issue(createCatId('gpt-pro'), 'owner');
    const setup = await h.service.begin('owner');
    const input = {
      attemptId: setup.attemptId!,
      pairingCode: setup.pairingCode!,
      url: 'https://example.com/dot',
      secret: signingSecret,
      ttlMs: null,
    };
    await h.service.subscribe(setup.credentialSecret, input);
    now += 46 * 24 * 60 * 60_000;
    h.advance(46 * 24 * 60 * 60_000);
    assert.equal((await h.service.status()).subscription, 'active');
    assert.equal((await h.keys.verify(pro.secret)).ok, false);
    await h.service.subscribe(setup.credentialSecret, input);
    await h.service.disconnect('owner');
    assert.equal((await h.keys.verify(setup.credentialSecret)).ok, false);
  } finally {
    clock.mock.restore();
    await rm(h.directory, { recursive: true, force: true });
  }
});

test('pairing grants only dot identity, persists across restart, and never projects the signing secret', async () => {
  const h = await harness();
  try {
    const connection = await h.service.begin('owner');
    assert.ok(connection.pairingCode);
    const input = {
      attemptId: connection.attemptId!,
      pairingCode: connection.pairingCode!,
      url: 'https://example.com/dot',
      secret: signingSecret,
    };
    const first = await h.service.subscribe(connection.credentialSecret, input);
    const second = await h.service.subscribe(connection.credentialSecret, input);
    assert.equal(first.id, second.id);
    const restarted = new DotConnectionService({ ...h.options, store: new DotConnectionStore(h.path) });
    const status = await restarted.status();
    assert.equal(status.paired, true);
    assert.equal(status.replyAt, null, 'a verified webhook has not proved any source reply');
    assert.equal(status.imageAt, null);
    assert.equal(JSON.stringify(status).includes(signingSecret), false);
    assert.equal((await stat(h.path)).mode & 0o777, 0o600);
    assert.ok(JSON.parse(await readFile(h.path, 'utf8')).subscription);
  } finally {
    await rm(h.directory, { recursive: true, force: true });
  }
});

test('subscription renewal caches recent verification; secret rotation re-verifies and retains a bounded overlap', async () => {
  const h = await harness();
  try {
    const connection = await h.service.begin('owner');
    const input = {
      attemptId: connection.attemptId!,
      pairingCode: connection.pairingCode!,
      url: 'https://example.com/dot',
      secret: signingSecret,
    };
    await h.service.subscribe(connection.credentialSecret, input);
    await h.service.subscribe(connection.credentialSecret, input);
    assert.equal(h.webhookCalls(), 1);
    const rotated = `whsec_${Buffer.alloc(32, 5).toString('base64')}`;
    await h.service.subscribe(connection.credentialSecret, { ...input, secret: rotated });
    assert.equal(h.webhookCalls(), 2);
    const saved = (await h.store.read())!.subscription!;
    assert.equal(saved.previousSecret, signingSecret);
    assert.equal(saved.rotationUntil! - saved.verifiedAt, 5 * 60_000);
    h.advance(6 * 60_000);
    await h.service.subscribe(connection.credentialSecret, { ...input, secret: rotated });
    assert.equal(h.webhookCalls(), 3);
  } finally {
    await rm(h.directory, { recursive: true, force: true });
  }
});

test('Host setup facts require both source returns and active authority, separately from installation', async () => {
  const h = await harness();
  try {
    const dot = OFFICIAL_PLUGIN_CATALOG.find((entry) => entry.pluginId === 'official.chatgpt-dot')!;
    const provider = { snapshot: async () => ({ entries: [dot], status: 'fresh' as const, checkedAt: 1 }) };
    const candidate = (
      await new OfficialPluginManagerCatalogAdapter(provider, [CHATGPT_DOT_PLUGIN_MANIFEST]).snapshot()
    ).candidates[0]!;
    let bothVerified = false;
    const projection = new DotPluginStateProjection(
      () => h.service,
      async () => bothVerified,
    );
    const runtime = new DotConnectionRuntime(
      () => h.service,
      async () => bothVerified,
    );
    assert.deepEqual(await projection.read(candidate), { authState: 'disconnected', configState: 'incomplete' });
    const connection = await h.service.begin('owner');
    assert.deepEqual(await projection.read(candidate), { authState: 'pending', configState: 'incomplete' });
    await h.service.subscribe(connection.credentialSecret, {
      attemptId: connection.attemptId!,
      pairingCode: connection.pairingCode!,
      url: 'https://example.com/dot',
      secret: signingSecret,
      ttlMs: 60_000,
    });
    await h.service.recordEvidence(await h.service.authenticate(connection.credentialSecret), 'reply');
    assert.deepEqual(await projection.read(candidate), { authState: 'connected', configState: 'incomplete' });
    await assert.rejects(() => runtime.start('pi_dot'), /round_trip_not_verified/);
    bothVerified = true;
    assert.deepEqual(await projection.read(candidate), { authState: 'connected', configState: 'ready' });
    await runtime.start('pi_dot');
    h.advance(61_000);
    assert.deepEqual(await projection.read(candidate), { authState: 'expired', configState: 'incomplete' });
    await assert.rejects(() => runtime.start('pi_dot'), /round_trip_not_verified/);
    await h.service.unsubscribe(connection.credentialSecret, 'https://example.com/dot', connection.attemptId!);
    assert.deepEqual(await projection.read(candidate), { authState: 'pending', configState: 'incomplete' });
    await h.service.disconnect('owner');
    assert.deepEqual(await projection.read(candidate), { authState: 'disconnected', configState: 'incomplete' });
    assert.deepEqual(
      await projection.read({ ...candidate, pluginId: 'personal-chrome-host' }),
      {},
      'Pro retains its original state owner',
    );
  } finally {
    await rm(h.directory, { recursive: true, force: true });
  }
});

test('dot disconnect rejects its credential and retains history, without revoking Pro', async () => {
  const h = await harness();
  try {
    const pro = await h.keys.issue(createCatId('gpt-pro'), 'owner');
    const connection = await h.service.begin('owner');
    await assert.rejects(() => h.service.authenticate(pro.secret), /dot_credential_rejected/);
    await h.service.disconnect('owner');
    await assert.rejects(() => h.service.authenticate(connection.credentialSecret), /dot_credential_rejected/);
    assert.equal((await h.keys.verify(pro.secret)).ok, true);
    assert.equal((await h.store.read())?.revokedAt !== null, true);
  } finally {
    await rm(h.directory, { recursive: true, force: true });
  }
});

test('expired pairing and uninstalled instances cannot acquire or retain dot access', async () => {
  const h = await harness();
  try {
    await assert.rejects(() => h.service.begin('another-owner'), /owner_unavailable/);
    const connection = await h.service.begin('owner');
    h.advance(31 * 60_000);
    await assert.rejects(
      () =>
        h.service.subscribe(connection.credentialSecret, {
          attemptId: connection.attemptId!,
          pairingCode: connection.pairingCode!,
          url: 'https://example.com/dot',
          secret: signingSecret,
        }),
      /pairing_expired/,
    );
    h.uninstall();
    await assert.rejects(() => h.service.authenticate(connection.credentialSecret), /owner_unavailable/);
    assert.equal((await h.service.status()).installed, false);
    assert.ok(await h.store.read(), 'uninstall does not delete user history');
  } finally {
    await rm(h.directory, { recursive: true, force: true });
  }
});

test('reopening setup preserves an already paired dot after the pairing code expires', async () => {
  const h = await harness();
  try {
    const connection = await h.service.begin('owner');
    await h.service.subscribe(connection.credentialSecret, {
      attemptId: connection.attemptId!,
      pairingCode: connection.pairingCode!,
      url: 'https://example.com/dot',
      secret: signingSecret,
    });
    h.advance(31 * 60_000);
    const reopened = await h.service.begin('owner');
    assert.equal(reopened.attemptId, connection.attemptId);
    assert.equal((await h.service.status()).subscription, 'active');
  } finally {
    await rm(h.directory, { recursive: true, force: true });
  }
});

test('a paired target cannot change callback with an old pairing attempt, including after unsubscribe', async () => {
  const h = await harness();
  try {
    const first = await h.service.begin('owner');
    const input = {
      attemptId: first.attemptId!,
      pairingCode: first.pairingCode!,
      url: 'https://example.com/first',
      secret: signingSecret,
    };
    await h.service.subscribe(first.credentialSecret, input);
    await assert.rejects(
      () => h.service.subscribe(first.credentialSecret, { ...input, url: 'https://example.com/replacement' }),
      /repair_required/,
    );
    await h.service.unsubscribe(first.credentialSecret, input.url, input.attemptId);
    await assert.rejects(
      () => h.service.subscribe(first.credentialSecret, { ...input, url: 'https://example.com/replacement' }),
      /repair_required/,
    );
    const next = await h.service.begin('owner', true);
    await h.service.subscribe(next.credentialSecret, {
      ...input,
      attemptId: next.attemptId!,
      pairingCode: next.pairingCode!,
      url: 'https://example.com/replacement',
    });
  } finally {
    await rm(h.directory, { recursive: true, force: true });
  }
});
