import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import Fastify from 'fastify';
import { resolveByAccountRef } from '../src/config/account-resolver.js';
import { readAccountStoreSnapshot } from '../src/config/account-store-snapshot.js';
import { resolveCodexAccountLaunch } from '../src/config/codex-account-launch.js';
import { accountsRoutes } from '../src/routes/accounts.js';

let root: string;
let home: string;
let saved: NodeJS.ProcessEnv;
let app: ReturnType<typeof Fastify>;
let calls = 0;
let respond = () => Response.json({ rate_limit: { primary_window: { used_percent: 30 } } });
const headers = { 'x-cat-cafe-user': 'fixture' };
function auth(suffix = 'one', accessToken = `fixture-secret-${suffix}`) {
  writeFileSync(
    join(home, 'auth.json'),
    JSON.stringify({
      tokens: {
        access_token: accessToken,
        account_id: `workspace-${suffix}`,
        id_token: `x.${Buffer.from(
          JSON.stringify({
            'https://api.openai.com/auth': {
              chatgpt_user_id: `user-${suffix}`,
              chatgpt_account_id: `workspace-${suffix}`,
            },
          }),
        ).toString('base64url')}.x`,
      },
    }),
  );
}
async function createApp() {
  const server = Fastify();
  await server.register(accountsRoutes, {
    quotaFetcher: async () => {
      calls++;
      return respond();
    },
  });
  return server;
}
const query = (extra = {}) =>
  app.inject({
    method: 'POST',
    url: '/api/accounts/codex/codex/quota',
    headers,
    payload: { projectPath: root, ...extra },
  });
async function nativeRow() {
  const result = await app.inject({
    method: 'GET',
    url: `/api/accounts?projectPath=${encodeURIComponent(root)}`,
    headers,
  });
  assert.equal(result.statusCode, 200, result.body);
  return result.json().providers.find((row: { id: string }) => row.id === 'codex');
}
beforeEach(async () => {
  saved = { ...process.env };
  root = realpathSync(mkdtempSync(join(tmpdir(), 'issue1963-native-')));
  home = join(root, '.codex');
  mkdirSync(home);
  mkdirSync(join(root, '.cat-cafe'));
  Object.assign(process.env, {
    HOME: root,
    CODEX_HOME: home,
    CAT_CAFE_CONFIG_ROOT: root,
    CAT_CAFE_GLOBAL_CONFIG_ROOT: root,
    CAT_CAFE_DATA_DIR: join(root, 'data'),
  });
  ['OPENAI_API_KEY', 'OPENAI_BASE_URL', 'OPENAI_API_BASE', 'CODEX_SQLITE_HOME'].forEach(
    (key) => delete process.env[key],
  );
  writeFileSync(
    join(root, '.cat-cafe/cat-catalog.json'),
    JSON.stringify({
      version: 2,
      breeds: [
        {
          id: 'fixture',
          catId: 'codex',
          name: 'Fixture',
          displayName: 'Fixture',
          avatar: '/fixture.svg',
          color: { primary: '#123456', secondary: '#abcdef' },
          mentionPatterns: ['@fixture'],
          roleDescription: 'fixture',
          defaultVariantId: 'default',
          variants: [
            {
              id: 'default',
              clientId: 'openai',
              defaultModel: 'fixture',
              mcpSupport: true,
              cli: { command: 'fixture', outputFormat: 'json' },
            },
          ],
        },
      ],
      roster: {},
      reviewPolicy: {
        requireDifferentFamily: false,
        preferActiveInThread: false,
        preferLead: false,
        excludeUnavailable: true,
      },
      coCreator: { name: 'Owner', aliases: ['Owner'], mentionPatterns: ['@owner'] },
    }),
  );
  calls = 0;
  respond = () => Response.json({ rate_limit: { primary_window: { used_percent: 30 } } });
  auth();
  app = await createApp();
});
afterEach(async () => {
  await app.close();
  process.env = saved;
  rmSync(root, { recursive: true, force: true });
});

test('native quota survives API recreation without registering an account or changing auto auth', async () => {
  const before = resolveCodexAccountLaunch(resolveByAccountRef(root, 'codex')!, { cwd: root });
  const result = await query();
  assert.equal(result.statusCode, 200, result.body);
  assert.equal(result.json().quota.status, 'ok');
  assert.equal(result.json().quota.items[0].usedPercent, 30);
  assert.equal(readAccountStoreSnapshot(root).resolve('codex').account, undefined);
  assert.equal(existsSync(join(root, '.cat-cafe/accounts.json')), false);
  const after = resolveCodexAccountLaunch(resolveByAccountRef(root, 'codex')!, { cwd: root });
  assert.equal(before.authMode, 'auto');
  assert.deepEqual(after, before);
  await app.close();
  app = await createApp();
  assert.equal((await nativeRow()).quota.status, 'ok');
  assert.equal((await nativeRow()).quota.items[0].usedPercent, 30);
  const stored = readFileSync(join(root, '.cat-cafe/native-codex-quota.json'), 'utf8');
  assert.doesNotMatch(stored, /fixture-secret|id_token|access_token/);
  assert.equal(calls, 1);
});

