import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type TestContext, test } from 'node:test';
import { type CatConfig, createCatId } from '@cat-cafe/shared';
import { AgyNativeAgentService } from '../src/domains/cats/services/agents/providers/agy-native/AgyNativeAgentService.js';
import { createMemberResourceDescription } from '../src/domains/plugin/member-sessions/resources.js';
import { createMemberRuntime } from '../src/domains/plugin/member-sessions/runtime.js';
import { createPluginMemberSessions } from '../src/domains/plugin/member-sessions/service.js';
import { memberSessionFixture } from './helpers/plugin-member-session-fixture.js';

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'agy-member-account-'));
  const previous = process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT;
  process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT = root;
  t.after(() => {
    if (previous === undefined) delete process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT;
    else process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT = previous;
    rmSync(root, { recursive: true, force: true });
  });
  const directory = join(root, '.cat-cafe');
  mkdirSync(directory);
  writeFileSync(
    join(directory, 'accounts.json'),
    JSON.stringify({
      existing: { clientId: 'google', authType: 'oauth' },
      gateway: { clientId: 'google', authType: 'api_key', baseUrl: 'https://gemini-gateway.example.test' },
    }),
  );
  writeFileSync(join(directory, 'credentials.json'), JSON.stringify({ gateway: { apiKey: 'fixture-only-key' } }));
  const config = {
    id: createCatId('member'),
    clientId: 'google',
    defaultModel: 'gemini-3.8-flash-high',
    accountRef: 'existing',
  } as CatConfig;
  let queries = 0;
  const service = new AgyNativeAgentService({
    catId: config.id,
    profile: { enabled: true, profileId: 'member', homeRoot: join(root, 'profiles'), model: config.defaultModel },
    l0CompilerFn: async () => {
      queries++;
      throw new Error('preflight must not invoke a provider');
    },
  });
  const runtime = createMemberRuntime({
    config: () => config,
    service: () => service,
    workspace: async () => ({ usesDefaultWorkspace: false, workingDirectory: root, workingProjectRoot: root }),
  });
  const describe = createMemberResourceDescription({
    projectRoot: root,
    config: () => config,
    service: () => service,
    memory: async () => [],
  });
  return { root, runtime, describe, queries: () => queries };
}

test('native member discovery marks third-party API accounts unavailable before selection', async (t) => {
  const f = fixture(t),
    base = memberSessionFixture();
  const result = await f.describe('member', base.scope());
  assert.equal(result.accounts.find((account) => account.accountRef === 'existing')?.available, true);
  assert.equal(result.accounts.find((account) => account.accountRef === 'gateway')?.available, false);
  assert.equal(
    result.accounts.find((account) => account.accountRef === 'gateway')?.reason,
    'member_account_unavailable',
  );
  assert.equal(f.queries(), 0);
});

test('native member preparation rejects an API account before persisting a grant and preserves OAuth', async (t) => {
  const f = fixture(t),
    base = memberSessionFixture();
  const port = createPluginMemberSessions({
    ...base.deps,
    resolveRuntime: (input, scope) => f.runtime.snapshot(input, scope),
  }).forInstance(base.scope());
  await assert.rejects(
    base.owner(() =>
      port.prepare({ ...base.prepareInput, accountSelection: { accountRef: 'gateway', authType: 'api_key' } }),
    ),
    /agy_scoped_native_account_unavailable/,
  );
  assert.equal(
    [...base.rows.values()].some((row) => (row.value as { schema?: string })?.schema === 'host.member-session.v1'),
    false,
  );
  const session = await base.owner(() => port.prepare(base.prepareInput));
  assert.equal(session.runtime.account.accountRef, 'existing');
  assert.equal(session.runtime.account.authType, 'oauth');
  assert.equal(base.sends(), 0);
  assert.equal(f.queries(), 0);
});
