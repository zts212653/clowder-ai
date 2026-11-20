import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { test } from 'node:test';
import { setTimeout } from 'node:timers/promises';
import Fastify from 'fastify';
import { resolveByAccountRef } from '../dist/config/account-resolver.js';
import { readAccountRoutingCapacity } from '../dist/config/account-routing-capacity.js';
import { sampleClaudeQuota } from '../dist/config/claude-quota-sampler.js';
import { nativeClaudeQuotaSourceKnown } from '../dist/config/claude-quota-source.js';
import { observeClaudeQuotaMessage, readClaudeQuota, recordClaudeQuota } from '../dist/config/claude-quota-store.js';
import { claudeExecutionAccountSnapshot } from '../dist/config/claude-token-account.js';
import { freezeExecutionAccountBinding } from '../dist/domains/cats/services/agents/invocation/execution-account-binding.js';
import { accountsRoutes } from '../dist/routes/accounts.js';
import { registerClaudeQuotaRoutes } from '../dist/routes/accounts-claude-quota.js';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'claude-quota-'));
  const env = { ...process.env };
  process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT = root;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_BASE_URL;
  t.after(() => {
    process.env = env;
    rmSync(root, { recursive: true, force: true });
  });
  mkdirSync(join(root, '.cat-cafe'));
  const accounts = Object.fromEntries(
    ['a', 'b'].map((id) => [
      id,
      {
        clientId: 'anthropic',
        authType: 'oauth',
        claude: { kind: 'long_lived_token' },
        displayName: id === 'a' ? '主号' : '备用号',
      },
    ]),
  );
  // Deliberately short, repetitive shape fixtures; never usable credentials.
  const credentials = {
    a: { accessToken: 'sk-ant-oat01-aaaaaaaa' },
    b: { accessToken: 'sk-ant-oat01-bbbbbbbb' },
  };
  const save = () => {
    writeFileSync(join(root, '.cat-cafe/accounts.json'), JSON.stringify(accounts));
    writeFileSync(join(root, '.cat-cafe/credentials.json'), JSON.stringify(credentials));
  };
  save();
  const owner = (ref) => claudeExecutionAccountSnapshot(resolveByAccountRef(root, ref));
  const now = Date.now();
  const weekly = (utilization) => ({ utilization, resetsAt: (now + 86400000) / 1000, status: 'allowed' });
  const record = async (ref, model, windows, observedAt = now) =>
    recordClaudeQuota({ root, account: await owner(ref), model, windows, observedAt });
  const config = (model, ref = 'a') => ({ clientId: 'anthropic', defaultModel: model, accountRef: ref });
  const read = (configs, observedAt = now, executionBindings) =>
    readAccountRoutingCapacity({ projectRoot: root, configs, observedAt, executionBindings });
  return { root, now, owner, weekly, record, config, read, credentials, accounts, save };
}

test(
  'explicit Claude quota sampling reaches the configured network proxy with only the selected OAuth login',
  {
    skip: process.platform === 'win32',
  },
  async (t) => {
    const f = fixture(t);
    const bin = join(f.root, 'bin');
    mkdirSync(bin);
    process.env.PATH = `${bin}${delimiter}${process.env.PATH ?? ''}`;
    const network = {
      HTTPS_PROXY: 'http://127.0.0.1:17897',
      https_proxy: 'http://127.0.0.1:17898',
      NO_PROXY: 'localhost',
      no_proxy: '127.0.0.1',
    };
    Object.assign(process.env, network, {
      ANTHROPIC_BASE_URL: 'https://unrelated.invalid',
      ANTHROPIC_API_KEY: 'fixture-api-key',
      ANTHROPIC_AUTH_TOKEN: 'fixture-auth-token',
      CLAUDE_CODE_OAUTH_TOKEN: 'fixture-native-login',
    });
    const events = [
      { type: 'assistant', message: { model: 'claude-haiku-5-5' } },
      { type: 'rate_limit_event', rate_limit_info: { unifiedWindows: { seven_day: f.weekly(0.25) } } },
      { type: 'result', subtype: 'success', is_error: false },
    ];
    writeFileSync(
      join(bin, 'claude'),
      [
        '#!/bin/sh',
        ...Object.entries(network).map(([key, value]) => `[ "$${key}" = '${value}' ] || exit 1`),
        '[ -z "$ANTHROPIC_BASE_URL$ANTHROPIC_API_KEY$ANTHROPIC_AUTH_TOKEN" ] || exit 1',
        `[ "$CLAUDE_CODE_OAUTH_TOKEN" = '${f.credentials.b.accessToken}' ] || exit 1`,
        `printf '%s\\n' ${events.map((event) => `'${JSON.stringify(event)}'`).join(' ')}`,
        '',
      ].join('\n'),
      { mode: 0o755 },
    );

    const sample = await sampleClaudeQuota(resolveByAccountRef(f.root, 'b'), 'haiku');
    assert.equal(sample.model, 'claude-haiku-5-5');
    assert.equal(sample.windows[0].seven_day.utilization, 0.25);
  },
);

