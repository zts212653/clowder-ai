import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { CodexAccountIdentity } from '@cat-cafe/shared';
import { deleteCatalogAccount, writeCatalogAccount } from '../src/config/catalog-accounts.js';
import type { CodexLoginDriver } from '../src/config/codex-login-driver.js';
import { CodexLoginManager } from '../src/config/codex-login-manager.js';
import { describeCodexManagedLayout, prepareCodexManagedLayout } from '../src/config/codex-managed-layout.js';

const identity: CodexAccountIdentity = { userId: 'user-b', workspaceId: 'workspace-b', email: 'b@example.test' };
function fixture(driverOverride?: CodexLoginDriver) {
  const saved = { ...process.env };
  const root = mkdtempSync(join(tmpdir(), 'f320-login-'));
  Object.assign(process.env, { HOME: root, CAT_CAFE_DATA_DIR: join(root, 'data'), CAT_CAFE_GLOBAL_CONFIG_ROOT: root });
  delete process.env.CODEX_HOME;
  const ref = `codex-${randomUUID()}`;
  writeCatalogAccount(root, ref, {
    authType: 'oauth',
    clientId: 'openai',
    displayName: '公司',
    codex: prepareCodexManagedLayout(describeCodexManagedLayout(root, ref)),
  });
  let finish!: (identity: CodexAccountIdentity) => void;
  const starts: Parameters<CodexLoginDriver['run']>[0][] = [];
  const driver: CodexLoginDriver = {
    run(input) {
      starts.push(input);
      input.onReady();
      return new Promise((resolve) => {
        finish = (value) => {
          mkdirSync(input.home, { recursive: true, mode: 0o700 });
          const token = `x.${Buffer.from(JSON.stringify({ email: value.email, 'https://api.openai.com/auth': { chatgpt_user_id: value.userId, chatgpt_account_id: value.workspaceId } })).toString('base64url')}.x`;
          writeFileSync(
            join(input.home, 'auth.json'),
            JSON.stringify({ tokens: { account_id: value.workspaceId, id_token: token } }),
            { mode: 0o600 },
          );
          resolve(value);
        };
      });
    },
  };
  const manager = new CodexLoginManager(driverOverride ?? driver);
  return {
    root,
    ref,
    manager,
    starts,
    finish: (value = identity) => finish(value),
    close: () => {
      manager.close();
      process.env = saved;
      rmSync(root, { recursive: true, force: true });
    },
  };
}
const settled = () => new Promise((resolve) => setImmediate(resolve));
for (const code of ['codex_cli_unavailable', 'EACCES']) {
  test(`failure before terminal opens gives a usable recovery hint (${code})`, async () => {
    const f = fixture({
      async run() {
        throw new Error(code);
      },
    });
    try {
      f.manager.start(f.root, f.ref);
      await settled();
      const attempt = f.manager.read(f.root, f.ref).codex.attempt;
      assert.equal(attempt?.state, 'failed');
      assert.match(attempt?.error ?? '', /重试/);
      assert.doesNotMatch(attempt?.error ?? '', /终端输出/);
    } finally {
      f.close();
    }
  });
}
test('terminal-output guidance depends on readiness of this attempt, including retries', async () => {
  let calls = 0;
  const f = fixture({
    async run(input) {
      if (++calls === 1) input.onReady();
      throw new Error('codex_login_failed');
    },
  });
  try {
    f.manager.start(f.root, f.ref);
    await settled();
    assert.match(f.manager.read(f.root, f.ref).codex.attempt?.error ?? '', /终端输出/);
    f.manager.start(f.root, f.ref);
    await settled();
    assert.equal(f.manager.read(f.root, f.ref).codex.attempt?.state, 'failed');
    assert.doesNotMatch(f.manager.read(f.root, f.ref).codex.attempt?.error ?? '', /终端输出/);
  } finally {
    f.close();
  }
});
test('native completion adopts fresh credentials only for current attempt and preserves note', async () => {
  const f = fixture();
  try {
    f.manager.start(f.root, f.ref);
    assert.equal(f.manager.read(f.root, f.ref).codex.attempt?.state, 'waiting');
    f.finish();
    await settled();
    const account = f.manager.read(f.root, f.ref);
    assert.equal(account.displayName, '公司');
    assert.equal(account.codex.attempt?.state, 'success');
    assert.deepEqual(account.codex.identity, identity);
    assert.ok(existsSync(join(account.codex.credentialHome, 'auth.json')));
  } finally {
    f.close();
  }
});
test('late completion after cancellation cannot adopt auth or resurrect attempt', async () => {
  const f = fixture();
  try {
    const attempt = f.manager.start(f.root, f.ref);
    f.manager.cancel(f.root, f.ref, attempt.id);
    f.finish();
    await settled();
    const account = f.manager.read(f.root, f.ref);
    assert.equal(account.codex.attempt?.state, 'canceled');
    assert.equal(account.codex.identity, undefined);
    assert.equal(existsSync(join(account.codex.credentialHome, 'auth.json')), false);
  } finally {
    f.close();
  }
});
test('restart persists interrupted attempt; old owner callback is ignored', async () => {
  const f = fixture();
  try {
    f.manager.start(f.root, f.ref);
    const old = f.manager.read(f.root, f.ref);
    writeCatalogAccount(f.root, f.ref, {
      ...old,
      codex: {
        ...old.codex,
        attempt: { ...old.codex.attempt!, ownerPid: 2147483647, ownerStartedAt: 'terminated-fixture' },
      },
    });
    const restarted = new CodexLoginManager();
    assert.equal(restarted.read(f.root, f.ref).codex.attempt?.state, 'interrupted');
    f.finish();
    await settled();
    assert.equal(restarted.read(f.root, f.ref).codex.identity, undefined);
  } finally {
    f.close();
  }
});
test('different official identity requires review and cannot overwrite original account', async () => {
  const f = fixture();
  try {
    f.manager.start(f.root, f.ref);
    f.finish();
    await settled();
    const attempt = f.manager.start(f.root, f.ref);
    f.finish({ userId: 'user-c', workspaceId: 'workspace-c' });
    await settled();
    const account = f.manager.read(f.root, f.ref);
    assert.equal(account.codex.attempt?.state, 'review');
    assert.deepEqual(account.codex.identity, identity);
    assert.throws(() => f.manager.confirm(f.root, f.ref, attempt.id), /different_identity/);
  } finally {
    f.close();
  }
});

