import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { neutralFixture } from './helpers/neutral-host-fixture.js';

function services(overrides = {}) {
  const checked = [];
  return {
    checked,
    listCats: () => [
      {
        catId: 'cat',
        displayName: 'Cat',
        nickname: 'nick',
        variantLabel: 'variant',
        defaultModel: 'test-model',
        roleDescription: 'reviewer',
        avatar: '/avatars/cat.png',
        commandArgs: ['private'],
        accountId: 'private',
        available: true,
      },
    ],
    isCatAvailable: () => true,
    publicAvatar: async () => 'data:image/webp;base64,dGVzdA==',
    supportsNativeAction: (catId, policy) => {
      checked.push({ catId, policy });
      return false;
    },
    ...overrides,
  };
}
function requirePort(f) {
  assert.equal(
    typeof f.host().participantRoster?.listForNativeContribution,
    'function',
    'Missing Host participantRoster port',
  );
}
async function result(promise) {
  const response = await promise;
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.json().available, true, 'Missing Host participantRoster port');
  return response.json().result;
}

test('owner GET roster uses declaration-derived method scope and only projects public participant fields', async (t) => {
  const participantRoster = services();
  let supported = false;
  const recordCheck = participantRoster.supportsNativeAction;
  participantRoster.supportsNativeAction = (...args) => {
    recordCheck(...args);
    return supported;
  };
  const f = await neutralFixture(t, { participantRoster });
  const rows = await result(f.httpGet('participantRoster', 'listForNativeContribution', { contributionId: 'native' }));
  assert.deepEqual(rows, [
    {
      catId: 'cat',
      displayName: 'Cat',
      nickname: 'nick',
      variantLabel: 'variant',
      defaultModel: 'test-model',
      roleDescription: 'reviewer',
      avatar: 'data:image/webp;base64,dGVzdA==',
      supported: false,
    },
  ]);
  assert.deepEqual(participantRoster.checked, [
    {
      catId: 'cat',
      policy: {
        mode: 'plugin_native',
        pluginInstanceId: f.installed.pluginInstanceId,
        contributionId: 'native',
        actionMethods: ['neutral.call'],
      },
    },
  ]);
  supported = true;
  const latest = await result(
    f.httpGet('participantRoster', 'listForNativeContribution', { contributionId: 'native' }),
  );
  assert.equal(latest[0].supported, true, 'pair-time reads must use the current provider decision');
});

test('roster rejects body-supplied methods or authority and unknown/non-native contributions', async (t) => {
  const participantRoster = services();
  const f = await neutralFixture(t, { participantRoster });
  requirePort(f);
  for (const value of [
    { contributionId: 'native', actionMethods: ['admin'] },
    { contributionId: 'native', pluginInstanceId: 'foreign' },
    { contributionId: 'native', supported: true },
    { contributionId: 'missing' },
    { contributionId: 'native', includeAvailability: false },
    { contributionId: 'native', includeAvailability: 'true' },
    { contributionId: 'native', includeAvailability: null },
    { contributionId: 'owner' },
  ]) {
    const response = await f.httpGet('participantRoster', 'listForNativeContribution', value);
    assert.notEqual(response.statusCode, 200, response.body);
  }
  assert.equal(participantRoster.checked.length, 0);
});

test('roster requires current same-owner request or native invocation and returns immutable detached rows', async (t) => {
  const f = await neutralFixture(t, { participantRoster: services() });
  requirePort(f);
  await assert.rejects(() => f.host().participantRoster.listForNativeContribution({ contributionId: 'native' }));
  await assert.rejects(() =>
    f.native('participantRoster', 'listForNativeContribution', { contributionId: 'native' }, { userId: 'foreign' }),
  );
  const native = await f.native('participantRoster', 'listForNativeContribution', { contributionId: 'native' });
  assert.equal(native.available, true);
  assert.equal(native.result[0].supported, false);
  assert.equal(Object.isFrozen(native.result), true);
  assert.equal(Object.isFrozen(native.result[0]), true);
});

test('roster withholds an asynchronous avatar result after installation grant revision changes', async (t) => {
  let f;
  let read = false;
  f = await neutralFixture(t, {
    participantRoster: services({
      publicAvatar: async () => {
        read = true;
        await f.runtime.inventoryStore.transaction((tx) => {
          const grant = tx.grants.get(f.installed.pluginInstanceId);
          tx.grants.put({ ...grant, grantRevision: grant.grantRevision + 1 });
        });
        return 'data:image/webp;base64,dGVzdA==';
      },
    }),
  });
  requirePort(f);
  const response = await f.httpGet('participantRoster', 'listForNativeContribution', { contributionId: 'native' });
  assert.equal(read, true);
  assert.notEqual(response.statusCode, 200, response.body);
  assert.equal(response.body.includes('dGVzdA=='), false);
});