test(
  'unrelated API requests complete while a native Claude Keychain read is pending',
  {
    skip: process.platform !== 'darwin',
    timeout: 5000,
  },
  async (t) => {
    const f = fixture(t);
    const token = 'fixture-native-claude-token';
    f.accounts.claude = { clientId: 'anthropic', authType: 'oauth' };
    f.save();
    process.env.CLAUDE_CODE_OAUTH_TOKEN = token;
    await f.record('claude', 'claude-fable-5', { seven_day: f.weekly(0.3) });
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR;
    delete process.env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST;

    const started = Promise.withResolvers();
    let reading = false;
    const payload = JSON.stringify({ claudeAiOauth: { accessToken: token } });
    let command = ['-e', `setTimeout(() => process.stdout.write(${JSON.stringify(payload)}), 350)`];
    const execFileSync = childProcess.execFileSync;
    const execFile = childProcess.execFile;
    const begin = (options) => {
      started.resolve();
      reading = true;
      assert.equal(options.timeout, 1500);
      assert.equal(options.maxBuffer, 262144);
    };
    const sync = t.mock.method(childProcess, 'execFileSync', (file, args, options) => {
      if (file !== '/usr/bin/security') return execFileSync(file, args, options);
      begin(options);
      try {
        return execFileSync(process.execPath, command, options);
      } finally {
        reading = false;
      }
    });
    const asyncRead = t.mock.method(childProcess, 'execFile', (file, args, options, callback) => {
      if (file !== '/usr/bin/security') return execFile(file, args, options, callback);
      begin(options);
      return execFile(process.execPath, command, options, (error, stdout, stderr) => {
        reading = false;
        callback(error, stdout, stderr);
      });
    });
    syncBuiltinESMExports();

    const logs = [];
    const app = Fastify({ logger: { stream: { write: (line) => logs.push(line) } } });
    app.get('/health-ping', async () => ({ reading }));
    t.after(async () => {
      sync.mock.restore();
      asyncRead.mock.restore();
      syncBuiltinESMExports();
      await app.close();
    });
    await app.register(accountsRoutes);
    await app.ready();
    const health = started.promise.then(() => app.inject('/health-ping'));
    const getAccounts = () =>
      app.inject({
        url: `/api/accounts?projectPath=${encodeURIComponent(f.root)}`,
        headers: { 'x-cat-cafe-user': 'dev' },
      });
    const claudeAccount = (response) => response.json().providers.find(({ id }) => id === 'claude');
    const accounts = await getAccounts();
    assert.equal(accounts.statusCode, 200, accounts.body);
    assert.equal(claudeAccount(accounts)?.claudeQuota?.samples['claude-fable-5'].windows.seven_day.utilization, 0.3);
    assert.equal(accounts.body.includes(token), false);
    assert.equal((await health).json().reading, true, 'the health request waited for the Keychain child to exit');

    command = ['-e', `process.stdout.write(${JSON.stringify(payload.replace(token, 'fixture-rotated-token'))})`];
    const rotated = await getAccounts();
    assert.ok(claudeAccount(rotated), rotated.body);
    assert.equal(claudeAccount(rotated).claudeQuota, undefined, 'the new credential must not see the old quota');

    const privateFailure = 'fixture-private-keychain-stderr';
    command = [
      '-e',
      `process.stdout.write(${JSON.stringify(payload)}); process.stderr.write(${JSON.stringify(privateFailure)}); process.exitCode = 1;`,
    ];
    const failed = await getAccounts();
    assert.ok(claudeAccount(failed), failed.body);
    assert.equal(
      claudeAccount(failed).claudeQuota,
      undefined,
      'partial credential output from a failed read is unusable',
    );
    assert.equal(failed.body.includes(token), false);
    assert.equal(failed.body.includes(privateFailure), false);
    assert.equal(
      logs.some((line) => line.includes(token) || line.includes(privateFailure)),
      false,
    );
  },
);