test('another live API boot cannot interrupt or steal a running login', async () => {
  const f = fixture();
  try {
    const attempt = f.manager.start(f.root, f.ref);
    const other = new CodexLoginManager();
    assert.equal(other.read(f.root, f.ref).codex.attempt?.state, 'waiting');
    assert.throws(() => other.start(f.root, f.ref), /owned_by_live_service/);
    assert.throws(() => other.cancel(f.root, f.ref, attempt.id), /owned_by_live_service/);
    f.finish();
    await settled();
    assert.equal(f.manager.read(f.root, f.ref).codex.attempt?.state, 'success');
  } finally {
    f.close();
  }
});

test('a persisted review can be canceled after its native wire has finished on another boot', async () => {
  const f = fixture();
  try {
    f.manager.start(f.root, f.ref);
    f.finish();
    await settled();
    const attempt = f.manager.start(f.root, f.ref);
    f.finish({ userId: 'user-c', workspaceId: 'workspace-c' });
    await settled();
    const restarted = new CodexLoginManager();
    restarted.cancel(f.root, f.ref, attempt.id);
    assert.equal(restarted.read(f.root, f.ref).codex.attempt?.state, 'canceled');
    assert.deepEqual(restarted.read(f.root, f.ref).codex.identity, identity);
  } finally {
    f.close();
  }
});

test('an unavailable original process birth never proves that a live owner died', async () => {
  const f = fixture();
  try {
    const attempt = f.manager.start(f.root, f.ref);
    const current = f.manager.read(f.root, f.ref);
    writeCatalogAccount(f.root, f.ref, {
      ...current,
      codex: { ...current.codex, attempt: { ...attempt, state: 'waiting', ownerStartedAt: 'unavailable' } },
    });
    const other = new CodexLoginManager();
    assert.equal(other.read(f.root, f.ref).codex.attempt?.state, 'waiting');
    assert.throws(() => other.start(f.root, f.ref), /owned_by_live_service/);
    f.finish();
    await settled();
  } finally {
    f.close();
  }
});

test('a deleted queued account is skipped without interrupting the completed login', async () => {
  const f = fixture();
  try {
    f.manager.start(f.root, f.ref);
    const queuedRef = `codex-${randomUUID()}`;
    writeCatalogAccount(f.root, queuedRef, {
      authType: 'oauth',
      clientId: 'openai',
      displayName: '待登录',
      codex: prepareCodexManagedLayout(describeCodexManagedLayout(f.root, queuedRef)),
    });
    f.manager.start(f.root, queuedRef);
    deleteCatalogAccount(f.root, queuedRef);
    f.finish();
    await settled();
    assert.equal(f.manager.read(f.root, f.ref).codex.attempt?.state, 'success');
    assert.equal(f.starts.length, 1);
  } finally {
    f.close();
  }
});
