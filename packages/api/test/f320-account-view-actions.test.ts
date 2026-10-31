import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import Fastify from 'fastify';
import { readAccountStoreSnapshot } from '../src/config/account-store-snapshot.js';
import { writeCatalogAccount } from '../src/config/catalog-accounts.js';
import { CodexLoginManager } from '../src/config/codex-login-manager.js';
import { describeCodexManagedLayout, prepareCodexManagedLayout } from '../src/config/codex-managed-layout.js';
import { accountsRoutes } from '../src/routes/accounts.js';
import { registerCodexLoginRoutes } from '../src/routes/accounts-codex-login.js';

let root: string;
let saved: NodeJS.ProcessEnv;
beforeEach(() => {
  saved = { ...process.env };
  root = realpathSync(mkdtempSync(join(tmpdir(), 'f320-view-actions-')));
  Object.assign(process.env, {
    HOME: root,
    CAT_CAFE_DATA_DIR: join(root, 'data'),
    CAT_CAFE_GLOBAL_CONFIG_ROOT: root,
    CAT_CAFE_CONFIG_ROOT: root,
  });
  delete process.env.CODEX_HOME;
  delete process.env.CODEX_SQLITE_HOME;
  delete process.env.CAT_CAFE_RUNTIME_ROOT;
});
afterEach(() => {
  process.env = saved;
  rmSync(root, { recursive: true, force: true });
});
const headers = { 'x-cat-cafe-user': 'fixture' };
function auth(home: string) {
  mkdirSync(home, { recursive: true });
  const jwt = `x.${Buffer.from(
    JSON.stringify({
      'https://api.openai.com/auth': {
        chatgpt_user_id: 'fake-user',
        chatgpt_account_id: 'fake-workspace',
        chatgpt_plan_type: 'plus',
      },
    }),
  ).toString('base64url')}.x`;
  writeFileSync(join(home, 'auth.json'), JSON.stringify({ tokens: { id_token: jwt, account_id: 'fake-workspace' } }));
}
function managed() {
  const ref = `codex-${randomUUID()}`;
  writeCatalogAccount(root, ref, {
    authType: 'oauth',
    clientId: 'openai',
    displayName: '私人',
    codex: prepareCodexManagedLayout(describeCodexManagedLayout(root, ref)),
  });
  return ref;
}
test('default OAuth readiness follows its canonical home without rewriting or adopting the default', async () => {
  const selected = join(root, 'selected');
  const ambient = join(root, 'ambient');
  mkdirSync(selected);
  auth(ambient);
  process.env.CODEX_HOME = ambient;
  writeCatalogAccount(root, 'codex', { authType: 'oauth', clientId: 'openai', envVars: { CODEX_HOME: selected } });
  const before = readFileSync(join(root, '.cat-cafe/accounts.json'), 'utf8');
  const app = Fastify();
  await app.register(accountsRoutes);
  try {
    const list = () =>
      app.inject({ method: 'GET', url: `/api/accounts?projectPath=${encodeURIComponent(root)}`, headers });
    const absent = (await list()).json().providers.find((p: { id: string }) => p.id === 'codex');
    assert.equal(absent.codexLoginStatus, 'not_logged_in');
    assert.equal(absent.codex, undefined);
    auth(selected);
    const present = (await list()).json().providers.find((p: { id: string }) => p.id === 'codex');
    assert.equal(present.codexLoginStatus, 'ready');
    assert.equal(present.codex, undefined);
    assert.equal(readFileSync(join(root, '.cat-cafe/accounts.json'), 'utf8'), before);
  } finally {
    await app.close();
  }
});
test('login mutation supplies the same derived view as GET before any list refresh', async () => {
  const ref = managed();
  const app = Fastify();
  await app.register(accountsRoutes, {
    loginDriver: {
      run: (input) => {
        input.onReady();
        return new Promise((_, reject) =>
          input.signal.addEventListener('abort', () => reject(new Error('canceled')), { once: true }),
        );
      },
    },
  });
  try {
    const start = await app.inject({
      method: 'POST',
      url: `/api/accounts/${ref}/codex/login/start`,
      headers,
      payload: { projectPath: root },
    });
    assert.equal(start.statusCode, 200, start.body);
    assert.equal(start.json().codex.status, 'not_logged_in');
    assert.equal(start.json().profiles[0].id, ref);
    assert.equal(start.json().profiles[0].codex.attempt.state, 'waiting');
    const cancel = await app.inject({
      method: 'POST',
      url: `/api/accounts/${ref}/codex/login/cancel`,
      headers,
      payload: { projectPath: root, attemptId: start.json().codex.attempt.id },
    });
    assert.equal(cancel.statusCode, 200, cancel.body);
    assert.equal(cancel.json().profiles[0].codex.attempt.state, 'canceled');
    assert.equal(cancel.json().profiles[0].codex.status, 'not_logged_in');
  } finally {
    await app.close();
  }
});
test('server refuses a bound active deletion before canceling the native login', async () => {
  const ref = managed();
  const template = JSON.parse(readFileSync(join(process.cwd(), '../../cat-template.json'), 'utf8'));
  template.breeds[0].variants[0].accountRef = ref;
  writeFileSync(join(root, '.cat-cafe/cat-catalog.json'), JSON.stringify(template));
  let canceled = 0;
  const app = Fastify();
  await app.register(accountsRoutes, {
    loginDriver: {
      run(input) {
        input.onReady();
        return new Promise((_, reject) =>
          input.signal.addEventListener(
            'abort',
            () => {
              canceled++;
              reject(new Error('canceled'));
            },
            { once: true },
          ),
        );
      },
    },
  });
  try {
    const start = await app.inject({
      method: 'POST',
      url: `/api/accounts/${ref}/codex/login/start`,
      headers,
      payload: { projectPath: root },
    });
    assert.equal(start.statusCode, 200, start.body);
    const result = await app.inject({
      method: 'DELETE',
      url: `/api/accounts/${ref}`,
      headers,
      payload: { projectPath: root },
    });
    assert.equal(result.statusCode, 409, result.body);
    assert.match(result.body, /still referenced/);
    assert.equal(canceled, 0);
    assert.equal(readAccountStoreSnapshot(root).resolve(ref).account?.codex?.attempt?.state, 'waiting');
  } finally {
    await app.close();
  }
});

