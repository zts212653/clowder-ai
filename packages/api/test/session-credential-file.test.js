import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import fsPromises from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { setImmediate as yieldToIo } from 'node:timers/promises';

const credsDir = mkdtempSync(join(tmpdir(), 'cat-cafe-provider-creds-'));
process.env.CAT_CAFE_MCP_CREDS_DIR = credsDir;

const { bindSessionCredentialFile, prepareSessionCredentialFile, resolveSessionCredentialFile } = await import(
  '../dist/domains/cats/services/agents/providers/session-credential-file.js'
);

after(() => {
  delete process.env.CAT_CAFE_MCP_CREDS_DIR;
  rmSync(credsDir, { recursive: true, force: true });
});

function callbackEnv(invocationId, callbackToken) {
  return {
    CAT_CAFE_THREAD_ID: 'thread-1',
    CAT_CAFE_CAT_ID: 'codex-sol',
    CAT_CAFE_INVOCATION_ID: invocationId,
    CAT_CAFE_CALLBACK_TOKEN: callbackToken,
  };
}

function readCreds(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

test('credential publication waits for slow filesystem work without blocking the API loop', async (t) => {
  const publishing = Promise.withResolvers();
  const release = Promise.withResolvers();
  const rename = fsPromises.rename;
  const mockedRename = t.mock.method(fsPromises, 'rename', async (source, destination) => {
    publishing.resolve();
    await release.promise;
    await rename(source, destination);
  });
  syncBuiltinESMExports();
  const input = callbackEnv('pending-publication', 'fixture-token');
  try {
    const pending = Promise.resolve(prepareSessionCredentialFile('codex', input));
    assert.equal(
      await Promise.race([publishing.promise.then(() => 'publishing'), pending.then(() => 'returned')]),
      'publishing',
    );
    await yieldToIo();
    assert.equal(mockedRename.mock.callCount(), 1);
    release.resolve();
    const prepared = await pending;
    assert.equal(readCreds(prepared.path).invocationId, 'pending-publication');
  } finally {
    release.resolve();
    mockedRename.mock.restore();
    syncBuiltinESMExports();
  }
});

test('provider namespaces cannot alias the same provider session id', async () => {
  const acp = await prepareSessionCredentialFile('acp', callbackEnv('acp-1', 'acp-token'));
  const codex = await prepareSessionCredentialFile('codex', callbackEnv('codex-1', 'codex-token'));
  assert.ok(acp);
  assert.ok(codex);
  bindSessionCredentialFile('acp', 'same-session-id', acp.path);
  bindSessionCredentialFile('codex', 'same-session-id', codex.path);

  const acpResume = await prepareSessionCredentialFile('acp', callbackEnv('acp-2', 'acp-token-2'), 'same-session-id');
  const codexResume = await prepareSessionCredentialFile(
    'codex',
    callbackEnv('codex-2', 'codex-token-2'),
    'same-session-id',
  );

  assert.equal(acpResume.path, acp.path);
  assert.equal(codexResume.path, codex.path);
  assert.notEqual(acpResume.path, codexResume.path);
  assert.equal(readCreds(acp.path).invocationId, 'acp-2');
  assert.equal(readCreds(codex.path).invocationId, 'codex-2');
});

test('credential files are owner-only and input env is never mutated', async () => {
  const input = callbackEnv('invocation-1', 'token-1');
  const prepared = await prepareSessionCredentialFile('codex', input);
  assert.ok(prepared);
  assert.equal(statSync(prepared.path).mode & 0o777, 0o600);
  assert.equal(prepared.env.CAT_CAFE_CREDENTIAL_FILE, prepared.path);
  assert.equal(input.CAT_CAFE_CREDENTIAL_FILE, undefined);
});

test('binding capacity is isolated per provider namespace', () => {
  const codex = resolveSessionCredentialFile('codex-capacity', callbackEnv('codex-capacity', 'token'));
  assert.ok(codex);
  bindSessionCredentialFile('codex-capacity', 'codex-session', codex.path);

  for (let index = 0; index <= 1_000; index++) {
    bindSessionCredentialFile('acp-capacity', `acp-session-${index}`, `/tmp/acp-credential-${index}.json`);
  }

  const resumed = resolveSessionCredentialFile(
    'codex-capacity',
    callbackEnv('codex-capacity-resume', 'token-2'),
    'codex-session',
  );
  assert.equal(resumed.path, codex.path, 'ACP churn must not evict an unrelated Codex session binding');
});