test('passive events persist account × credential × model and Haiku never erases Fable windows', async (t) => {
  const f = fixture(t);
  const windows = {
    seven_day: f.weekly(0.88),
    seven_day_overage_included: f.weekly(0.54),
    future_limit: f.weekly(0.1),
  };
  const owner = await f.owner('a');
  await observeClaudeQuotaMessage(f.root, owner, 'claude-fable-5', {
    type: 'system_info',
    content: JSON.stringify({ type: 'rate_limit', windows }),
    timestamp: f.now,
  });
  await f.record('a', 'claude-haiku-5-5', { seven_day: f.weekly(0.89) }, f.now + 1);
  const stored = readClaudeQuota(f.root, 'a', owner.credentialVersion);
  assert.equal(stored.samples['claude-fable-5'].windows.seven_day_overage_included.utilization, 0.54);
  assert.ok(stored.samples['claude-fable-5'].windows.future_limit);
  assert.equal(stored.samples['claude-haiku-5-5'].windows.seven_day_overage_included, undefined);
  const projected = await f.read({ fable: f.config('claude-fable-5'), haiku: f.config('claude-haiku-5-5') }, f.now + 2);
  assert.deepEqual(
    projected.get('fable').capacityFacts.current.windows.map((w) => [w.windowKey, w.remainingPercent]),
    [
      ['seven_day', 11],
      ['seven_day_overage_included', 46],
      ['future_limit', 90],
    ],
  );
  assert.deepEqual(
    projected.get('haiku').capacityFacts.current.windows.map((w) => w.windowKey),
    ['seven_day', 'seven_day_overage_included', 'future_limit'],
  );
  const sonnet = (await f.read({ cat: f.config('claude-sonnet-5-5') }, f.now + 2)).get('cat').capacityFacts.current;
  assert.equal(sonnet.windows[0].remainingPercent, 11, 'account observations stay visible to every model');
  assert.ok(
    sonnet.windows.every((window) => window.applicability === 'unknown'),
    'observations never assert model eligibility',
  );
  assert.equal(
    sonnet.windows.find((window) => window.windowKey === 'seven_day_overage_included').observedModel,
    'claude-fable-5',
  );
  const raw = readFileSync(join(f.root, '.cat-cafe/claude-quota.sqlite'), 'utf8');
  assert.ok(!raw.includes(f.credentials.a.accessToken));
  assert.ok(!JSON.stringify([...projected]).includes(f.credentials.a.accessToken));
});

