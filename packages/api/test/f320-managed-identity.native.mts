import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { writeCatalogAccount } from '../src/config/catalog-accounts.js';
import { finalizeCodexAccountEnvironment } from '../src/config/codex-account-environment.js';
import { resolveCodexAccountLaunch } from '../src/config/codex-account-launch.js';
import { validateCodexNativeAccount } from '../src/config/codex-account-native-validation.js';
import { codexManagedLaunchArgs } from '../src/config/codex-managed-launch.js';
import { prepareCodexManagedLayout } from '../src/config/codex-managed-layout.js';
import { startLayoutHost } from './helpers/f320-layout-rpc.mjs';

test(
  'installed native admits managed config but refuses an unissued identity before business',
  { timeout: 30000 },
  async () => {
    const saved = { ...process.env };
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'f320-managed-dto-')));
    const state = join(root, 'state');
    mkdirSync(state);
    Object.assign(process.env, {
      HOME: root,
      CAT_CAFE_GLOBAL_CONFIG_ROOT: root,
      CAT_CAFE_DATA_DIR: join(root, 'data'),
    });
    delete process.env.CODEX_HOME;
    delete process.env.CODEX_SQLITE_HOME;
    writeCatalogAccount(root, 'codex', { authType: 'oauth', clientId: 'openai', envVars: { CODEX_HOME: state } });
    const identity = {
      userId: 'fixture-user-b',
      workspaceId: 'fixture-workspace-b',
      email: 'b@example.test',
      planType: 'pro',
    };
    const layout = prepareCodexManagedLayout({
      kind: 'managed',
      layoutVersion: 1,
      prepared: false,
      credentialHome: join(root, 'b/home'),
      stateRoot: state,
      sqliteHome: state,
      identity,
    });
    writeFileSync(
      join(state, 'config.toml'),
      'cli_auth_credentials_store="file"\n[features]\nplugins=false\napps=false\nrespect_system_proxy=false\nsystem_proxy_fallback=false\n',
    );
    const jwt = `x.${Buffer.from(JSON.stringify({ email: identity.email, 'https://api.openai.com/auth': { chatgpt_user_id: identity.userId, chatgpt_account_id: identity.workspaceId, chatgpt_plan_type: identity.planType } })).toString('base64url')}.x`;
    writeFileSync(
      join(layout.credentialHome, 'auth.json'),
      JSON.stringify({
        auth_mode: 'chatgpt',
        tokens: {
          id_token: jwt,
          access_token: 'fixture-access-token-b',
          refresh_token: 'fixture-refresh-token-b',
          account_id: identity.workspaceId,
        },
        last_refresh: new Date().toISOString(),
      }),
      { mode: 0o600 },
    );
    const descriptor = resolveCodexAccountLaunch(
      {
        id: 'fixture-b',
        authType: 'oauth',
        codex: layout,
        envVars: { HOME: join(root, 'b/runtime-home'), CODEX_HOME: layout.credentialHome },
      },
      { cwd: root },
    );
    const args = codexManagedLaunchArgs(descriptor, []);
    const env = finalizeCodexAccountEnvironment(descriptor, {
      env: { HOME: join(root, 'b/runtime-home') },
      args,
      cwd: root,
    });
    assert.equal(env.CODEX_CAT_EXPECTED_WORKSPACE_ID, identity.workspaceId);
    const host = await startLayoutHost('codex', layout.credentialHome, state, root, 'observe', args);
    try {
      const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
      // No OAuth authorization was issued. Native workspace discovery cannot succeed
      // through the fixture's blocked proxies; never treat a fabricated file as login proof.
      await assert.rejects(
        validateCodexNativeAccount(
          async (method, params) => {
            requests.push({ method, params });
            return host.rpc(method, params);
          },
          { authMode: 'oauth', sqliteHome: state, cwd: root, credentialHome: layout.credentialHome, identity },
        ),
        /workspace routing discovery failed/,
      );
      assert.deepEqual(
        requests.map((request) => request.method),
        ['config/read', 'configRequirements/read', 'account/read'],
      );
      assert.deepEqual(requests.at(-1)?.params, { refreshToken: false });
      assert.equal(
        requests.some((request) => /^thread\/|^turn\//.test(request.method)),
        false,
      );
    } finally {
      process.env = saved;
      await host.stop();
      rmSync(root, { recursive: true, force: true });
    }
  },
);
