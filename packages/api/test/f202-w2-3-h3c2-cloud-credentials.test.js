/**
 * F202 W2-3 h3c-2 — a cloud cat's credential says it is one (ledger「h3c 实现设计」h3c-2; astra's
 * design review, Host thread …000188, negative case 1).
 *
 * Whether an agent key belongs to the cloud authorization boundary is recorded on the key itself, when
 * the Host issues it for the cloud cat. It is not inferred from the cat's id or from today's cat
 * configuration, so a key issued for a cloud cat can never turn into an ordinary key because the
 * configuration changed afterwards.
 */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { AgentKeyRegistry } from '../dist/domains/cats/services/agents/agent-key/AgentKeyRegistry.js';
import {
  ensureCloudCatAgentKeySidecar,
  reconcileCloudCatAgentKeys,
  resolveCloudCatAgentKeyFile,
  revokeStaleCloudCatKeys,
} from '../dist/domains/cats/services/agents/agent-key/cloud-cat-agent-key-sidecar.js';
import { MemoryAgentKeyBackend } from '../dist/domains/cats/services/agents/agent-key/MemoryAgentKeyBackend.js';
import { RedisAgentKeyBackend } from '../dist/domains/cats/services/agents/agent-key/RedisAgentKeyBackend.js';
import { FakeRedis } from './helpers/fake-agent-key-redis.js';

const backends = [
  ['memory', () => new MemoryAgentKeyBackend()],
  ['redis', () => new RedisAgentKeyBackend(new FakeRedis())],
];

for (const [name, backend] of backends) {
  test(`${name}: a cloud-conversation key verifies as one, and an ordinary key stays user-bound`, async () => {
    const registry = new AgentKeyRegistry({ backend: backend() });
    const cloud = await registry.issue('cloud-alt', 'owner-1', { scope: 'cloud-conversation' });
    const ordinary = await registry.issue('codex', 'owner-1');

    const cloudResult = await registry.verify(cloud.secret);
    assert.equal(cloudResult.ok, true);
    assert.equal(cloudResult.record.scope, 'cloud-conversation');
    assert.equal((await registry.verify(ordinary.secret)).record.scope, 'user-bound');
  });

  test(`${name}: rotating a cloud key keeps it in the cloud boundary`, async () => {
    const registry = new AgentKeyRegistry({ backend: backend() });
    const cloud = await registry.issue('cloud-alt', 'owner-1', { scope: 'cloud-conversation' });

    const rotated = await registry.rotate(cloud.agentKeyId);

    assert.equal((await registry.get(rotated.agentKeyId)).scope, 'cloud-conversation');
    assert.equal((await registry.verify(rotated.secret)).record.scope, 'cloud-conversation');
  });
}

test('redis: a stored record with an unknown scope is not a key at all', async () => {
  const redis = new FakeRedis();
  const registry = new AgentKeyRegistry({ backend: new RedisAgentKeyBackend(redis) });
  const issued = await registry.issue('cloud-alt', 'owner-1', { scope: 'cloud-conversation' });
  for (const [, hash] of redis.hashes) {
    if (hash.get('agentKeyId') === issued.agentKeyId) hash.set('scope', 'everything');
  }
  assert.equal(await registry.get(issued.agentKeyId), null);
  assert.equal((await registry.verify(issued.secret)).ok, false);
});

// ── The cloud cat's sidecar: issued in the cloud scope, migrated from before, revoked when stale ──

