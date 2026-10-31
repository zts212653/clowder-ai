import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { CodexAccountIdentity } from '@cat-cafe/shared';
import Fastify from 'fastify';
import { readAccountStoreSnapshot } from '../src/config/account-store-snapshot.js';
import { writeCatalogAccount } from '../src/config/catalog-accounts.js';
import { CodexLoginManager } from '../src/config/codex-login-manager.js';
import { describeCodexManagedLayout, prepareCodexManagedLayout } from '../src/config/codex-managed-layout.js';
import { accountsRoutes } from '../src/routes/accounts.js';

const identity = { userId: 'user-b', workspaceId: 'workspace-b' };
const settled = () => new Promise((resolve) => setImmediate(resolve));
function fixture(selectedDefault = false) {
  const saved = { ...process.env };
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'f320-unique-')));
  Object.assign(process.env, { HOME: root, CAT_CAFE_GLOBAL_CONFIG_ROOT: root, CAT_CAFE_DATA_DIR: join(root, 'data') });
  delete process.env.CODEX_HOME;
  if (selectedDefault) {
    const home = join(root, 'default-selected');
    mkdirSync(home);
    writeCatalogAccount(root, 'codex', { authType: 'oauth', clientId: 'openai', envVars: { CODEX_HOME: home } });
  }
  let finish!: (value: CodexAccountIdentity) => void;
  const manager = new CodexLoginManager({
    run(input) {
      return new Promise((resolve) => {
        finish = (value) => {
          mkdirSync(input.home, { recursive: true });
          const jwt = `x.${Buffer.from(
            JSON.stringify({
              'https://api.openai.com/auth': {
                chatgpt_user_id: value.userId,
                chatgpt_account_id: value.workspaceId,
              },
            }),
          ).toString('base64url')}.x`;
          writeFileSync(
            join(input.home, 'auth.json'),
            JSON.stringify({ tokens: { id_token: jwt, account_id: value.workspaceId } }),
          );
          resolve(value);
        };
      });
    },
  });
  function account(principal?: CodexAccountIdentity) {
    const ref = `codex-${randomUUID()}`;
    writeCatalogAccount(root, ref, {
      authType: 'oauth',
      clientId: 'openai',
      displayName: '已有账号',
      codex: {
        ...prepareCodexManagedLayout(describeCodexManagedLayout(root, ref)),
        ...(principal ? { identity: principal } : {}),
      },
    });
    return ref;
  }
  const ref = account();
  return {
    root,
    ref,
    manager,
    account,
    finish: (value = identity) => finish(value),
    async close() {
      await manager.close();
      process.env = saved;
      rmSync(root, { recursive: true, force: true });
    },
  };
}
test('duplicate review survives restart; explicit confirmation reuses existing account without copying auth', async () => {
  const f = fixture();
  try {
    const other = f.account(identity);
    const attempt = f.manager.start(f.root, f.ref);
    f.finish();
    await settled();
    assert.equal(f.manager.read(f.root, f.ref).codex.attempt?.duplicateAccountRef, other);
    const restarted = new CodexLoginManager();
    assert.equal(restarted.confirm(f.root, f.ref, attempt.id), other);
    const current = restarted.read(f.root, f.ref);
    assert.equal(current.codex.identity, undefined);
    assert.equal(current.codex.attempt?.state, 'reused');
    assert.equal(existsSync(join(current.codex.credentialHome, 'auth.json')), false);
    assert.equal(existsSync(join(restarted.read(f.root, other).codex.credentialHome, 'auth.json')), false);
  } finally {
    await f.close();
  }
});
test('confirmation rechecks a review that became duplicate after another adoption', async () => {
  const f = fixture();
  try {
    const original = { ...identity, userId: 'original-user' };
    const account = f.manager.read(f.root, f.ref);
    writeCatalogAccount(f.root, f.ref, { ...account, codex: { ...account.codex, identity: original } });
    const attempt = f.manager.start(f.root, f.ref);
    f.finish();
    await settled();
    const other = f.account(identity);
    const before = readFileSync(join(f.root, '.cat-cafe', 'accounts.json'), 'utf8');
    assert.throws(() => f.manager.createFromReview(f.root, f.ref, attempt.id), /duplicate_identity/);
    assert.equal(readFileSync(join(f.root, '.cat-cafe', 'accounts.json'), 'utf8'), before);
    assert.equal(f.manager.confirm(f.root, f.ref, attempt.id), other);
    assert.deepEqual(f.manager.read(f.root, f.ref).codex.identity, original);
  } finally {
    await f.close();
  }
});
test('persisted default identity is included from its selected home during completion', async () => {
  const f = fixture(true);
  try {
    const home = join(f.root, 'default-selected');
    const attempt = f.manager.start(f.root, f.ref);
    f.finish();
    // Native promise resolution has not yet run adoption; default now owns this principal.
    const stage = f.manager.read(f.root, f.ref).codex.attempt!.credentialHome;
    writeFileSync(join(home, 'auth.json'), readFileSync(join(stage, 'auth.json')));
    await settled();
    const current = f.manager.read(f.root, f.ref);
    assert.equal(current.codex.attempt?.state, 'review');
    assert.equal(current.codex.attempt?.duplicateAccountRef, 'codex');
    assert.equal(current.codex.identity, undefined);
    assert.equal(f.manager.confirm(f.root, f.ref, attempt.id), 'codex');
    assert.equal(existsSync(join(current.codex.credentialHome, 'auth.json')), false);
  } finally {
    await f.close();
  }
});
test('two persisted reviews converging on one principal can only create one adopted account', async () => {
  const f = fixture();
  try {
    const first = f.manager.read(f.root, f.ref);
    writeCatalogAccount(f.root, f.ref, {
      ...first,
      codex: { ...first.codex, identity: { ...identity, userId: 'old-a' } },
    });
    const a = f.manager.start(f.root, f.ref);
    f.finish();
    await settled();
    const other = f.account({ ...identity, userId: 'old-c' });
    const b = f.manager.start(f.root, other);
    f.finish();
    await settled();
    const adopted = new CodexLoginManager().createFromReview(f.root, f.ref, a.id, '正式账号 B');
    const restarted = new CodexLoginManager();
    assert.equal(restarted.read(f.root, other).codex.attempt?.duplicateAccountRef, adopted);
    assert.equal(restarted.confirm(f.root, other, b.id), adopted);
    assert.notEqual(other, adopted);
    assert.deepEqual(restarted.read(f.root, adopted).codex.identity, identity);
    assert.equal(existsSync(join(restarted.read(f.root, other).codex.credentialHome, 'auth.json')), false);
  } finally {
    await f.close();
  }
});

