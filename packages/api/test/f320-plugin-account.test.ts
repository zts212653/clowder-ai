import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { prepareCodexNativeLaunch } from '../src/domains/cats/services/agents/providers/codex-plugin-native-launch.js';
import { ownedManagedFixture } from './helpers/f320-owned-account.js';

// The native preparation boundary is real; no provider process or external account is used.
// Native public execution supports exec_json only; ordinary account/carrier tests remain in F320.
for (const carrier of ['exec_json', 'app_server']) {
  test(`managed plugin ${carrier} keeps account B isolated from ambient A`, async () => {
    const f = ownedManagedFixture();
    try {
      const workspace = join(f.external, 'public');
      mkdirSync(workspace, { mode: 0o700 });
      const options = {
        signal: new AbortController().signal,
        workingDirectory: workspace,
        codexAccountLaunch: f.launch,
        callbackEnv: {
          CODEX_AUTH_MODE: 'oauth',
          CAT_CAFE_INVOCATION_ID: 'fixture',
          CAT_CAFE_CALLBACK_TOKEN: 'fixture',
        },
        toolExecutionPolicy: {
          mode: 'plugin_native' as const,
          pluginInstanceId: 'instance',
          contributionId: 'native',
          actionMethods: ['native.read'],
        },
        pluginNativeLaunch: {
          sandbox: { kind: 'public' as const, workspaceRoot: workspace },
          server: {
            name: 'native',
            transport: 'stdio' as const,
            command: process.execPath,
            workingDirectory: workspace,
            args: [],
            env: { CLOWDER_PLUGIN_ACTION_TOKEN: 'fixture' },
          },
          assertCurrent: async () => {},
        },
      };
      if (carrier === 'app_server') {
        await assert.rejects(prepareCodexNativeLaunch(options, carrier, true), /plugin_native_launch_unavailable/);
        return;
      }
      const before = readFileSync(join(f.layout.credentialHome, 'auth.json'), 'utf8');
      const prepared = await prepareCodexNativeLaunch(options, carrier, true);
      try {
        const home = prepared.env.CODEX_HOME;
        assert.notEqual(home, f.layout.credentialHome);
        assert.notEqual(home, f.ambient);
        assert.equal(realpathSync(join(home, 'auth.json')), join(f.layout.credentialHome, 'auth.json'));
        assert.equal(prepared.env.CODEX_SQLITE_HOME, home);
        assert.ok(prepared.args.includes('cli_auth_credentials_store="file"'));
        assert.ok(prepared.args.includes(`forced_chatgpt_workspace_id=${JSON.stringify(f.identity.workspaceId)}`));
        assert.ok(prepared.args.includes(`sqlite_home=${JSON.stringify(home)}`));
        assert.equal(prepared.env.CODEX_CAT_EXPECTED_USER_ID, f.identity.userId);
        assert.equal(prepared.env.CODEX_CAT_EXPECTED_WORKSPACE_ID, f.identity.workspaceId);
        assert.equal(prepared.env.OPENAI_API_KEY, undefined);
        assert.equal(existsSync(join(home, 'config.toml')), false);
      } finally {
        prepared.dispose();
      }
      assert.equal(existsSync(prepared.env.CODEX_HOME), false);
      assert.equal(readFileSync(join(f.layout.credentialHome, 'auth.json'), 'utf8'), before);
    } finally {
      f.close();
    }
  });
}