test('duplicate confirmation projects the source review and existing destination under their own refs', async () => {
  const source = managed();
  const target = managed();
  const identity = { userId: 'fake-user', workspaceId: 'fake-workspace' };
  const destination = readAccountStoreSnapshot(root).resolve(target).account!;
  auth(destination.codex!.credentialHome);
  writeCatalogAccount(root, target, { ...destination, codex: { ...destination.codex!, identity } });
  const manager = new CodexLoginManager({
    async run(input) {
      input.onReady();
      auth(input.home);
      return identity;
    },
  });
  const attempt = manager.start(root, source);
  await new Promise((resolve) => setImmediate(resolve));
  const app = Fastify();
  registerCodexLoginRoutes(app, manager);
  try {
    const result = await app.inject({
      method: 'POST',
      url: `/api/accounts/${source}/codex/login/confirm`,
      headers,
      payload: { projectPath: root, attemptId: attempt.id },
    });
    assert.equal(result.statusCode, 200, result.body);
    const body = result.json();
    assert.equal(body.accountRef, target);
    assert.equal(body.profiles.find((profile: { id: string }) => profile.id === source).codex.attempt.state, 'reused');
    assert.equal(body.profiles.find((profile: { id: string }) => profile.id === target).codex.status, 'ready');
    assert.equal(body.codex.attempt.duplicateAccountRef, target);
  } finally {
    await app.close();
    await manager.close();
  }
});