for (const unavailable of ['deleted', 'identity_changed'] as const) {
  test(`confirmed reuse becomes non-actionable after target is ${unavailable}, including restart`, async () => {
    const f = fixture();
    const app = Fastify();
    await app.register(accountsRoutes);
    try {
      const other = f.account(identity);
      const attempt = f.manager.start(f.root, f.ref);
      f.finish();
      await settled();
      const targetHome = f.manager.read(f.root, other).codex.credentialHome;
      const stageHome = f.manager.read(f.root, f.ref).codex.attempt!.credentialHome;
      writeFileSync(join(targetHome, 'auth.json'), readFileSync(join(stageHome, 'auth.json')));
      assert.equal(f.manager.confirm(f.root, f.ref, attempt.id), other);
      assert.equal(f.manager.read(f.root, f.ref).codex.attempt?.duplicateAccountRef, other);
      if (unavailable === 'deleted') {
        const response = await app.inject({
          method: 'DELETE',
          url: `/api/accounts/${other}`,
          headers: { 'x-cat-cafe-user': 'fixture' },
          payload: { projectPath: f.root },
        });
        assert.equal(response.statusCode, 200, response.body);
      } else rmSync(join(targetHome, 'auth.json'));
      const list = await app.inject({
        method: 'GET',
        url: `/api/accounts?projectPath=${encodeURIComponent(f.root)}`,
        headers: { 'x-cat-cafe-user': 'fixture' },
      });
      assert.equal(list.statusCode, 200, list.body);
      const projection = list.json().providers.find((item: { id: string }) => item.id === f.ref).codex.attempt;
      assert.equal(projection.state, 'reused');
      assert.equal(projection.duplicateAccountRef, undefined);
      assert.match(projection.error, /不可用/);
      assert.equal(new CodexLoginManager().read(f.root, f.ref).codex.attempt?.duplicateAccountRef, undefined);
      // Preserve historical fact without exposing it as an actionable binding destination.
      assert.equal(readAccountStoreSnapshot(f.root).resolve(f.ref).account?.codex?.attempt?.duplicateAccountRef, other);
    } finally {
      await app.close();
      await f.close();
    }
  });
}