test('manual switching keeps the frozen invocation on its own account and exposes the other as switch-required', async (t) => {
  const f = fixture(t);
  await f.record('a', 'claude-fable-5', { seven_day: f.weekly(0.88), seven_day_overage_included: f.weekly(0.54) });
  await f.record('b', 'claude-fable-5', {
    five_hour: f.weekly(0),
    seven_day: f.weekly(0),
    seven_day_overage_included: f.weekly(0),
  });
  const frozen = await f.owner('a');
  const switched = (await f.read({ cat: f.config('claude-fable-5', 'b') })).get('cat').capacityFacts;
  assert.equal(switched.current.windows[0].remainingPercent, 100);
  assert.equal(switched.switchRequired[0].windows[0].remainingPercent, 12);
  const stillRunning = await f.read({ cat: f.config('claude-fable-5', 'b') }, f.now, [
    {
      catId: 'cat',
      providerId: 'anthropic',
      accountRevision: frozen.accountRevision,
      credentialVersion: frozen.credentialVersion,
    },
  ]);
  assert.equal(stillRunning.get('cat').capacityFacts.current.windows[0].remainingPercent, 12);
  assert.equal(stillRunning.get('cat').capacityFacts.switchRequired[0].windows[0].remainingPercent, 100);
  assert.equal(
    readClaudeQuota(f.root, 'b', (await f.owner('b')).credentialVersion).samples['claude-fable-5'].windows.five_hour
      .utilization,
    0,
  );
});

test('credential replacement hides old readings and rejects late writes; late samples cannot replace a newer model reading', async (t) => {
  const f = fixture(t);
  const old = await f.owner('a');
  await f.record('a', 'claude-fable-5', { seven_day: f.weekly(0.5) });
  assert.equal(await f.record('a', 'claude-fable-5', { seven_day: f.weekly(0.1) }, f.now - 1), false);
  f.credentials.a.accessToken = 'sk-ant-oat01-cccccccc';
  f.save();
  assert.equal(readClaudeQuota(f.root, 'a', (await f.owner('a')).credentialVersion), undefined);
  assert.equal(
    await recordClaudeQuota({
      root: f.root,
      account: old,
      model: 'claude-fable-5',
      windows: { seven_day: f.weekly(0.5) },
      observedAt: f.now + 1,
    }),
    false,
  );
  assert.equal((await f.read({ cat: f.config('claude-fable-5') })).get('cat').capacityFacts.current.state, 'unknown');
});

test('elapsed resets retain the last reading and unfamiliar incomplete constraints invalidate routing rather than disappear', async (t) => {
  const f = fixture(t);
  await f.record('a', 'claude-fable-5', {
    seven_day: { utilization: 0.88, resetsAt: (f.now - 1) / 1000 },
    seven_day_overage_included: f.weekly(0.54),
  });
  const reading = (await f.read({ cat: f.config('claude-fable-5') })).get('cat').capacityFacts.current;
  assert.equal(reading.state, 'stale');
  assert.equal(reading.reason, 'reset_elapsed');
  assert.equal(reading.windows[0].remainingPercent, 12);
  await f.record('a', 'claude-fable-5', { seven_day: f.weekly(0.88), future_limit: {} });
  const unknown = (await f.read({ cat: f.config('claude-fable-5') })).get('cat').capacityFacts.current;
  assert.equal(unknown.state, 'unknown');
  assert.equal(unknown.reason, 'no_supported_pool');
  assert.ok(
    readClaudeQuota(f.root, 'a', (await f.owner('a')).credentialVersion).samples['claude-fable-5'].windows.future_limit,
  );
});

test('the builtin claude ref participates without a persisted account row, and re-login invalidates it', async (t) => {
  const f = fixture(t);
  process.env.CLAUDE_CODE_OAUTH_TOKEN = 'sk-ant-oat01-dddddddd';
  f.accounts.claude = { authType: 'oauth' };
  f.save();
  await f.record('claude', 'claude-fable-5', { seven_day: f.weekly(0.88), seven_day_overage_included: f.weekly(0.54) });
  assert.equal(
    (await f.read({ cat: f.config('claude-fable-5', 'claude') })).get('cat').capacityFacts.current.windows[0]
      .remainingPercent,
    12,
  );
  delete f.accounts.claude;
  f.save();
  await f.record('b', 'claude-fable-5', { seven_day: f.weekly(0) });
  assert.equal(
    (await f.read({ cat: f.config('claude-fable-5', 'b') })).get('cat').capacityFacts.switchRequired[0].windows[0]
      .remainingPercent,
    12,
    'native history remains a spare without a persisted row',
  );
  process.env.CLAUDE_CODE_OAUTH_TOKEN = 'sk-ant-oat01-eeeeeeee';
  assert.equal(
    (await f.read({ cat: f.config('claude-fable-5', 'claude') })).get('cat').capacityFacts.current.state,
    'unknown',
  );
});

