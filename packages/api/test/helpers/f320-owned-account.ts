import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { catRegistry } from '@cat-cafe/shared';
import { resolveByAccountRef } from '../../src/config/account-resolver.js';
import { writeCatalogAccount } from '../../src/config/catalog-accounts.js';
import { resolveCodexAccountLaunch } from '../../src/config/codex-account-launch.js';
import { describeCodexManagedLayout, prepareCodexManagedLayout } from '../../src/config/codex-managed-layout.js';

/** The owner store and execution projects deliberately differ, with no global-root override. */
export function ownedManagedFixture() {
  const saved = { ...process.env };
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'f320-owned-account-')));
  const owner = join(root, 'runtime');
  const external = join(root, 'external');
  const ambient = join(root, 'ambient-a');
  const state = join(root, 'default-b');
  for (const path of [owner, external, ambient, state]) mkdirSync(path);
  writeFileSync(join(external, 'pnpm-workspace.yaml'), 'packages: []\n');
  Object.assign(process.env, {
    HOME: root,
    CODEX_HOME: ambient,
    CAT_CAFE_CONFIG_ROOT: owner,
    CAT_CAFE_DATA_DIR: join(root, 'data'),
    CAT_CAFE_DISABLE_SHARED_STATE_PREFLIGHT: '1',
    AUDIT_LOG_DIR: join(root, 'audit'),
    PROJECT_ALLOWED_ROOTS: root,
  });
  for (const key of [
    'CAT_CAFE_GLOBAL_CONFIG_ROOT',
    'CAT_CAFE_RUNTIME_ROOT',
    'CAT_CAFE_WORKSPACE_ROOT',
    'CODEX_SQLITE_HOME',
  ])
    delete process.env[key];
  const ref = 'codex-00000000-0000-0000-0000-000000000001';
  writeCatalogAccount(owner, 'codex', { authType: 'oauth', clientId: 'openai', envVars: { CODEX_HOME: state } });
  const identity = { userId: 'fixture-user-b', workspaceId: 'fixture-workspace-b', planType: 'pro' };
  const layout = prepareCodexManagedLayout(describeCodexManagedLayout(owner, ref), owner);
  const jwt = `x.${Buffer.from(
    JSON.stringify({
      'https://api.openai.com/auth': {
        chatgpt_user_id: identity.userId,
        chatgpt_account_id: identity.workspaceId,
        chatgpt_plan_type: identity.planType,
      },
    }),
  ).toString('base64url')}.x`;
  writeFileSync(
    join(layout.credentialHome, 'auth.json'),
    JSON.stringify({
      auth_mode: 'chatgpt',
      tokens: { id_token: jwt, account_id: identity.workspaceId, access_token: 'fixture-access-b' },
    }),
    { mode: 0o600 },
  );
  writeCatalogAccount(owner, ref, {
    authType: 'oauth',
    clientId: 'openai',
    displayName: 'Managed B',
    codex: { ...layout, identity },
  });
  const account = resolveByAccountRef(owner, ref)!;
  const launch = resolveCodexAccountLaunch(account, { cwd: external });
  const cat = catRegistry.getOrThrow('codex-sol').config;
  const originalBinding = cat.accountRef;
  cat.accountRef = ref;
  return {
    root,
    owner,
    external,
    ambient,
    state,
    ref,
    layout,
    identity,
    account,
    launch,
    close() {
      if (originalBinding === undefined) delete cat.accountRef;
      else cat.accountRef = originalBinding;
      process.env = saved;
      rmSync(root, { recursive: true, force: true });
    },
  };
}
