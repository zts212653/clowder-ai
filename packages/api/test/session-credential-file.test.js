import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

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

test('provider namespaces cannot alias the same provider session id', () => {
  const acp = prepareSessionCredentialFile('acp', callbackEnv('acp-1', 'acp-token'));
  const codex = prepareSessionCredentialFile('codex', callbackEnv('codex-1', 'codex-token'));
  assert.ok(acp);
  assert.ok(codex);
  bindSessionCredentialFile('acp', 'same-session-id', acp.path);
  bindSessionCredentialFile('codex', 'same-session-id', codex.path);

  const acpResume = prepareSessionCredentialFile('acp', callbackEnv('acp-2', 'acp-token-2'), 'same-session-id');
  const codexResume = prepareSessionCredentialFile('codex', callbackEnv('codex-2', 'codex-token-2'), 'same-session-id');

  assert.equal(acpResume.path, acp.path);
  assert.equal(codexResume.path, codex.path);
  assert.notEqual(acpResume.path, codexResume.path);
  assert.equal(readCreds(acp.path).invocationId, 'acp-2');
  assert.equal(readCreds(codex.path).invocationId, 'codex-2');
});

test('credential files are owner-only and input env is never mutated', () => {
  const input = callbackEnv('invocation-1', 'token-1');
  const prepared = prepareSessionCredentialFile('codex', input);
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
