import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type TestContext, test } from 'node:test';
import type { CatConfig } from '@cat-cafe/shared';
import { freezeExecutionAccountBinding } from '../src/domains/cats/services/agents/invocation/execution-account-binding.js';

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'execution-account-choice-'));
  const previous = process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT;
  process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT = root;
  t.after(() => {
    if (previous === undefined) delete process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT;
    else process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT = previous;
    rmSync(root, { recursive: true, force: true });
  });
  const dir = join(root, '.cat-cafe');
  mkdirSync(dir);
  const accounts = {
    subscription: { clientId: 'openai', authType: 'oauth' },
    paid: { clientId: 'openai', authType: 'api_key' },
    foreign: { clientId: 'anthropic', authType: 'oauth' },
  };
  const save = () => writeFileSync(join(dir, 'accounts.json'), JSON.stringify(accounts));
  save();
  writeFileSync(join(dir, 'credentials.json'), JSON.stringify({ paid: { apiKey: 'fixture-key-never-real' } }));
  const cat = {
    id: 'codex61-sol',
    clientId: 'openai',
    defaultModel: 'gpt-6.1-sol',
    accountRef: 'subscription',
  } as CatConfig;
  const input = { catId: cat.id, catConfig: cat, workspace: { usesDefaultWorkspace: false, workingProjectRoot: root } };
  return { input, cat, accounts, save, file: join(dir, 'accounts.json') };
}

test('an execution chooses an existing API account without changing the member or the next ordinary invocation', (t) => {
  const f = fixture(t);
  const before = readFileSync(f.file, 'utf8');
  const game = freezeExecutionAccountBinding({
    ...f.input,
    accountSelection: { accountRef: 'paid', authType: 'api_key' },
  });
  assert.equal(game.effectiveAccountRef, 'paid');
  assert.equal(game.executionAccount?.accountRef, 'paid');
  assert.equal(game.executionAccount?.authType, 'api_key');
  assert.equal(game.catConfig?.defaultModel, 'gpt-6.1-sol');
  assert.equal(f.cat.accountRef, 'subscription');
  assert.equal(readFileSync(f.file, 'utf8'), before);
  const outside = freezeExecutionAccountBinding(f.input);
  assert.equal(outside.executionAccount?.accountRef, 'subscription');
  assert.equal(outside.executionAccount?.authType, 'oauth');
  f.cat.defaultModel = 'later-model';
  assert.equal(game.catConfig?.defaultModel, 'gpt-6.1-sol');
  assert.ok(Object.isFrozen(game.resolvedAccount));
  assert.ok(!JSON.stringify(game.executionAccount).includes('fixture-key'));
});

test('member env is frozen per execution while the selected account keeps final precedence', (t) => {
  const f = fixture(t);
  const previous = process.env.ROLE_EXECUTION_ENDPOINT;
  process.env.ROLE_EXECUTION_ENDPOINT = 'before';
  t.after(() => {
    if (previous === undefined) delete process.env.ROLE_EXECUTION_ENDPOINT;
    else process.env.ROLE_EXECUTION_ENDPOINT = previous;
  });
  Object.assign(f.accounts.paid, { envVars: { ACCOUNT_ROUTE: 'account-owned' } });
  f.save();
  const input = {
    ...f.input,
    catConfig: { ...f.cat, env: { CUSTOM_ENDPOINT: '${ROLE_EXECUTION_ENDPOINT}', ACCOUNT_ROUTE: 'member' } },
    accountSelection: { accountRef: 'paid', authType: 'api_key' as const },
  };
  const first = freezeExecutionAccountBinding(input);
  assert.equal(first.accountEnv?.CUSTOM_ENDPOINT, 'before');
  assert.equal(first.accountEnv?.ACCOUNT_ROUTE, 'account-owned');
  assert.ok(Object.isFrozen(first.accountEnv));
  process.env.ROLE_EXECUTION_ENDPOINT = 'after';
  const next = freezeExecutionAccountBinding(input);
  assert.equal(first.accountEnv?.CUSTOM_ENDPOINT, 'before');
  assert.equal(next.accountEnv?.CUSTOM_ENDPOINT, 'after');
  assert.equal(
    freezeExecutionAccountBinding({ ...input, catConfig: { ...input.catConfig, agyProfile: { enabled: false } } })
      .accountEnv?.CUSTOM_ENDPOINT,
    'after',
  );
  assert.throws(
    () => freezeExecutionAccountBinding({ ...input, catConfig: { ...input.catConfig, agyProfile: { enabled: true } } }),
    /isolated AGY/,
  );
  assert.equal(f.cat.accountRef, 'subscription');
});

