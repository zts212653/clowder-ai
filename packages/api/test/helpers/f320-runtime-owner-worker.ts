import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import Fastify from 'fastify';
import { resolveByAccountRef } from '../../src/config/account-resolver.js';
import { resolveAccountWriteRoot } from '../../src/config/account-store-topology.js';
import { finalizeCodexAccountEnvironment } from '../../src/config/codex-account-environment.js';
import { resolveCodexAccountLaunch } from '../../src/config/codex-account-launch.js';
import { codexManagedLaunchArgs } from '../../src/config/codex-managed-launch.js';
import { accountsRoutes } from '../../src/routes/accounts.js';

const [action, runtime, ref] = process.argv.slice(2);
assert.ok(action && runtime);
const requestRoot = process.env.CAT_CAFE_CONFIG_ROOT ?? runtime;
const emit = (value: unknown) => process.stdout.write(`F320_RECEIPT:${JSON.stringify(value)}\n`);
let loginCalls = 0;
const identity = { userId: 'fixture-user', workspaceId: 'fixture-workspace', planType: 'pro' };
const app = Fastify();
await app.register(accountsRoutes, {
  loginDriver: {
    async run(input) {
      loginCalls++;
      assert.ok(action === 'create' || action === 'hold', 'a replacement API must not issue login');
      input.onReady();
      if (action === 'hold')
        return await new Promise<never>((_resolve, reject) =>
          input.signal.addEventListener('abort', () => reject(new Error('fixture owner stopped')), { once: true }),
        );
      const claims = {
        'https://api.openai.com/auth': {
          chatgpt_user_id: identity.userId,
          chatgpt_account_id: identity.workspaceId,
          chatgpt_plan_type: identity.planType,
        },
      };
      const jwt = `x.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.x`;
      mkdirSync(input.home, { recursive: true });
      writeFileSync(
        join(input.home, 'auth.json'),
        JSON.stringify({
          tokens: { id_token: jwt, account_id: identity.workspaceId, access_token: 'fixture-only-access' },
        }),
        { mode: 0o600 },
      );
      return identity;
    },
  },
});
const headers = { 'x-cat-cafe-user': 'fixture' };
async function post(url: string, payload: Record<string, unknown> = {}) {
  return await app.inject({ method: 'POST', url, headers, payload: { projectPath: requestRoot, ...payload } });
}
const hash = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
async function view(selected: string) {
  const response = await app.inject({ url: `/api/accounts?projectPath=${encodeURIComponent(requestRoot)}`, headers });
  assert.equal(response.statusCode, 200, response.body);
  const body = response.json();
  const profile = body.providers.find((entry: { id: string }) => entry.id === selected);
  if (!profile) return { selected, missing: true, unavailable: body.unavailableAccounts, loginCalls };
  const account = resolveByAccountRef(requestRoot, selected);
  assert.ok(account);
  const launch = resolveCodexAccountLaunch(account, { cwd: runtime });
  const env = finalizeCodexAccountEnvironment(launch, {
    cwd: runtime,
    env: {},
    args: codexManagedLaunchArgs(launch, []),
  });
  const session = join(launch.credentialHome, 'sessions', 'handover-session.jsonl');
  return {
    accountRef: profile.id,
    note: profile.displayName,
    status: profile.codex.status,
    identity: profile.codex.identity,
    credentialHome: launch.credentialHome,
    stateRoot: launch.stateRoot,
    sqliteHome: launch.sqliteHome,
    accountStore: resolveAccountWriteRoot(requestRoot),
    executionCwd: runtime,
    envHome: env.CODEX_HOME,
    loginCalls,
    authHash: hash(join(launch.credentialHome, 'auth.json')),
    defaultAuthHash: hash(join(launch.stateRoot, 'auth.json')),
    sessionHash: hash(session),
    sessionSource: JSON.parse(readFileSync(session, 'utf8')),
  };
}
try {
  if (action === 'create') {
    const created = await post('/api/accounts', { clientId: 'openai', authType: 'oauth', displayName: '正式工作号' });
    assert.equal(created.statusCode, 200, created.body);
    const accountRef = created.json().profile.id as string;
    const started = await post(`/api/accounts/${accountRef}/codex/login/start`);
    assert.equal(started.statusCode, 200, started.body);
    await new Promise((resolve) => setImmediate(resolve));
    const account = resolveByAccountRef(requestRoot, accountRef);
    assert.ok(account);
    const launch = resolveCodexAccountLaunch(account, { cwd: runtime });
    // An existing session source record is retained byte-for-byte; no native inference is claimed.
    writeFileSync(
      join(launch.stateRoot, 'sessions', 'handover-session.jsonl'),
      `${JSON.stringify({
        sessionId: 'fixture-source-session',
        executionAccount: { accountRef },
        source: 'original-checkout',
      })}\n`,
    );
    emit(await view(accountRef));
  } else if (action === 'bind-stage') {
    assert.ok(ref);
    const preview = await post(`/api/accounts/${ref}/codex/binding/preview`, {
      catId: 'f320-test-cat',
      scope: 'cat',
    });
    assert.equal(preview.statusCode, 200, preview.body);
    const committed = await post(`/api/accounts/${ref}/codex/binding/commit`, {
      catId: 'f320-test-cat',
      scope: 'cat',
      previewToken: preview.json().previewToken,
    });
    emit({ status: committed.statusCode, loginCalls });
  } else if (action === 'hold') {
    assert.ok(ref);
    const started = await post(`/api/accounts/${ref}/codex/login/start`);
    assert.equal(started.statusCode, 200, started.body);
    emit({ state: 'held', attempt: started.json().codex.attempt, loginCalls });
    await new Promise<void>((resolve) => process.stdin.once('data', () => resolve()));
  } else if (action === 'refuse-live') {
    assert.ok(ref);
    const response = await post(`/api/accounts/${ref}/codex/login/start`);
    emit({ status: response.statusCode, error: response.json().error, loginCalls });
  } else {
    assert.ok(ref);
    emit(await view(ref));
  }
} finally {
  await app.close();
}
