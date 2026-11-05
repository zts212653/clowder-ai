import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RuntimeRoutingCandidateCatalogSource } from '../../dist/domains/routing-context/selection/RuntimeRoutingCandidateCatalogSource.js';

export function accountCapacityFixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'f293-capacity-'));
  const previous = process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT;
  const previousOwner = process.env.DEFAULT_OWNER_USER_ID;
  process.env.DEFAULT_OWNER_USER_ID = 'owner';
  process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT = root;
  t.after(() => {
    if (previous === undefined) delete process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT;
    else process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT = previous;
    if (previousOwner === undefined) delete process.env.DEFAULT_OWNER_USER_ID;
    else process.env.DEFAULT_OWNER_USER_ID = previousOwner;
    rmSync(root, { recursive: true, force: true });
  });
  const now = Date.now();
  const accounts = {};
  function account(ref, user, usedPercent) {
    const home = join(root, ref);
    mkdirSync(home, { recursive: true });
    const identity = { userId: user, workspaceId: 'workspace-' + user, planType: 'plus' };
    const claims = {
      'https://api.openai.com/auth': { chatgpt_user_id: user, chatgpt_account_id: identity.workspaceId },
    };
    writeFileSync(
      join(home, 'auth.json'),
      JSON.stringify({
        tokens: {
          id_token: 'x.' + Buffer.from(JSON.stringify(claims)).toString('base64url') + '.x',
          account_id: identity.workspaceId,
        },
      }),
    );
    const item = {
      label: '5小时使用限额',
      poolId: 'codex-main',
      usedPercent,
      percentKind: 'used',
      resetsAt: new Date(now + 3600000).toISOString(),
    };
    accounts[ref] = {
      clientId: 'openai',
      authType: 'oauth',
      displayName: ref === 'main-private-ref' ? '主号' : '备用号',
      codex: {
        kind: 'managed',
        layoutVersion: 1,
        credentialHome: home,
        stateRoot: home,
        sqliteHome: home,
        prepared: true,
        identity,
      },
      quota: {
        owner: { accountRef: ref, ...identity },
        source: 'codex_official_readonly',
        status: 'ok',
        observedAt: now,
        items: [
          item,
          {
            ...item,
            label: '每周使用限额',
            usedPercent: usedPercent + 5,
            resetsAt: new Date(now + 7 * 86400000).toISOString(),
          },
        ],
      },
    };
  }
  account('main-private-ref', 'private-principal-main', 30);
  account('spare-private-ref', 'private-principal-spare', 0);
  function save() {
    mkdirSync(join(root, '.cat-cafe'), { recursive: true });
    writeFileSync(join(root, '.cat-cafe', 'accounts.json'), JSON.stringify(accounts));
  }
  const config = (id, accountRef) => ({
    id,
    clientId: 'openai',
    defaultModel: 'gpt-6.1-sol',
    ...(accountRef ? { accountRef } : {}),
  });
  const configs = {
    first: config('first', 'main-private-ref'),
    second: config('second', 'main-private-ref'),
    unbound: config('unbound'),
  };
  const source = new RuntimeRoutingCandidateCatalogSource({ getConfigs: () => configs, projectRoot: root });
  save();
  return { root, now, accounts, configs, source, save };
}