test('actual router capability requires a routable service and its exact policy support', async () => {
  const { AgentRouter } = await import('../dist/domains/cats/services/agents/routing/AgentRouter.js');
  const { migrateRouterOpts } = await import('./helpers/agent-registry-helpers.js');
  const { getRoster } = await import('../dist/config/cat-config-loader.js');
  const policy = {
    mode: 'plugin_native',
    pluginInstanceId: 'instance',
    contributionId: 'native',
    actionMethods: ['call'],
  };
  let supported = false;
  const seen = [];
  const router = new AgentRouter(
    await migrateRouterOpts({
      codexService: {
        invoke: async function* () {},
        supportsToolExecutionPolicy: (value) => {
          seen.push(value);
          return supported;
        },
      },
      registry: {},
      messageStore: {},
    }),
  );
  assert.equal(router.supportsToolExecutionPolicy('codex', policy), false);
  supported = true;
  assert.equal(router.supportsToolExecutionPolicy('codex', policy), true);
  assert.equal(seen.at(-1), policy);
  assert.equal(router.supportsToolExecutionPolicy('missing-service', policy), false);
  const roster = getRoster();
  const before = roster.codex.available;
  try {
    roster.codex.available = false;
    const count = seen.length;
    assert.equal(router.supportsToolExecutionPolicy('codex', policy), false);
    assert.equal(seen.length, count);
  } finally {
    roster.codex.available = before;
  }
});

test('public participant avatar keeps only bounded decoded thumbnails and refuses non-public paths', async (t) => {
  const { mkdtemp, writeFile, mkdir, symlink, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const sharp = (await import('sharp')).default;
  const { publicParticipantAvatar } = await import('../dist/domains/plugin/host-surface/public-participant-avatar.js');
  const root = await mkdtemp(join(tmpdir(), 'participant-avatar-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const roots = { avatars: join(root, 'avatars'), uploads: join(root, 'uploads') };
  await mkdir(roots.avatars);
  await mkdir(roots.uploads);
  const bytes = await sharp({ create: { width: 64, height: 64, channels: 3, background: '#123456' } })
    .png()
    .toBuffer();
  await writeFile(join(roots.avatars, 'cat.png'), bytes);
  await writeFile(join(roots.uploads, 'cat.png'), bytes);
  for (const url of ['/avatars/cat.png', '/uploads/cat.png']) {
    const value = await publicParticipantAvatar(url, roots);
    assert.ok(value.startsWith('data:image/webp;base64,'));
    assert.ok(value.length <= 1200);
    const metadata = await sharp(Buffer.from(value.split(',')[1], 'base64')).metadata();
    assert.equal(metadata.width, 48);
    assert.equal(metadata.height, 48);
  }
  await symlink(join(roots.uploads, 'cat.png'), join(roots.avatars, 'escape.png'));
  await writeFile(join(roots.avatars, 'invalid.png'), 'not an image');
  await writeFile(join(roots.avatars, 'huge.png'), Buffer.alloc(10_000_001));
  for (const value of [
    undefined,
    '/avatars/../uploads/cat.png',
    '/etc/passwd',
    'https://example.com/cat.png',
    '/avatars/escape.png',
    '/avatars/invalid.png',
    '/avatars/huge.png',
    '/avatars/cat.png?secret',
  ]) {
    assert.equal(await publicParticipantAvatar(value, roots), undefined);
  }
});

test('roster quota availability is independent of native support and ignores row-supplied availability', async (t) => {
  let available = false;
  let supported = true;
  const f = await neutralFixture(t, {
    participantRoster: services({
      isCatAvailable: () => available,
      supportsNativeAction: () => supported,
    }),
  });
  const read = () =>
    result(
      f.httpGet('participantRoster', 'listForNativeContribution', {
        contributionId: 'native',
        includeAvailability: true,
      }),
    );
  const before = await read();
  assert.equal(before[0].available, false);
  assert.equal(before[0].supported, true);
  available = true;
  supported = false;
  const after = await read();
  assert.equal(after[0].available, true);
  assert.equal(after[0].supported, false);
  assert.equal(before[0].available, false);
});

test('roster reads current quota after asynchronous avatar projection', async (t) => {
  let available = true;
  const f = await neutralFixture(t, {
    participantRoster: services({
      isCatAvailable: () => available,
      publicAvatar: async () => {
        available = false;
        return undefined;
      },
    }),
  });
  const rows = await result(
    f.httpGet('participantRoster', 'listForNativeContribution', {
      contributionId: 'native',
      includeAvailability: true,
    }),
  );
  assert.equal(rows[0].available, false);
});

test('roster quota uses actual config availability, including missing roster entry compatibility', async (t) => {
  const { getRoster, isCatAvailable } = await import('../dist/config/cat-config-loader.js');
  const roster = getRoster();
  const before = roster.codex.available;
  t.after(() => {
    roster.codex.available = before;
  });
  const f = await neutralFixture(t, {
    participantRoster: services({
      listCats: () =>
        ['codex', 'missing-roster-entry'].map((catId) => ({ catId, displayName: catId, defaultModel: 'test' })),
      isCatAvailable,
    }),
  });
  roster.codex.available = false;
  const rows = await result(
    f.httpGet('participantRoster', 'listForNativeContribution', {
      contributionId: 'native',
      includeAvailability: true,
    }),
  );
  assert.deepEqual(
    rows.map(({ catId, available, supported }) => ({ catId, available, supported })),
    [
      { catId: 'codex', available: false, supported: false },
      { catId: 'missing-roster-entry', available: true, supported: false },
    ],
  );
});