test('remote and API-loop carriers do not pretend to apply a process environment', (t) => {
  const f = fixture(t);
  for (const clientId of ['a2a', 'catagent'] as const) {
    assert.throws(
      () =>
        freezeExecutionAccountBinding({
          ...f.input,
          catConfig: {
            ...f.cat,
            clientId,
            configurationSource: 'native_tool',
            accountRef: undefined,
            env: { CUSTOM_ENDPOINT: 'configured' },
          },
        }),
      /local process carrier/,
    );
  }
});

test('an explicit choice never falls back on deletion, missing credentials, a changed auth type or a foreign provider', (t) => {
  const f = fixture(t);
  const choose = (accountRef: string, authType: 'oauth' | 'api_key') =>
    freezeExecutionAccountBinding({ ...f.input, accountSelection: { accountRef, authType } });
  for (const accountRef of ['', ' paid', 'absent', 'foreign']) assert.throws(() => choose(accountRef, 'oauth'));
  assert.throws(() => choose('paid', 'oauth'), /auth/i);
  assert.throws(() => choose('subscription', 'api_key'), /auth/i);
  writeFileSync(join(f.file, '..', 'credentials.json'), '{}');
  assert.throws(() => choose('paid', 'api_key'), /key/i);
  assert.equal(f.cat.accountRef, 'subscription');
});

test('a previously frozen choice requires the same account revision on the next execution', (t) => {
  const f = fixture(t);
  const first = freezeExecutionAccountBinding({
    ...f.input,
    accountSelection: { accountRef: 'paid', authType: 'api_key' },
  });
  assert.ok(first.executionAccount);
  const selection = {
    accountRef: 'paid',
    authType: 'api_key' as const,
    expectedRevision: first.executionAccount.accountRevision,
  };
  assert.equal(freezeExecutionAccountBinding({ ...f.input, accountSelection: selection }).effectiveAccountRef, 'paid');
  assert.throws(
    () =>
      freezeExecutionAccountBinding({
        ...f.input,
        accountSelection: { ...selection, expectedRevision: '0'.repeat(64) },
      }),
    /revision changed/,
  );
  f.accounts.paid = { ...f.accounts.paid, clientId: 'anthropic' };
  f.save();
  assert.throws(() => freezeExecutionAccountBinding({ ...f.input, accountSelection: selection }));
});

test('Kimi native source metadata tags its unchanged Host account and ordinary execution stays unchanged', (t) => {
  const f = fixture(t);
  f.cat.clientId = 'kimi';
  f.cat.defaultModel = 'kimi-code/k3.1-pro';
  f.accounts.subscription.clientId = 'kimi';
  f.save();
  const original = freezeExecutionAccountBinding(f.input);
  assert.ok(original.resolvedAccount);
  const nativeAccount = { ...original.resolvedAccount, nativeSourceRevision: 'a'.repeat(64) };
  const projected = freezeExecutionAccountBinding({ ...f.input, nativeAccount });
  assert.notEqual(projected.executionAccount?.accountRevision, original.executionAccount?.accountRevision);
  assert.equal(projected.executionAccount?.accountRef, original.executionAccount?.accountRef);
  assert.deepEqual(freezeExecutionAccountBinding(f.input).executionAccount, original.executionAccount);
  for (const delta of [
    { id: 'foreign' },
    { authType: 'api_key' as const, apiKey: 'EXAMPLE' },
    { baseUrl: 'https://changed.example.test' },
    { nativeSourceRevision: 'invalid' },
  ]) {
    assert.throws(
      () => freezeExecutionAccountBinding({ ...f.input, nativeAccount: { ...nativeAccount, ...delta } }),
      /native account carrier mismatch/,
    );
  }
});

test('a Kimi source annotation cannot replace another builtin carrier account path', (t) => {
  const f = fixture(t),
    original = freezeExecutionAccountBinding(f.input);
  assert.ok(original.resolvedAccount);
  assert.throws(
    () =>
      freezeExecutionAccountBinding({
        ...f.input,
        nativeAccount: { ...original.resolvedAccount, nativeSourceRevision: 'a'.repeat(64) },
      }),
    /native account carrier mismatch/,
  );
});
