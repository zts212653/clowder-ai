import assert from 'node:assert/strict';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import Fastify from 'fastify';
import { resolveForClient } from '../src/config/account-resolver.js';
import { readAccountStoreSnapshot } from '../src/config/account-store-snapshot.js';
import { AgyNativeAgentService } from '../src/domains/cats/services/agents/providers/agy-native/AgyNativeAgentService.js';
import { createAgyNativeRunProfile } from '../src/domains/cats/services/agents/providers/agy-native/agy-native-run-profile.js';
import { accountsRoutes } from '../src/routes/accounts.js';

let root: string;
let saved: NodeJS.ProcessEnv;
const headers = { 'x-cat-cafe-user': 'fixture' };
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'f320-agy-')));
  saved = { ...process.env };
  process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT = root;
  process.env.CAT_CAFE_DATA_DIR = join(root, 'data');
});
afterEach(() => {
  process.env = saved;
  rmSync(root, { recursive: true, force: true });
});

test('AGY accounts own independent official login directories; saving never binds a member or copies tokens', async () => {
  const app = Fastify();
  await app.register(accountsRoutes);
  try {
    const create = (name: string) =>
      app.inject({
        method: 'POST',
        url: '/api/accounts',
        headers,
        payload: { projectPath: root, authType: 'oauth', clientId: 'google', displayName: name, agyOAuth: true },
      });
    const a = await create('work');
    const b = await create('personal');
    assert.equal(a.statusCode, 200, a.body);
    assert.equal(b.statusCode, 200, b.body);
    const av = a.json().profile;
    const bv = b.json().profile;
    assert.equal(av.agy?.storage, 'cli_file');
    assert.notEqual(av.agy.credentialHome, bv.agy.credentialHome);
    assert.equal(av.agyLoginStatus, 'not_logged_in');
    assert.ok(av.agyLoginCommand.includes('agy:account:login'));
    assert.equal(lstatSync(av.agy.credentialHome).mode & 0o077, 0);
    assert.deepEqual(readAccountStoreSnapshot(root).resolve(av.id).account?.agy, av.agy);
    assert.deepEqual(resolveForClient(root, 'google', av.id)?.agy, av.agy);
    assert.equal(resolveForClient(root, 'google', av.id)?.envVars, undefined);
    assert.equal(a.json().selection, undefined);
    const file = join(av.agy.credentialHome, '.gemini/antigravity-cli/antigravity-oauth-token');
    writeFileSync(
      file,
      JSON.stringify({
        token: { access_token: 'F320-FAKE-ACCESS', refresh_token: 'F320-FAKE-REFRESH', expiry: '2000-01-01T00:00:00Z' },
        auth_method: 'consumer',
      }),
      { mode: 0o600 },
    );
    const listed = await app.inject({ url: `/api/accounts?projectPath=${encodeURIComponent(root)}`, headers });
    const account = listed.json().providers.find((p: { id: string }) => p.id === av.id);
    assert.equal(account.agyLoginStatus, 'refreshable', 'expiry with a refresh token is not a logged-out account');
    assert.ok(!listed.body.includes('F320-FAKE-ACCESS'));
    assert.ok(!listed.body.includes('F320-FAKE-REFRESH'));
    assert.ok(!readFileSync(join(root, '.cat-cafe/accounts.json'), 'utf8').includes('F320-FAKE'));
    const rename = await app.inject({
      method: 'PATCH',
      url: `/api/accounts/${av.id}`,
      headers,
      payload: { projectPath: root, displayName: 'renamed' },
    });
    assert.equal(rename.statusCode, 200, rename.body);
    assert.deepEqual(rename.json().profile.agy, av.agy);
  } finally {
    await app.close();
  }
});

test('AGY account creation rejects alternate credentials and caller-owned login paths', async () => {
  const app = Fastify();
  await app.register(accountsRoutes);
  try {
    for (const delta of [
      { apiKey: 'fake' },
      { baseUrl: 'https://example.test' },
      { envVars: { HOME: root } },
      { authType: 'api_key' },
      { googleCloudProjectId: 'sample-project' },
      { agy: { credentialHome: root } },
    ]) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/accounts',
        headers,
        payload: {
          projectPath: root,
          authType: 'oauth',
          clientId: 'google',
          displayName: 'bad',
          agyOAuth: true,
          ...delta,
        },
      });
      assert.equal(response.statusCode, 400, JSON.stringify(delta));
    }
  } finally {
    await app.close();
  }
});