test('native settings changes remove attribution proof without blocking the invocation or overwriting another account', async (t) => {
  const f = fixture(t);
  process.env.CAT_CAFE_CONFIG_ROOT = f.root;
  process.env.CLAUDE_CODE_OAUTH_TOKEN = 'sk-ant-oat01-ffffffff';
  await f.record('claude', 'claude-fable-5', { seven_day: f.weekly(0.88) });
  const input = {
    catId: 'cat',
    catConfig: { ...f.config('claude-fable-5', 'claude'), id: 'cat' },
    workspace: { usesDefaultWorkspace: false, workingProjectRoot: f.root },
  };
  const before = await freezeExecutionAccountBinding(input);
  assert.ok(before.executionAccount.credentialVersion);
  process.env.ANTHROPIC_API_KEY = 'test-only';
  assert.equal(nativeClaudeQuotaSourceKnown(f.root, []), false, 'ambient API auth cannot borrow the native login');
  delete process.env.ANTHROPIC_API_KEY;
  mkdirSync(join(f.root, '.claude'));
  writeFileSync(
    join(f.root, '.claude/settings.local.json'),
    JSON.stringify({ env: { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-gggggggg' } }),
  );
  await observeClaudeQuotaMessage(
    f.root,
    before.executionAccount,
    'claude-fable-5',
    {
      type: 'system_info',
      timestamp: f.now + 1,
      content: JSON.stringify({ type: 'rate_limit', windows: { seven_day: f.weekly(0) } }),
    },
    () => nativeClaudeQuotaSourceKnown(f.root, []),
  );
  assert.equal(
    readClaudeQuota(f.root, 'claude', before.executionAccount.credentialVersion).samples['claude-fable-5'].windows
      .seven_day.utilization,
    0.88,
  );
  const after = await freezeExecutionAccountBinding(input);
  assert.equal(after.executionAccount.accountRef, 'claude', 'normal invocation remains admitted');
  assert.equal(after.executionAccount.credentialVersion, undefined);
  const projected = await f.read({ cat: input.catConfig }, f.now, [
    { catId: 'cat', accountRevision: after.executionAccount.accountRevision },
  ]);
  const current = projected.get('cat').capacityFacts.current;
  assert.equal(current.state, 'unknown');
  assert.equal(current.reason, 'execution_binding_changed');
});

test('explicit CLI quota sampling authenticates and rejects malformed input before launching anything', async () => {
  const app = Fastify();
  registerClaudeQuotaRoutes(app);
  try {
    const anonymous = await app.inject({ method: 'POST', url: '/api/accounts/a/claude/quota', payload: {} });
    assert.equal(anonymous.statusCode, 401);
    const invalid = await app.inject({
      method: 'POST',
      url: '/api/accounts/a/claude/quota',
      headers: { 'x-cat-cafe-user': 'fixture' },
      payload: { model: 'arbitrary', command: 'unsafe' },
    });
    assert.equal(invalid.statusCode, 400);
  } finally {
    await app.close();
  }
});

test('account endpoint samples Haiku and Fable on the selected row and returns no credential proof', async (t) => {
  const f = fixture(t);
  const app = Fastify();
  const called = [];
  registerClaudeQuotaRoutes(app, async (profile, model) => {
    assert.equal(profile.id, 'b');
    assert.equal(profile.envVars.CLAUDE_CODE_OAUTH_TOKEN, f.credentials.b.accessToken);
    called.push(model);
    return {
      model: model === 'haiku' ? 'claude-haiku-5-5' : 'claude-fable-5',
      windows: [
        {
          seven_day: f.weekly(0),
          ...(model === 'fable' ? { seven_day_overage_included: f.weekly(0) } : {}),
        },
      ],
    };
  });
  const request = {
    method: 'POST',
    url: '/api/accounts/b/claude/quota',
    headers: { 'x-cat-cafe-user': 'fixture' },
    payload: { projectPath: f.root },
  };
  try {
    await app.ready();
    const responses = [await app.inject(request)];
    assert.deepEqual(called, ['haiku', 'fable']);
    for (const response of responses) {
      assert.equal(response.statusCode, 200, response.body);
      assert.equal(response.json().accountRef, 'b');
      assert.equal(
        response.json().claudeQuota.samples['claude-fable-5'].windows.seven_day_overage_included.utilization,
        0,
      );
      assert.ok(!response.body.includes(f.credentials.b.accessToken));
      assert.ok(!response.body.includes('credentialVersion'));
    }
  } finally {
    await app.close();
  }
});

test('a login replaced during explicit sampling rejects the late result without mixing it into the new login', async (t) => {
  const f = fixture(t);
  const app = Fastify();
  registerClaudeQuotaRoutes(app, async () => {
    f.credentials.a.accessToken = 'sk-ant-oat01-hhhhhhhh';
    f.save();
    return { model: 'claude-haiku-5-5', windows: [{ seven_day: f.weekly(0.8) }] };
  });
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/api/accounts/a/claude/quota',
      headers: { 'x-cat-cafe-user': 'fixture' },
      payload: { projectPath: f.root },
    });
    assert.equal(response.statusCode, 409, response.body);
    assert.equal(response.json().error, 'claude_quota_credential_changed');
    assert.equal(readClaudeQuota(f.root, 'a', (await f.owner('a')).credentialVersion), undefined);
  } finally {
    await app.close();
  }
});

