import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { prepareCodexHostLaunch } from '../dist/domains/cats/services/agents/providers/CodexUnixWebSocketSession.js';
import { readCodexHostAuthIdentity } from '../dist/domains/cats/services/agents/providers/codex-host-auth-identity.js';
import { createHarness, sessionOptions } from './helpers/codex-host-pool-harness.js';

function credentials(account = 'account-a', overrides = {}) {
  const claims = {
    sub: 'user-a',
    sid: 'login-a',
    auth_time: 100,
    'https://api.openai.com/auth': { chatgpt_account_id: account },
    ...overrides,
  };
  return {
    auth_mode: 'chatgpt',
    tokens: {
      account_id: account,
      id_token: `header.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.signature`,
      access_token: 'access-secret',
      refresh_token: 'refresh-secret',
    },
    last_refresh: '2026-10-03T00:00:00Z',
  };
}

async function fixture(t) {
  const home = await mkdtemp(join(tmpdir(), 'codex-auth-switch-test-'));
  const authPath = join(home, 'auth.json');
  const harness = createHarness();
  t.after(async () => {
    await harness.pool.closeAll();
    await rm(home, { recursive: true, force: true });
  });
  const options = (overrides = {}) => sessionOptions({ ...overrides, env: { HOME: home, CODEX_HOME: home } });
  const login = (account, overrides) => writeFile(authPath, JSON.stringify(credentials(account, overrides)));
  await login('account-a');
  return { ...harness, home, authPath, options, login };
}

test('switching the account in one Codex home replaces the idle native session owner', async (t) => {
  const { pool, hosts, options, login } = await fixture(t);
  const first = await pool.createSession(options());
  first.rememberSession('native-thread');
  await first.close();
  await login('account-b');

  const resumed = await pool.createSession(options({ sessionId: 'native-thread', invocationId: 'next' }));
  assert.equal(hosts.length, 2, 'the new account must not reuse the old in-memory auth snapshot');
  assert.equal(hosts[0].closeCalls, 1, 'retire the old writer before the same thread resumes');
  assert.equal(resumed.reusedSessionHost, false);
  assert.equal(pool.getMetrics().activeLeaseCount, 1);
  assert.doesNotMatch(
    JSON.stringify(hosts.map((host) => host.launch)),
    /access-secret|refresh-secret|account-a|account-b/,
  );
  await resumed.close();
});

test('ordinary token rotation keeps the warm host and native session affinity', async (t) => {
  const { pool, hosts, options, authPath } = await fixture(t);
  const first = await pool.createSession(options());
  first.rememberSession('native-thread');
  await first.close();
  const refreshed = credentials('account-a', { iat: 200, exp: 300, jti: 'new-token-id' });
  refreshed.tokens.access_token = 'rotated-access';
  refreshed.tokens.refresh_token = 'rotated-refresh';
  refreshed.last_refresh = '2026-10-03T01:00:00Z';
  await writeFile(authPath, JSON.stringify(refreshed));
  const resumed = await pool.createSession(options({ sessionId: 'native-thread' }));
  assert.equal(hosts.length, 1);
  assert.equal(hosts[0].closeCalls, 0);
  assert.equal(resumed.reusedSessionHost, true);
  await resumed.close();
});

test('switching accounts preserves a running turn and its attached control connection', async (t) => {
  const { pool, hosts, options, login } = await fixture(t);
  const first = await pool.createSession(options());
  first.rememberSession('running-thread');
  await login('account-b');
  const control = await pool.createSessionAttachment(options({ sessionId: 'running-thread' }));
  assert.equal(control.reusedSessionHost, true, 'cancel/status must still reach the running old-account writer');
  assert.equal(hosts[0].closeCalls, 0);
  const other = await pool.createSession(options({ invocationId: 'other' }));
  assert.equal(hosts.length, 2);
  assert.equal(pool.getMetrics().activeLeaseCount, 2);
  await other.close();
  await control.close();
  await first.close();
  const resumed = await pool.createSession(options({ sessionId: 'running-thread' }));
  assert.equal(hosts[0].closeCalls, 1, 'only migrate the old account after the active turn releases');
  assert.equal(resumed.reusedSessionHost, false);
  await resumed.close();
});