test('changing account changes only the credential link; session files and in-flight views remain stable', () => {
  const profile = join(root, 'profile');
  const shared = join(profile, '.gemini/antigravity-cli');
  mkdirSync(shared, { recursive: true });
  writeFileSync(join(shared, 'conversation_summaries.db'), 'fixture-db');
  const credentials = ['a', 'b'].map((id) => {
    const home = join(root, id);
    const dir = join(home, '.gemini/antigravity-cli');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(join(dir, 'antigravity-oauth-token'), id, { mode: 0o600 });
    return home;
  });
  const a = createAgyNativeRunProfile(profile, credentials[0]);
  const b = createAgyNativeRunProfile(profile, credentials[1]);
  try {
    const dataA = resolve(a.geminiDir, a.appDataDir);
    const dataB = resolve(b.geminiDir, b.appDataDir);
    assert.notEqual(dataA, dataB, 'a running invocation must retain its selected credential directory');
    for (const data of [dataA, dataB])
      assert.equal(realpathSync(join(data, 'conversation_summaries.db')), join(shared, 'conversation_summaries.db'));
    assert.equal(readFileSync(join(dataA, 'antigravity-oauth-token'), 'utf8'), 'a');
    assert.equal(readFileSync(join(dataB, 'antigravity-oauth-token'), 'utf8'), 'b');
    writeFileSync(join(dataA, 'antigravity-oauth-token'), 'a-refreshed');
    assert.equal(
      readFileSync(join(credentials[0], '.gemini/antigravity-cli/antigravity-oauth-token'), 'utf8'),
      'a-refreshed',
    );
    assert.equal(readFileSync(join(dataB, 'antigravity-oauth-token'), 'utf8'), 'b');
  } finally {
    a.dispose();
    b.dispose();
  }
});

test('explicit AGY binding uses F320 preview/commit and leaves inactive and ACP members on their prior account', async () => {
  process.env.CAT_CAFE_CONFIG_ROOT = root;
  process.env.CAT_CAFE_RUNTIME_ROOT = root;
  process.env.CAT_CAFE_WORKSPACE_ROOT = root;
  const cats = ['first', 'second', 'sleepy', 'acp'];
  const catalog = {
    version: 2,
    reviewPolicy: {
      requireDifferentFamily: false,
      preferActiveInThread: false,
      preferLead: false,
      excludeUnavailable: true,
    },
    breeds: [
      {
        id: 'siamese',
        catId: 'first',
        name: 'siamese',
        displayName: 'siamese',
        avatar: '/avatars/gemini.png',
        color: { primary: '#123456', secondary: '#abcdef' },
        mentionPatterns: ['@first'],
        roleDescription: 'fixture',
        defaultVariantId: 'first',
        variants: cats.map((id) => ({
          id,
          catId: id,
          clientId: 'google',
          defaultModel: 'gemini-4-argon-high',
          accountRef: 'gemini',
          mcpSupport: true,
          cli: { command: 'agy', outputFormat: 'stream-json' },
          ...(id === 'acp' ? { carrier: 'acp', acp: { command: 'agy', startupArgs: ['acp'] } } : {}),
          agyProfile: {
            enabled: true,
            carrier: id === 'acp' ? 'acp' : 'native',
            profileId: id,
            model: 'gemini-4-argon-high',
            autoApprove: true,
            trustedWorkspaces: [],
          },
        })),
      },
    ],
    roster: Object.fromEntries(
      cats.map((id) => [
        id,
        { family: 'siamese', roles: ['assistant'], lead: false, available: id !== 'sleepy', evaluation: 'fixture' },
      ]),
    ),
  };
  mkdirSync(join(root, '.cat-cafe'), { recursive: true });
  const catalogPath = join(root, '.cat-cafe/cat-catalog.json');
  writeFileSync(catalogPath, JSON.stringify(catalog));
  writeFileSync(join(root, 'cat-template.json'), JSON.stringify(catalog));
  const app = Fastify();
  await app.register(accountsRoutes);
  try {
    const created = await app.inject({
      method: 'POST',
      url: '/api/accounts',
      headers,
      payload: { projectPath: root, authType: 'oauth', clientId: 'google', displayName: 'work', agyOAuth: true },
    });
    assert.equal(created.statusCode, 200, created.body);
    const account = created.json().profile;
    const url = `/api/accounts/${account.id}/agy/binding/`;
    const preview = () =>
      app.inject({ method: 'POST', url: url + 'preview', headers, payload: { projectPath: root, scope: 'local' } });
    assert.equal((await preview()).statusCode, 409, 'unprepared accounts cannot become active');
    writeFileSync(
      join(account.agy.credentialHome, '.gemini/antigravity-cli/antigravity-oauth-token'),
      JSON.stringify({
        token: { access_token: 'fake', refresh_token: 'fake-refresh', expiry: '2099-01-01T00:00:00Z' },
        auth_method: 'consumer',
      }),
      { mode: 0o600 },
    );
    const planned = await preview();
    assert.equal(planned.statusCode, 200, planned.body);
    assert.deepEqual(
      planned.json().targets.map((target: { catId: string }) => target.catId),
      ['first', 'second'],
    );
    const committed = await app.inject({
      method: 'POST',
      url: url + 'commit',
      headers,
      payload: { projectPath: root, scope: 'local', previewToken: planned.json().previewToken },
    });
    assert.equal(committed.statusCode, 200, committed.body);
    const after = JSON.parse(readFileSync(catalogPath, 'utf8'));
    assert.deepEqual(
      after.breeds[0].variants.map((member: { accountRef: string }) => member.accountRef),
      [account.id, account.id, 'gemini', 'gemini'],
    );
    assert.deepEqual(
      after.breeds[0].variants.map((member: { agyProfile: unknown }) => member.agyProfile),
      catalog.breeds[0].variants.map((member) => member.agyProfile),
    );
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: url + 'commit',
          headers,
          payload: { projectPath: root, scope: 'local', previewToken: planned.json().previewToken },
        })
      ).statusCode,
      409,
      'stale previews cannot silently overwrite a newer binding',
    );
  } finally {
    await app.close();
  }
});

