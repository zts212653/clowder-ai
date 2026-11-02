import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { catRegistry } from '@cat-cafe/shared';
import { configStore } from '../dist/config/ConfigStore.js';
import { writeCatalogAccount } from '../dist/config/catalog-accounts.js';
import { prepareInvocationExecutionBinding } from '../dist/domains/cats/services/agents/invocation/invoke-single-cat.js';
import { isolateAccountAuthEnvironment } from './helpers/account-auth-environment.js';

for (const change of ['account-home', 'codex-policy', 'quota-only']) {
  test(`formal admission checks consumed account/policy inputs after a ${change} write`, async (t) => {
    t.after(isolateAccountAuthEnvironment());
    const parent = resolve('artifacts/role-agent-refactor/account-currentness');
    mkdirSync(parent, { recursive: true });
    const root = mkdtempSync(join(parent, 'fixture-'));
    const keys = ['CAT_CAFE_CONFIG_ROOT', 'CAT_CAFE_GLOBAL_CONFIG_ROOT', 'CAT_CODEX_SANDBOX_MODE'];
    const previous = new Map(keys.map((key) => [key, process.env[key]]));
    process.env.CAT_CAFE_CONFIG_ROOT = root;
    process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT = root;
    process.env.CAT_CODEX_SANDBOX_MODE = 'read-only';
    const all = catRegistry.getAllConfigs(),
      catId = 'account-currentness';
    const policy = change === 'codex-policy';
    catRegistry.register(catId, {
      ...all[policy ? 'codex' : 'kimi'],
      id: catId,
      mcpSupport: false,
      configurationSource: policy ? 'native_tool' : 'managed_account',
      accountRef: policy ? undefined : 'owned-kimi',
    });
    t.after(() => {
      configStore.reset();
      previous.forEach((value, key) => {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      });
      catRegistry.reset();
      Object.entries(all).forEach(([id, config]) => catRegistry.register(id, config));
    });
    const account = { authType: 'oauth', clientId: 'kimi', envVars: { KIMI_CODE_HOME: join(root, 'before') } };
    if (!policy) writeCatalogAccount(root, 'owned-kimi', account);
    let captured;
    const service = {
      async captureInvocationOptions(input) {
        captured = input.accountEnv;
        if (policy) configStore.set('cli.codexSandboxMode', 'workspace-write');
        else
          writeCatalogAccount(root, 'owned-kimi', {
            ...account,
            ...(change === 'account-home'
              ? { envVars: { KIMI_CODE_HOME: join(root, 'after') } }
              : {
                  quota: {
                    status: 'unsupported',
                    source: 'codex_official_readonly',
                    items: [],
                    observedAt: Date.now(),
                  },
                }),
          });
        return {};
      },
      async *invoke() {
        assert.fail('admission must not start a model turn');
      },
    };
    const pending = prepareInvocationExecutionBinding(
      { threadStore: null, apiUrl: 'http://127.0.0.1:13004' },
      { catId, service, threadId: 'thread', userId: 'owner' },
    );
    if (change === 'quota-only') {
      const binding = await pending;
      assert.deepEqual(binding.accountEnv, captured);
      assert.equal(binding.accountEnv.KIMI_CODE_HOME, join(root, 'before'));
    } else
      await assert.rejects(
        pending,
        (error) => error.statusCode === 409 && /configuration changed.*admission/i.test(error.message),
      );
  });
}
