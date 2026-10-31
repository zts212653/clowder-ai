// Read-only pinned old source; every store/HOME/data access is temporary fake data.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import Fastify from 'fastify';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'f320-old-owner-')));
const oldRoot = join(root, 'old-source'),
  apiRoot = fileURLToPath(new URL('../../', import.meta.url));
let app: ReturnType<typeof Fastify> | undefined;
try {
  mkdirSync(oldRoot);
  // Extract only source/package metadata from the already-known commit, never runtime files.
  const archive = execFileSync(
    'git',
    ['archive', '054044ab0a3cc1b62b0155695e5fa010e2efabae', 'packages/api/src', 'packages/api/package.json'],
    { cwd: join(apiRoot, '../..'), maxBuffer: 64 * 1024 * 1024 },
  );
  execFileSync('tar', ['-x', '-C', oldRoot], { input: archive });
  symlinkSync(join(apiRoot, 'node_modules'), join(oldRoot, 'packages/api/node_modules'));
  symlinkSync(join(apiRoot, '../../node_modules'), join(oldRoot, 'node_modules'));
  const home = join(root, 'home');
  mkdirSync(home);
  mkdirSync(join(root, '.cat-cafe'));
  Object.assign(process.env, {
    HOME: home,
    CAT_CAFE_GLOBAL_CONFIG_ROOT: root,
    CAT_CAFE_CONFIG_ROOT: root,
    CAT_CAFE_DATA_DIR: join(root, 'data'),
    AUDIT_LOG_DIR: join(root, 'audit'),
    CAT_CAFE_PROJECT_ALLOWED_ROOTS: root,
  });
  for (const key of ['CODEX_HOME', 'CODEX_SQLITE_HOME', 'CAT_CAFE_RUNTIME_ROOT', 'CAT_CAFE_WORKSPACE_ROOT'])
    delete process.env[key];
  const ref = 'codex-00000000-0000-4000-8000-000000000001',
    file = join(root, '.cat-cafe/accounts.json');
  writeFileSync(
    file,
    JSON.stringify({
      codex: { authType: 'oauth', clientId: 'openai' },
      [ref]: {
        authType: 'oauth',
        clientId: 'openai',
        displayName: 'fake-managed',
        codex: {
          kind: 'managed',
          layoutVersion: 1,
          prepared: true,
          credentialHome: join(root, 'private-home'),
          stateRoot: join(home, '.codex'),
          sqliteHome: join(home, '.codex'),
        },
      },
    }),
  );
  const before = readFileSync(file, 'utf8');
  const { resolveByAccountRef, resolveForClient } = await import(
    pathToFileURL(join(oldRoot, 'packages/api/src/config/account-resolver.ts')).href
  );
  const { accountsRoutes } = await import(pathToFileURL(join(oldRoot, 'packages/api/src/routes/accounts.ts')).href);
  const profile = resolveByAccountRef(root, ref),
    defaultRef = resolveForClient(root, 'openai')?.id;
  const passiveReadPreservesBytes = readFileSync(file, 'utf8') === before;
  app = Fastify();
  await app.register(accountsRoutes);
  const response = await app.inject({
    method: 'PATCH',
    url: `/api/accounts/${ref}`,
    payload: { projectPath: root, displayName: 'fake-edited' },
    headers: { 'x-cat-cafe-user': 'fixture-owner' },
  });
  const after = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(response.statusCode, 200);
  assert.equal(profile.kind, 'builtin');
  assert.equal(profile.envVars, undefined);
  assert.equal(after[ref].codex, undefined);
  assert.equal(defaultRef, 'codex');
  assert.equal(passiveReadPreservesBytes, true);
  process.stdout.write(
    `OLD_RECEIPT:${JSON.stringify({ oldHead: '054044ab0a3cc1b62b0155695e5fa010e2efabae', fakeDataOnly: true, defaultRef, passiveReadPreservesBytes, oldProfile: profile, patchStatus: response.statusCode, codexBefore: true, codexAfter: false, nativeCalls: 0 })}\n`,
  );
} finally {
  await app?.close();
  rmSync(root, { recursive: true, force: true });
}
// Own fixture worker only: do not leave its logging worker keeping the probe alive.
process.exit(0);