test('Native account switch resumes the same conversation and uses the new frozen credential on the next invocation', async () => {
  const workspace = join(root, 'workspace');
  mkdirSync(workspace);
  const homes = ['a', 'b'].map((id) => {
    const home = join(root, id),
      dir = join(home, '.gemini/antigravity-cli');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(
      join(dir, 'antigravity-oauth-token'),
      JSON.stringify({
        auth_method: 'consumer',
        token: { access_token: id, refresh_token: 'fake-refresh', expiry: '2099-01-01T00:00:00Z' },
      }),
      { mode: 0o600 },
    );
    return home;
  });
  const launches: Array<{ token: string; home: string; session?: string; ssh?: string | null }> = [];
  const service = new AgyNativeAgentService({
    catId: 'gemini38',
    command: '/usr/bin/true',
    profile: {
      enabled: true,
      carrier: 'native',
      profileId: 'member',
      homeRoot: join(root, 'profiles'),
      model: 'gemini-4-argon-high',
      trustedWorkspaces: [workspace],
    },
    l0CompilerFn: async () => '# Identity\nYou are the same member.',
  });
  const invoke = async (
    home: string,
    prior?: { sessionId: string; nativeSessionBinding: import('@cat-cafe/shared').NativeSessionBinding },
  ) => {
    const messages = [];
    for await (const message of service.invoke('Continue.', {
      workingDirectory: workspace,
      agyAccount: { storage: 'cli_file', credentialHome: home },
      ...prior,
      spawnCliOverride: async function* (launch) {
        const gemini = launch.args.find((arg) => arg.startsWith('--gemini_dir='))!.slice('--gemini_dir='.length);
        const data = resolve(
          gemini,
          launch.args.find((arg) => arg.startsWith('--app_data_dir='))!.slice('--app_data_dir='.length),
        );
        const token = JSON.parse(readFileSync(join(data, 'antigravity-oauth-token'), 'utf8')).token.access_token;
        const i = launch.args.indexOf('--conversation'),
          id = i < 0 ? 'fixture-conversation' : launch.args[i + 1];
        launches.push({ token, home: launch.env!.HOME!, session: i < 0 ? undefined : id, ssh: launch.env!.SSH_TTY });
        yield {
          event: 'init',
          conversation_id: id,
          init: {
            cwd: launch.cwd!,
            model: 'gemini-4-argon-high',
            agent: launch.args[launch.args.indexOf('--agent') + 1],
            permission_mode: 'request-review',
            tools: [],
          },
        };
        yield {
          event: 'result',
          result: { conversation_id: id, status: 'SUCCESS', response: token, denied_actions: [], num_turns: 1 },
        };
      },
    }))
      messages.push(message);
    return messages;
  };
  const first = await invoke(homes[0]);
  const init = first.find((message) => message.type === 'session_init')!;
  assert.ok(init?.nativeSessionBinding, JSON.stringify(first));
  const second = await invoke(homes[1], {
    sessionId: init.sessionId!,
    nativeSessionBinding: init.nativeSessionBinding,
  });
  assert.equal(second.at(-1)?.errorCode, undefined, JSON.stringify(second));
  assert.deepEqual(
    launches.map((launch) => launch.token),
    ['a', 'b'],
  );
  assert.equal(launches[0].home, launches[1].home);
  assert.equal(launches[1].session, init.sessionId);
  assert.equal(launches[1].ssh, 'cat-cafe-file-auth');
});