test('a refresh after relogin samples the new credential while the old refresh is still in flight', async (t) => {
  const f = fixture(t);
  const app = Fastify();
  const oldToken = f.credentials.a.accessToken;
  const newToken = 'sk-ant-oat01-hhhhhhhh';
  const oldSampling = Promise.withResolvers();
  const releaseOld = Promise.withResolvers();
  const deadline = new AbortController();
  registerClaudeQuotaRoutes(app, async (profile, model) => {
    const token = profile.envVars.CLAUDE_CODE_OAUTH_TOKEN;
    assert.ok(token === oldToken || token === newToken);
    const isOld = token === oldToken;
    if (isOld) {
      oldSampling.resolve();
      await releaseOld.promise;
    }
    return {
      model: `claude-${model}`,
      windows: [{ seven_day: f.weekly(isOld ? 0.8 : 0.2) }],
    };
  });
  const refresh = () =>
    app.inject({
      method: 'POST',
      url: '/api/accounts/a/claude/quota',
      headers: { 'x-cat-cafe-user': 'fixture' },
      payload: { projectPath: f.root },
    });
  const oldRefresh = refresh();
  let newRefresh;
  try {
    await Promise.race([
      oldSampling.promise,
      oldRefresh.then((response) => assert.fail(`old refresh ended before sampling: ${response.statusCode}`)),
    ]);
    f.credentials.a.accessToken = newToken;
    f.save();
    newRefresh = refresh();
    const fresh = await Promise.race([newRefresh, setTimeout(2000, null, { signal: deadline.signal })]);
    assert.ok(fresh, 'the new credential must not wait for the old credential to finish');
    assert.equal(fresh.statusCode, 200, fresh.body);
    assert.equal(fresh.json().claudeQuota.samples['claude-haiku'].windows.seven_day.utilization, 0.2);

    releaseOld.resolve();
    assert.equal((await oldRefresh).statusCode, 409);
    const stored = readClaudeQuota(f.root, 'a', (await f.owner('a')).credentialVersion);
    assert.equal(stored.samples['claude-haiku'].windows.seven_day.utilization, 0.2);
  } finally {
    deadline.abort();
    releaseOld.resolve();
    await Promise.allSettled([oldRefresh, newRefresh]);
    await app.close();
  }
});