test('logging in as another user or a new login session in the same workspace replaces the host', async (t) => {
  for (const claims of [{ sub: 'user-b' }, { sid: 'login-b', auth_time: 200 }]) {
    await t.test(JSON.stringify(claims), async (t) => {
      const { pool, hosts, options, login } = await fixture(t);
      const first = await pool.createSession(options());
      first.rememberSession('native-thread');
      await first.close();
      await login('account-a', claims);
      const resumed = await pool.createSession(options({ sessionId: 'native-thread' }));
      assert.equal(hosts.length, 2);
      assert.equal(hosts[0].closeCalls, 1);
      await resumed.close();
    });
  }
});

test('removed or malformed auth cannot keep using an idle authenticated host', async (t) => {
  for (const replacement of [null, '{invalid json']) {
    await t.test(String(replacement), async (t) => {
      const { pool, hosts, options, authPath } = await fixture(t);
      const first = await pool.createSession(options());
      first.rememberSession('native-thread');
      await first.close();
      if (replacement === null) await rm(authPath);
      else await writeFile(authPath, replacement);
      const resumed = await pool.createSession(options({ sessionId: 'native-thread' }));
      assert.equal(hosts[0].closeCalls, 1, 'Codex must see the logged-out/invalid store instead of cached auth');
      assert.equal(hosts.length, 2);
      await resumed.close();
    });
  }
});

test('unowned warm hosts and idle control attachments cannot reuse the previous login', async (t) => {
  const { pool, hosts, options, login } = await fixture(t);
  const unowned = await pool.createSession(options());
  await unowned.close();
  await login('account-b');
  const next = await pool.createSession(options());
  assert.equal(hosts.length, 2, 'even a new conversation must reject the idle old-account host');
  next.rememberSession('native-thread');
  await next.close();
  await login('account-c');
  const control = await pool.createSessionAttachment(options({ sessionId: 'native-thread' }));
  assert.equal(hosts[1].closeCalls, 1);
  assert.equal(control.reusedSessionHost, false);
  await control.close();
});

test('auth home resolution honors inherited CODEX_HOME, explicit null, and relative paths', async (t) => {
  const { home, authPath, options } = await fixture(t);
  const fallback = join(home, '.codex');
  await mkdir(fallback);
  await writeFile(join(fallback, 'auth.json'), JSON.stringify(credentials('fallback-account')));
  const before = process.env.CODEX_HOME;
  process.env.CODEX_HOME = home;
  try {
    const inherited = await prepareCodexHostLaunch({ ...options(), env: { HOME: home } });
    const explicit = await prepareCodexHostLaunch(options());
    assert.equal(inherited.authIdentity, explicit.authIdentity);
    const cleared = await prepareCodexHostLaunch({ ...options(), env: { HOME: home, CODEX_HOME: null } });
    assert.notEqual(cleared.authIdentity, inherited.authIdentity);
    assert.equal(cleared.authIdentity, await readCodexHostAuthIdentity({ CODEX_HOME: fallback }));
    assert.equal(
      inherited.authIdentity,
      await readCodexHostAuthIdentity({ CODEX_HOME: '.' }, home),
      'relative paths use the child working directory',
    );
    const linked = join(home, 'linked');
    await mkdir(linked);
    await symlink(authPath, join(linked, 'auth.json'));
    const linkedIdentity = await readCodexHostAuthIdentity({ CODEX_HOME: linked });
    assert.equal(linkedIdentity, await readCodexHostAuthIdentity({ CODEX_HOME: linked }));
  } finally {
    if (before === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = before;
  }
});

test('oversized and invalid stores are bounded and never treated as a reusable identity', async (t) => {
  const { home, authPath } = await fixture(t);
  const env = { CODEX_HOME: home };
  for (const value of ['x'.repeat(256 * 1024 + 1), '{malformed', '{"tokens":{}}']) {
    await writeFile(authPath, value);
    const first = await readCodexHostAuthIdentity(env);
    const second = await readCodexHostAuthIdentity(env);
    assert.match(first, /^[a-f0-9]{64}$/);
    assert.notEqual(first, second, 'unreadable authentication must not grant warm reuse');
  }
});
