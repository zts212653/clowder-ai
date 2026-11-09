import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { resolveByAccountRef } from '../dist/config/account-resolver.js';
import { canonicalizeAccount } from '../dist/config/account-store-format.js';
import { readAccountSnapshot } from '../dist/config/account-store-snapshot.js';
import { resolveCodexAccountLaunch } from '../dist/config/codex-account-launch.js';
import { accountToView } from '../dist/routes/accounts-view.js';

const ref = 'codex-00000000-0000-0000-0000-000000000001';
const identity = { userId: 'fixture-user', workspaceId: 'fixture-workspace' };
const credential = { accessToken: 'fixture-access', refreshToken: 'fixture-refresh' };
const observation = {
  owner: { accountRef: ref, ...identity },
  observedAt: 100,
  status: 'ok',
  source: 'codex_official_readonly',
  items: [{ label: 'fixture pool', usedPercent: 10 }],
  credentialVersion: 'fixture-observed-version',
};
let root, primary, runtime, home, account, saved;
const put = (dir, name, value) => writeFileSync(join(dir, '.cat-cafe', name), JSON.stringify(value));
function pair(dir, metadata, secret = credential) {
  put(dir, 'accounts.json', { [ref]: metadata });
  put(dir, 'credentials.json', { [ref]: secret });
}
function launch() {
  const profile = resolveByAccountRef(runtime, ref);
  assert.ok(profile);
  return resolveCodexAccountLaunch(profile, { cwd: runtime });
}
beforeEach(() => {
  saved = { ...process.env };
  root = realpathSync(mkdtempSync(join(tmpdir(), 'f320-quota-equality-')));
  primary = join(root, 'workspace');
  runtime = join(root, 'runtime');
  home = join(root, 'credential');
  for (const dir of [primary, runtime, home]) mkdirSync(join(dir, '.cat-cafe'), { recursive: true });
  for (const dir of [primary, runtime]) writeFileSync(join(dir, 'pnpm-workspace.yaml'), 'packages: []\n');
  Object.assign(process.env, { HOME: root, CAT_CAFE_RUNTIME_ROOT: runtime, CAT_CAFE_WORKSPACE_ROOT: primary });
  delete process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT;
  delete process.env.CODEX_HOME;
  delete process.env.CODEX_SQLITE_HOME;
  account = {
    authType: 'oauth',
    clientId: 'openai',
    codex: {
      kind: 'managed',
      layoutVersion: 1,
      prepared: true,
      identity,
      credentialHome: home,
      stateRoot: join(root, 'state'),
      sqliteHome: join(root, 'state'),
    },
    quota: observation,
  };
  const claims = {
    'https://api.openai.com/auth': { chatgpt_user_id: identity.userId, chatgpt_account_id: identity.workspaceId },
  };
  writeFileSync(
    join(home, 'auth.json'),
    JSON.stringify({
      tokens: {
        id_token: `x.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.x`,
        account_id: identity.workspaceId,
      },
    }),
  );
});
afterEach(() => {
  process.env = saved;
  rmSync(root, { recursive: true, force: true });
});

const variations = {
  observedAt: { ...observation, observedAt: 200 },
  items: { ...observation, items: [{ label: 'fixture pool', usedPercent: 30 }] },
  credentialVersion: { ...observation, credentialVersion: 'fixture-rotated-version' },
  combined: { ...observation, observedAt: 200, items: [], credentialVersion: 'fixture-rotated-version' },
  absent: undefined,
};
for (const [name, quota] of Object.entries(variations)) {
  test(`quota ${name} differences preserve primary selection, launch revision and both persisted observations`, () => {
    pair(primary, account);
    pair(runtime, account);
    const accepted = launch();
    pair(runtime, { ...account, quota });
    const paths = [primary, runtime].flatMap((dir) =>
      ['accounts.json', 'credentials.json'].map((name) => join(dir, '.cat-cafe', name)),
    );
    const before = paths.map((path) => readFileSync(path, 'utf8'));
    const selected = readAccountSnapshot(runtime, ref);
    assert.equal(selected.root, primary);
    assert.equal(selected.origin, 'both-equal');
    assert.deepEqual(selected.account.quota, observation);
    assert.deepEqual(selected.credential, credential);
    assert.equal(launch().accountRef, accepted.accountRef);
    assert.equal(launch().accountRevision, accepted.accountRevision);
    assert.deepEqual(canonicalizeAccount(selected.account).quota, observation);
    assert.equal(accountToView(ref, selected.account, false).quota.status, 'ok');
    assert.deepEqual(
      paths.map((path) => readFileSync(path, 'utf8')),
      before,
    );
  });
}

test('newer secondary quota is not selected or merged into an absent primary observation', () => {
  pair(primary, { ...account, quota: undefined });
  pair(runtime, account);
  assert.equal(readAccountSnapshot(runtime, ref).account.quota, undefined);
});

for (const [name, mutate] of Object.entries({
  auth: (a) => {
    a.authType = 'api_key';
  },
  provider: (a) => {
    a.clientId = 'anthropic';
  },
  endpoint: (a) => {
    a.baseUrl = 'https://fixture.invalid';
  },
  environment: (a) => {
    a.envVars = { CODEX_HOME: '/fixture-other' };
  },
  identity: (a) => {
    a.codex.identity.userId = 'other-user';
  },
  credentialHome: (a) => {
    a.codex.credentialHome += '-other';
  },
  stateRoot: (a) => {
    a.codex.stateRoot += '-other';
  },
  sqliteHome: (a) => {
    a.codex.sqliteHome += '-other';
  },
})) {
  test(`${name} conflict remains rejected even when quota also differs`, () => {
    pair(primary, account);
    const other = structuredClone(account);
    other.quota = variations.combined;
    mutate(other);
    pair(runtime, other);
    assert.throws(() => readAccountSnapshot(runtime, ref), /divergent/);
  });
}

for (const [name, change] of Object.entries({
  credential: () => put(runtime, 'credentials.json', { [ref]: { accessToken: 'different-fixture-token' } }),
  missing: () => put(runtime, 'credentials.json', {}),
  torn: () => put(runtime, 'accounts.json', {}),
  malformedCredential: () => put(runtime, 'credentials.json', { [ref]: { accessToken: 42 } }),
  malformedAccount: () => put(runtime, 'accounts.json', { [ref]: { authType: 'broken' } }),
  malformedQuota: () =>
    put(runtime, 'accounts.json', { [ref]: { ...account, quota: { ...observation, observedAt: 'bad' } } }),
})) {
  test(`${name} remains rejected after quota differences stop masking credential checks`, () => {
    pair(primary, account);
    pair(runtime, { ...account, quota: variations.combined });
    change();
    assert.throws(() => readAccountSnapshot(runtime, ref), /divergent|torn|malformed/);
  });
}

test('quota owner disagreement does not change login identity or leak another account reading', () => {
  const invalid = {
    ...observation,
    owner: { accountRef: 'other-ref', userId: 'other-user', workspaceId: 'other-workspace' },
  };
  pair(primary, { ...account, quota: invalid });
  pair(runtime, account);
  const selected = readAccountSnapshot(runtime, ref);
  assert.deepEqual(selected.account.codex.identity, identity);
  assert.deepEqual(selected.account.quota, invalid);
  assert.deepEqual(canonicalizeAccount(selected.account).quota, invalid);
  const view = accountToView(ref, selected.account, false);
  assert.equal(view.quota.status, 'unavailable');
  assert.deepEqual(view.quota.items, []);
  assert.equal(launch().identity.userId, identity.userId);
});