(['signed-out', 401, 500] as const).forEach((scenario) => {
  test(`native ${scenario} retains its real failure across reload instead of returning 409`, async () => {
    if (scenario === 'signed-out') unlinkSync(join(home, 'auth.json'));
    else respond = () => Response.json({ error: { message: 'fixture upstream failure' } }, { status: scenario });
    const result = await query();
    assert.equal(result.statusCode, 200, result.body);
    const kind =
      scenario === 'signed-out' ? 'signin_required' : scenario === 401 ? 'renewal_required' : 'service_unreachable';
    assert.equal(result.json().quota.status, 'unavailable');
    assert.equal(result.json().quota.failure.kind, kind);
    assert.equal((await nativeRow()).quota.failure.kind, kind);
    assert.equal(calls, scenario === 'signed-out' ? 0 : 1);
  });
});

(['identity', 'home', 'registration'] as const).forEach((change) => {
  test(`native query rejects a concurrent ${change} change`, async () => {
    respond = () => {
      if (change === 'identity') auth('two');
      else if (change === 'home') {
        const other = join(root, 'other');
        mkdirSync(other);
        process.env.CODEX_HOME = other;
      } else
        writeFileSync(
          join(root, '.cat-cafe/accounts.json'),
          JSON.stringify({ codex: { authType: 'oauth', clientId: 'openai' } }),
        );
      return Response.json({ rate_limit: { primary_window: { used_percent: 30 } } });
    };
    assert.equal((await query()).statusCode, 409);
    assert.equal(existsSync(join(root, '.cat-cafe/native-codex-quota.json')), false);
  });
});

test('server projection hides native readings after sign-out, home changes, or external account switches', async () => {
  assert.equal((await query()).statusCode, 200);
  auth('two');
  assert.equal((await nativeRow()).quota, undefined);
  unlinkSync(join(home, 'auth.json'));
  assert.equal((await nativeRow()).quota, undefined);
  auth();
  assert.equal((await nativeRow()).quota.status, 'ok');
  const other = join(root, 'other');
  mkdirSync(other);
  process.env.CODEX_HOME = other;
  assert.equal((await nativeRow()).quota, undefined);
});

test('native history is retained only for the same owner and persisted accounts never consume the sidecar', async () => {
  assert.equal((await query()).statusCode, 200);
  respond = () => Response.json({ error: {} }, { status: 500 });
  const failed = await query();
  assert.equal(failed.statusCode, 200, failed.body);
  assert.equal(failed.json().quota.lastSuccess.items[0].usedPercent, 30);
  writeFileSync(
    join(root, '.cat-cafe/accounts.json'),
    JSON.stringify({ codex: { authType: 'oauth', clientId: 'openai' } }),
  );
  assert.equal((await nativeRow()).quota, undefined);
});

test('a native renewal projects rotation and automatically queries each credential version once', async () => {
  respond = () => Response.json({ error: {} }, { status: 401 });
  assert.equal((await query()).statusCode, 200);
  auth('one', 'fixture-rotated-secret');
  const version = (await nativeRow()).quota.renewedCredentialVersion;
  assert.match(version, /^[a-f0-9]{64}$/);
  respond = () => Response.json({ rate_limit: { primary_window: { used_percent: 20 } } });
  assert.equal((await query({ renewedCredentialVersion: version })).json().quota.status, 'ok');
  assert.equal((await query({ renewedCredentialVersion: version })).json().quota.status, 'ok');
  assert.equal(calls, 2);
});

test('malformed native quota observations do not break the account directory', async () => {
  writeFileSync(join(root, '.cat-cafe/native-codex-quota.json'), '{broken');
  assert.equal((await nativeRow()).quota, undefined);
  writeFileSync(
    join(root, '.cat-cafe/native-codex-quota.json'),
    JSON.stringify({ credentialHome: home, quota: { status: 'ok' } }),
  );
  assert.equal((await nativeRow()).quota, undefined);
});

test('a native observation write failure is not reported as persisted success', async () => {
  mkdirSync(join(root, '.cat-cafe/native-codex-quota.json'));
  const result = await query();
  assert.notEqual(result.statusCode, 200);
  assert.equal(readAccountStoreSnapshot(root).resolve('codex').account, undefined);
  assert.equal((await nativeRow()).quota, undefined);
});
