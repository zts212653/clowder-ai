/** Explicit dogfood adapter. Default is isolated fixtures; real homes require an opt-in private snapshot. */
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { AccountConfig, AccountQuotaObservation } from '@cat-cafe/shared';
import Fastify from 'fastify';
import { readAccountStoreSnapshot } from '../../src/config/account-store-snapshot.js';
import { describeCodexManagedLayout, prepareCodexManagedLayout } from '../../src/config/codex-managed-layout.js';
import { renewCodexQuotaLogin } from '../../src/config/codex-quota-renewal.js';
import { registerCodexQuotaRoutes } from '../../src/routes/accounts-codex-quota.js';
import { accountToView } from '../../src/routes/accounts-view.js';

type Row = {
  id: string;
  displayName: string;
  codex: NonNullable<AccountConfig['codex']>;
  quota?: AccountQuotaObservation;
};
const snapshot = process.env.F322_REAL_ACCOUNTS_SNAPSHOT;
const root = mkdtempSync(join(tmpdir(), 'f322-quota-dogfood-'));
const home = join(root, 'home');
mkdirSync(home);
const defaultHome = join(home, '.codex');
mkdirSync(defaultHome);
writeFileSync(join(defaultHome, 'config.toml'), 'cli_auth_credentials_store="file"\n');
Object.assign(process.env, { HOME: home, CAT_CAFE_GLOBAL_CONFIG_ROOT: root, CAT_CAFE_DATA_DIR: join(root, 'data') });
delete process.env.CODEX_HOME;
delete process.env.CODEX_SQLITE_HOME;
mkdirSync(join(root, '.cat-cafe'));
const path = join(root, '.cat-cafe', 'accounts.json');
writeFileSync(path, JSON.stringify({ codex: { authType: 'oauth', clientId: 'openai' } }));
function fixtureRows(): Row[] {
  const now = Date.now();
  return [
    '11111111-1111-4111-8111-111111111111',
    '22222222-2222-4222-8222-222222222222',
    '33333333-3333-4333-8333-333333333333',
  ].map((suffix, index) => {
    const id = 'codex-' + suffix,
      identity = { userId: id, workspaceId: 'fixture', email: 'fixture@example.test' };
    const layout = prepareCodexManagedLayout(describeCodexManagedLayout(root, id));
    const claims = Buffer.from(
      JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_user_id: id, chatgpt_account_id: 'fixture' } }),
    ).toString('base64url');
    writeFileSync(
      join(layout.credentialHome, 'auth.json'),
      JSON.stringify({
        tokens: {
          id_token: `x.${claims}.x`,
          access_token: index === 1 ? 'fixture-old' : 'fixture-new',
          account_id: 'fixture',
        },
        last_refresh: new Date(now - (index === 1 ? 86400000 : 60000)).toISOString(),
      }),
    );
    return {
      id,
      displayName: ['Renewed fixture', 'Expired fixture', 'Unused fixture'][index],
      codex: { ...layout, identity },
      ...(index < 2
        ? {
            quota: {
              owner: { accountRef: id, ...identity },
              observedAt: now - 3600000,
              status: 'unavailable' as const,
              source: 'codex_official_readonly' as const,
              items: [],
              error: '登录凭据已过期，请让官方 Codex 完成续期后再查询',
            },
          }
        : {}),
    };
  });
}
const rows: Row[] = snapshot ? JSON.parse(readFileSync(snapshot, 'utf8')) : fixtureRows();
const accounts: Record<string, AccountConfig> = {
  codex: {
    authType: 'oauth',
    clientId: 'openai',
    envVars: { CODEX_HOME: rows[0].codex.stateRoot, CODEX_SQLITE_HOME: rows[0].codex.sqliteHome },
  },
};
for (const row of rows) {
  const { kind, layoutVersion, credentialHome, prepared, identity, stateRoot, sqliteHome } = row.codex;
  accounts[row.id] = {
    authType: 'oauth',
    clientId: 'openai',
    displayName: row.displayName,
    codex: { kind, layoutVersion, credentialHome, prepared, identity, stateRoot, sqliteHome },
    quota: row.quota,
  };
}
writeFileSync(path, JSON.stringify(accounts));
const fakeDoctor = join(root, 'fixture-doctor');
writeFileSync(
  fakeDoctor,
  `#!${process.execPath}\nconst fs=require('node:fs'),p=require('node:path');const file=p.join(process.env.CODEX_HOME,'auth.json');const auth=JSON.parse(fs.readFileSync(file));auth.tokens.access_token='fixture-new';auth.last_refresh=new Date().toISOString();fs.writeFileSync(file,JSON.stringify(auth));setInterval(()=>{},1000);\n`,
);
chmodSync(fakeDoctor, 0o700);
let offline = false;
const app = Fastify();
app.get('/fixture/accounts', () => ({
  projectPath: process.cwd(),
  providers: rows.map((row) =>
    accountToView(row.id, readAccountStoreSnapshot(root).resolve(row.id).account!, false, root),
  ),
}));
app.post('/fixture/scenario', async (request) => {
  const body = request.body as { offline?: boolean; reset?: boolean };
  offline = !!body.offline;
  if (body.reset) writeFileSync(path, JSON.stringify(accounts));
  return { offline };
});
registerCodexQuotaRoutes(
  app,
  async (...args) => {
    if (offline) throw Error('Simulated network unavailable');
    if (snapshot) return fetch(...args);
    const headers = new Headers(args[1]?.headers);
    return headers.get('Authorization') === 'Bearer fixture-old'
      ? Response.json(
          { error: { message: 'The authentication token has expired', code: 'token_expired' } },
          { status: 401 },
        )
      : Response.json({
          rate_limit: { primary_window: { used_percent: 54, reset_at: Math.floor(Date.now() / 1000) + 86400 } },
        });
  },
  async (profile, cwd) => {
    if (offline) throw Error('Network simulation skips renewal');
    await renewCodexQuotaLogin(profile, cwd, snapshot ? undefined : fakeDoctor);
  },
);
app.get('/fixture/revision', () => ({
  cwd: resolve(process.cwd()),
  mode: snapshot ? 'real-opt-in' : 'isolated-fixture',
  credentialWrites: 'official diagnostic only on explicit retry',
  catalog: root,
}));
const port = Number(process.env.F322_QUOTA_ADAPTER_PORT ?? 3198);
if (!Number.isInteger(port) || port < 1024 || port > 65535 || [3001, 3002].includes(port))
  throw Error('Invalid fixture port');
await app.listen({ port, host: '127.0.0.1' });
console.log(`F322 quota adapter ${snapshot ? 'real opt-in' : 'isolated fixtures'} on ${port}`);
