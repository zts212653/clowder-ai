import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import Fastify from 'fastify';
import { resolveByAccountRef } from '../dist/config/account-resolver.js';
import { readAccountRoutingCapacity } from '../dist/config/account-routing-capacity.js';
import { nativeClaudeQuotaSourceKnown } from '../dist/config/claude-quota-source.js';
import { observeClaudeQuotaMessage, readClaudeQuota, recordClaudeQuota } from '../dist/config/claude-quota-store.js';
import { claudeExecutionAccountSnapshot } from '../dist/config/claude-token-account.js';
import { freezeExecutionAccountBinding } from '../dist/domains/cats/services/agents/invocation/execution-account-binding.js';
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
  const record = (ref, model, windows, observedAt = now) =>
    recordClaudeQuota({ root, account: owner(ref), model, windows, observedAt });
  const config = (model, ref = 'a') => ({ clientId: 'anthropic', defaultModel: model, accountRef: ref });
  const read = (configs, observedAt = now, executionBindings) =>
    readAccountRoutingCapacity({ projectRoot: root, configs, observedAt, executionBindings });
  return { root, now, owner, weekly, record, config, read, credentials, accounts, save };
}

test('passive events persist account × credential × model and Haiku never erases Fable windows', (t) => {
  const f = fixture(t);
  const windows = {
    seven_day: f.weekly(0.88),
    seven_day_overage_included: f.weekly(0.54),
    future_limit: f.weekly(0.1),
  };
  observeClaudeQuotaMessage(f.root, f.owner('a'), 'claude-fable-5', {
    type: 'system_info',
    content: JSON.stringify({ type: 'rate_limit', windows }),
    timestamp: f.now,
  });
  f.record('a', 'claude-haiku-5-5', { seven_day: f.weekly(0.89) }, f.now + 1);
  const stored = readClaudeQuota(f.root, 'a', f.owner('a').credentialVersion);
  assert.equal(stored.samples['claude-fable-5'].windows.seven_day_overage_included.utilization, 0.54);
  assert.ok(stored.samples['claude-fable-5'].windows.future_limit);
  assert.equal(stored.samples['claude-haiku-5-5'].windows.seven_day_overage_included, undefined);
  const projected = f.read({ fable: f.config('claude-fable-5'), haiku: f.config('claude-haiku-5-5') }, f.now + 2);
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
  const sonnet = f.read({ cat: f.config('claude-sonnet-5-5') }, f.now + 2).get('cat').capacityFacts.current;
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

test('manual switching keeps the frozen invocation on its own account and exposes the other as switch-required', (t) => {
  const f = fixture(t);
  f.record('a', 'claude-fable-5', { seven_day: f.weekly(0.88), seven_day_overage_included: f.weekly(0.54) });
  f.record('b', 'claude-fable-5', {
    five_hour: f.weekly(0),
    seven_day: f.weekly(0),
    seven_day_overage_included: f.weekly(0),
  });
  const frozen = f.owner('a');
  const switched = f.read({ cat: f.config('claude-fable-5', 'b') }).get('cat').capacityFacts;
  assert.equal(switched.current.windows[0].remainingPercent, 100);
  assert.equal(switched.switchRequired[0].windows[0].remainingPercent, 12);
  const stillRunning = f
    .read({ cat: f.config('claude-fable-5', 'b') }, f.now, [
      {
        catId: 'cat',
        providerId: 'anthropic',
        accountRevision: frozen.accountRevision,
        credentialVersion: frozen.credentialVersion,
      },
    ])
    .get('cat').capacityFacts;
  assert.equal(stillRunning.current.windows[0].remainingPercent, 12);
  assert.equal(stillRunning.switchRequired[0].windows[0].remainingPercent, 100);
  assert.equal(
    readClaudeQuota(f.root, 'b', f.owner('b').credentialVersion).samples['claude-fable-5'].windows.five_hour
      .utilization,
    0,
  );
});

test('credential replacement hides old readings and rejects late writes; late samples cannot replace a newer model reading', (t) => {
  const f = fixture(t);
  const old = f.owner('a');
  f.record('a', 'claude-fable-5', { seven_day: f.weekly(0.5) });
  assert.equal(f.record('a', 'claude-fable-5', { seven_day: f.weekly(0.1) }, f.now - 1), false);
  f.credentials.a.accessToken = 'sk-ant-oat01-cccccccc';
  f.save();
  assert.equal(readClaudeQuota(f.root, 'a', f.owner('a').credentialVersion), undefined);
  assert.equal(
    recordClaudeQuota({
      root: f.root,
      account: old,
      model: 'claude-fable-5',
      windows: { seven_day: f.weekly(0.5) },
      observedAt: f.now + 1,
    }),
    false,
  );
  assert.equal(f.read({ cat: f.config('claude-fable-5') }).get('cat').capacityFacts.current.state, 'unknown');
});

test('elapsed resets retain the last reading and unfamiliar incomplete constraints invalidate routing rather than disappear', (t) => {
  const f = fixture(t);
  f.record('a', 'claude-fable-5', {
    seven_day: { utilization: 0.88, resetsAt: (f.now - 1) / 1000 },
    seven_day_overage_included: f.weekly(0.54),
  });
  const reading = f.read({ cat: f.config('claude-fable-5') }).get('cat').capacityFacts.current;
  assert.equal(reading.state, 'stale');
  assert.equal(reading.reason, 'reset_elapsed');
  assert.equal(reading.windows[0].remainingPercent, 12);
  f.record('a', 'claude-fable-5', { seven_day: f.weekly(0.88), future_limit: {} });
  const unknown = f.read({ cat: f.config('claude-fable-5') }).get('cat').capacityFacts.current;
  assert.equal(unknown.state, 'unknown');
  assert.equal(unknown.reason, 'no_supported_pool');
  assert.ok(
    readClaudeQuota(f.root, 'a', f.owner('a').credentialVersion).samples['claude-fable-5'].windows.future_limit,
  );
});

test('the builtin claude ref participates without a persisted account row, and re-login invalidates it', (t) => {
  const f = fixture(t);
  process.env.CLAUDE_CODE_OAUTH_TOKEN = 'sk-ant-oat01-dddddddd';
  f.accounts.claude = { authType: 'oauth' };
  f.save();
  f.record('claude', 'claude-fable-5', { seven_day: f.weekly(0.88), seven_day_overage_included: f.weekly(0.54) });
  assert.equal(
    f.read({ cat: f.config('claude-fable-5', 'claude') }).get('cat').capacityFacts.current.windows[0].remainingPercent,
    12,
  );
  delete f.accounts.claude;
  f.save();
  f.record('b', 'claude-fable-5', { seven_day: f.weekly(0) });
  assert.equal(
    f.read({ cat: f.config('claude-fable-5', 'b') }).get('cat').capacityFacts.switchRequired[0].windows[0]
      .remainingPercent,
    12,
    'native history remains a spare without a persisted row',
  );
  process.env.CLAUDE_CODE_OAUTH_TOKEN = 'sk-ant-oat01-eeeeeeee';
  assert.equal(f.read({ cat: f.config('claude-fable-5', 'claude') }).get('cat').capacityFacts.current.state, 'unknown');
});

test('native settings changes remove attribution proof without blocking the invocation or overwriting another account', (t) => {
  const f = fixture(t);
  process.env.CAT_CAFE_CONFIG_ROOT = f.root;
  process.env.CLAUDE_CODE_OAUTH_TOKEN = 'sk-ant-oat01-ffffffff';
  f.record('claude', 'claude-fable-5', { seven_day: f.weekly(0.88) });
  const input = {
    catId: 'cat',
    catConfig: { ...f.config('claude-fable-5', 'claude'), id: 'cat' },
    workspace: { usesDefaultWorkspace: false, workingProjectRoot: f.root },
  };
  const before = freezeExecutionAccountBinding(input);
  assert.ok(before.executionAccount.credentialVersion);
  process.env.ANTHROPIC_API_KEY = 'test-only';
  assert.equal(nativeClaudeQuotaSourceKnown(f.root, []), false, 'ambient API auth cannot borrow the native login');
  delete process.env.ANTHROPIC_API_KEY;
  mkdirSync(join(f.root, '.claude'));
  writeFileSync(
    join(f.root, '.claude/settings.local.json'),
    JSON.stringify({ env: { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-gggggggg' } }),
  );
  observeClaudeQuotaMessage(
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
  const after = freezeExecutionAccountBinding(input);
  assert.equal(after.executionAccount.accountRef, 'claude', 'normal invocation remains admitted');
  assert.equal(after.executionAccount.credentialVersion, undefined);
  const current = f
    .read({ cat: input.catConfig }, f.now, [{ catId: 'cat', accountRevision: after.executionAccount.accountRevision }])
    .get('cat').capacityFacts.current;
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
    assert.equal(readClaudeQuota(f.root, 'a', f.owner('a').credentialVersion), undefined);
  } finally {
    await app.close();
  }
});