const roots = [];
after(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function dataDir() {
  const root = await mkdtemp(join(tmpdir(), 'f202-h3c2-keys-'));
  roots.push(root);
  await mkdir(join(root, 'agent-keys'), { recursive: true, mode: 0o700 });
  return root;
}

test('the key file is named after the cloud cat; the old override stays with the cat it was made for', () => {
  const env = { CAT_CAFE_DATA_DIR: '/srv/data', CAT_CAFE_GPT_PRO_AGENT_KEY_FILE: '/run/secrets/gpt-pro' };
  assert.equal(resolveCloudCatAgentKeyFile('cloud-alt', env, '/home/x'), '/srv/data/agent-keys/cloud-alt.secret');
  assert.equal(resolveCloudCatAgentKeyFile('gpt-pro', env, '/home/x'), '/run/secrets/gpt-pro');
  assert.equal(
    resolveCloudCatAgentKeyFile('gpt-pro', { CAT_CAFE_DATA_DIR: '/srv/data' }, '/home/x'),
    '/srv/data/agent-keys/gpt-pro.secret',
  );
  assert.throws(() => resolveCloudCatAgentKeyFile('../escape', env, '/home/x'), /cat id/u);
});

test('a cloud cat of any id gets a cloud-scoped key published to its own file', async () => {
  const root = await dataDir();
  const registry = new AgentKeyRegistry();
  const env = { CAT_CAFE_DATA_DIR: root };

  const result = await ensureCloudCatAgentKeySidecar(registry, { catId: 'cloud-alt', userId: 'owner-1', env });

  assert.equal(result.kind, 'issued');
  const secret = (await readFile(join(root, 'agent-keys', 'cloud-alt.secret'), 'utf8')).trim();
  const verified = await registry.verify(secret);
  assert.equal(verified.record.catId, 'cloud-alt');
  assert.equal(verified.record.scope, 'cloud-conversation');
});

test('a key the cloud sidecar published before scopes existed is replaced by a cloud-scoped one and revoked', async () => {
  const root = await dataDir();
  const registry = new AgentKeyRegistry();
  const legacy = await registry.issue('gpt-pro', 'owner-1');
  await writeFile(join(root, 'agent-keys', 'gpt-pro.secret'), `${legacy.secret}\n`, { mode: 0o600 });

  const result = await ensureCloudCatAgentKeySidecar(registry, {
    catId: 'gpt-pro',
    userId: 'owner-1',
    env: { CAT_CAFE_DATA_DIR: root },
  });

  assert.equal(result.kind, 'replaced');
  assert.equal((await registry.verify(legacy.secret)).ok, false, 'the user-bound key no longer works');
  assert.equal((await registry.get(result.agentKeyId)).scope, 'cloud-conversation');
});

test('once a cat stops being the cloud cat, its cloud keys are revoked; nothing else is touched', async () => {
  const root = await dataDir();
  const registry = new AgentKeyRegistry();
  const env = { CAT_CAFE_DATA_DIR: root };
  const oldCloud = await registry.issue('gpt-pro', 'owner-1', { scope: 'cloud-conversation' });
  const oldCloudGrace = await registry.rotate(oldCloud.agentKeyId);
  const current = await registry.issue('cloud-alt', 'owner-1', { scope: 'cloud-conversation' });
  const ordinary = await registry.issue('codex', 'owner-1');

  const revoked = await revokeStaleCloudCatKeys(registry, { cloudCatIds: ['cloud-alt'], env });

  assert.deepEqual(revoked.sort(), [oldCloud.agentKeyId, oldCloudGrace.agentKeyId].sort());
  assert.equal((await registry.verify(oldCloud.secret)).ok, false, 'the rotation predecessor goes with it');
  assert.equal((await registry.verify(oldCloudGrace.secret)).ok, false);
  assert.equal((await registry.verify(current.secret)).ok, true);
  assert.equal((await registry.verify(ordinary.secret)).ok, true);
  assert.deepEqual(await revokeStaleCloudCatKeys(registry, { cloudCatIds: ['cloud-alt'], env }), [], 'idempotent');
});

// ── P1-2 (astra, h3c-2 review): the keys the Host issued for the cloud cat before keys carried a scope ──
// Before h3c-2 every key of `gpt-pro` was a cloud credential. The migration turns them into history:
// the ones issued up to the migration are revoked — the current one and any rotation grace it left
// behind — whatever the configuration says, so none of them can ever act as an ordinary key.

const cats = (entries) => ({
  getAllConfigs: () => Object.fromEntries(entries.map(([id, provider]) => [id, { provider }])),
});
const quietLog = { info() {}, warn() {} };

async function legacyChain(registry, root) {
  const original = await registry.issue('gpt-pro', 'owner-1');
  const rotated = await registry.rotate(original.agentKeyId);
  await writeFile(join(root, 'agent-keys', 'gpt-pro.secret'), `${rotated.secret}\n`, { mode: 0o600 });
  assert.equal((await registry.verify(original.secret)).ok, true, 'the grace key still works before the upgrade');
  return { original, rotated };
}

for (const [name, backend] of backends) {
  test(`${name}: the migration revokes the pre-upgrade cloud key and its rotation grace, then a rename leaves nothing behind`, async () => {
    const root = await dataDir();
    const env = { CAT_CAFE_DATA_DIR: root, DEFAULT_OWNER_USER_ID: 'owner-1' };
    const registry = new AgentKeyRegistry({ backend: backend() });
    const { original, rotated } = await legacyChain(registry, root);

    await reconcileCloudCatAgentKeys({ registry, cats: cats([['gpt-pro', 'openai-chatgpt-pro']]), env, log: quietLog });
    assert.equal((await registry.verify(original.secret)).ok, false, 'the grace key of the old chain is revoked');
    assert.equal((await registry.verify(rotated.secret)).ok, false);
    const published = (await readFile(join(root, 'agent-keys', 'gpt-pro.secret'), 'utf8')).trim();
    assert.equal((await registry.verify(published)).record.scope, 'cloud-conversation');

    await reconcileCloudCatAgentKeys({
      registry,
      cats: cats([['cloud-beta', 'openai-chatgpt-pro']]),
      env,
      log: quietLog,
    });
    assert.equal((await registry.verify(published)).ok, false);
    assert.deepEqual(
      (await registry.list({ catId: 'gpt-pro' })).map((record) => record.agentKeyId),
      [],
      'no key of the former cloud cat is left valid',
    );
  });

  test(`${name}: renamed before the upgrade — the old cloud cat's pre-upgrade keys are revoked all the same`, async () => {
    const root = await dataDir();
    const env = { CAT_CAFE_DATA_DIR: root, DEFAULT_OWNER_USER_ID: 'owner-1' };
    const registry = new AgentKeyRegistry({ backend: backend() });
    const { original, rotated } = await legacyChain(registry, root);
    const otherUser = await registry.issue('gpt-pro', 'someone-else');

    await reconcileCloudCatAgentKeys({
      registry,
      cats: cats([
        ['cloud-beta', 'openai-chatgpt-pro'],
        ['gpt-pro', 'openai'],
      ]),
      env,
      log: quietLog,
    });
    for (const key of [original, rotated, otherUser]) assert.equal((await registry.verify(key.secret)).ok, false);
  });

  test(`${name}: keys issued after the migration, and other cats' rotation grace, are left alone`, async () => {
    const root = await dataDir();
    const env = { CAT_CAFE_DATA_DIR: root, DEFAULT_OWNER_USER_ID: 'owner-1' };
    const registry = new AgentKeyRegistry({ backend: backend() });
    await writeFile(
      join(root, 'agent-keys', 'cloud-scope-migration.json'),
      `${JSON.stringify({ v: 1, cutoff: Date.now() - 60_000 })}\n`,
      { mode: 0o600 },
    );
    const laterOrdinary = await registry.issue('gpt-pro', 'owner-1');
    const codex = await registry.issue('codex', 'owner-1');
    const codexNext = await registry.rotate(codex.agentKeyId);

    await reconcileCloudCatAgentKeys({
      registry,
      cats: cats([
        ['cloud-beta', 'openai-chatgpt-pro'],
        ['gpt-pro', 'openai'],
        ['codex', 'openai'],
      ]),
      env,
      log: quietLog,
    });
    assert.equal(
      (await registry.verify(laterOrdinary.secret)).ok,
      true,
      'a key issued after the migration is not history',
    );
    assert.equal((await registry.verify(codex.secret)).ok, true, "an ordinary key's rotation grace is untouched");
    assert.equal((await registry.verify(codexNext.secret)).ok, true);
  });
}

test('each entry point retires the pre-scope keys on its own: the sidecar step alone…', async () => {
  const root = await dataDir();
  const registry = new AgentKeyRegistry();
  const { original, rotated } = await legacyChain(registry, root);

  await ensureCloudCatAgentKeySidecar(registry, {
    catId: 'gpt-pro',
    userId: 'owner-1',
    env: { CAT_CAFE_DATA_DIR: root },
  });
  assert.equal((await registry.verify(original.secret)).ok, false, 'the rotation grace goes with the migration');
  assert.equal((await registry.verify(rotated.secret)).ok, false);
});

test('…and the stale-key step alone, when the old cloud cat is not configured any more', async () => {
  const root = await dataDir();
  const registry = new AgentKeyRegistry();
  const { original, rotated } = await legacyChain(registry, root);

  const revoked = await revokeStaleCloudCatKeys(registry, {
    cloudCatIds: ['cloud-beta'],
    env: { CAT_CAFE_DATA_DIR: root },
  });
  assert.deepEqual(revoked.sort(), [original.agentKeyId, rotated.agentKeyId].sort());
});

test('the first migration records its cutoff, so a later run spares keys issued after it', async () => {
  const root = await dataDir();
  const env = { CAT_CAFE_DATA_DIR: root, DEFAULT_OWNER_USER_ID: 'owner-1' };
  const registry = new AgentKeyRegistry();
  const configured = cats([
    ['cloud-beta', 'openai-chatgpt-pro'],
    ['gpt-pro', 'openai'],
  ]);
  await reconcileCloudCatAgentKeys({ registry, cats: configured, env, log: quietLog, now: () => Date.now() - 1_000 });
  const marker = JSON.parse(await readFile(join(root, 'agent-keys', 'cloud-scope-migration.json'), 'utf8'));
  assert.equal(marker.v, 1);

  const later = await registry.issue('gpt-pro', 'owner-1');
  await reconcileCloudCatAgentKeys({ registry, cats: configured, env, log: quietLog });
  assert.equal((await registry.verify(later.secret)).ok, true);
});

test('reconciliation issues the resolved cloud cat its key, and refuses an ambiguous provider without failing', async () => {
  const { reconcileCloudCatAgentKeys } = await import(
    '../dist/domains/cats/services/agents/agent-key/cloud-cat-agent-key-sidecar.js'
  );
  const root = await dataDir();
  const env = { CAT_CAFE_DATA_DIR: root, DEFAULT_OWNER_USER_ID: 'owner-1' };
  const registry = new AgentKeyRegistry();
  const logs = [];
  const log = { info: (message) => logs.push(['info', message]), warn: (message) => logs.push(['warn', message]) };
  const cats = (entries) => ({ getAllConfigs: () => Object.fromEntries(entries) });
  const oldCloud = await registry.issue('gpt-pro', 'owner-1', { scope: 'cloud-conversation' });

  await reconcileCloudCatAgentKeys({
    registry,
    cats: cats([
      ['cloud-alt', { provider: 'openai-chatgpt-pro' }],
      ['codex', { provider: 'openai' }],
    ]),
    env,
    log,
  });
  const secret = (await readFile(join(root, 'agent-keys', 'cloud-alt.secret'), 'utf8')).trim();
  assert.equal((await registry.verify(secret)).record.scope, 'cloud-conversation');
  assert.equal((await registry.verify(oldCloud.secret)).ok, false, 'the previous cloud cat lost its cloud key');

  logs.length = 0;
  await reconcileCloudCatAgentKeys({
    registry,
    cats: cats([
      ['cloud-alt', { provider: 'openai-chatgpt-pro' }],
      ['cloud-beta', { provider: 'openai-chatgpt-pro' }],
    ]),
    env,
    log,
  });
  assert.equal((await registry.verify(secret)).ok, false, 'an ambiguous provider has no usable cloud key');
  assert.ok(
    logs.some(([level, message]) => level === 'warn' && /cloud-alt/u.test(message) && /cloud-beta/u.test(message)),
    'the warning names the cats to fix',
  );
});
