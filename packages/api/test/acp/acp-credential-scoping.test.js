/**
 * PR#1099 review P1 — session-scoped MCP credential files.
 *
 * The vuln: a deterministic <threadId>_<catId>.json path is overwritten by
 * each newer invocation. A superseded-but-alive ACP process re-reads the
 * shared file, picks up the newest invocation's credentials, and defeats the
 * registry.isLatest() stale guard.
 *
 * The fix: one file per ACP session (<threadId>_<catId>_<nonce>.json), nonce
 * decided before session/new, path injected into that session's MCP env.
 * Resume rewrites the SAME file (the #1092 refresh); other sessions' files
 * are never touched.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

const credsDir = mkdtempSync(join(tmpdir(), 'cat-cafe-acp-creds-'));
process.env.CAT_CAFE_MCP_CREDS_DIR = credsDir;

const { prepareSessionCredentialFile, bindSessionCredentialFile, refreshFrozenCredentialFile } = await import(
  '../../dist/domains/cats/services/agents/providers/acp/acp-credential-file.js'
);
const { AcpAgentService } = await import('../../dist/domains/cats/services/agents/providers/acp/AcpAgentService.js');

after(() => {
  delete process.env.CAT_CAFE_MCP_CREDS_DIR;
  rmSync(credsDir, { recursive: true, force: true });
});

function makeCallbackEnv({ threadId = 'th-1', catId = 'kimi', invocationId, callbackToken }) {
  return {
    CAT_CAFE_API_URL: 'http://127.0.0.1:1',
    CAT_CAFE_THREAD_ID: threadId,
    CAT_CAFE_CAT_ID: catId,
    CAT_CAFE_INVOCATION_ID: invocationId,
    CAT_CAFE_CALLBACK_TOKEN: callbackToken,
  };
}

function readCreds(path) {
  return JSON.parse(readFileSync(path, 'utf-8'));
}

describe('prepareSessionCredentialFile (unit)', () => {
  it('returns null when invocation credentials are missing', () => {
    assert.equal(prepareSessionCredentialFile(undefined), null);
    assert.equal(
      prepareSessionCredentialFile({ CAT_CAFE_THREAD_ID: 't', CAT_CAFE_CAT_ID: 'c' }),
      null,
      'no invocationId/token → nothing to protect',
    );
  });

  it('new session gets a nonce path and does not mutate the input env', () => {
    const callbackEnv = makeCallbackEnv({ threadId: 'th-unit', invocationId: 'inv-1', callbackToken: 'tok-1' });
    const prepared = prepareSessionCredentialFile(callbackEnv);
    assert.ok(prepared, 'creds present → file prepared');
    assert.match(
      prepared.path,
      /th-unit_kimi_[0-9a-f-]{36}\.json$/,
      'path must be nonce-scoped, not the shared <threadId>_<catId>.json',
    );
    assert.equal(prepared.env.CAT_CAFE_CREDENTIAL_FILE, prepared.path);
    assert.equal(callbackEnv.CAT_CAFE_CREDENTIAL_FILE, undefined, 'input env must not be mutated');
    assert.deepEqual(
      { invocationId: readCreds(prepared.path).invocationId, callbackToken: readCreds(prepared.path).callbackToken },
      { invocationId: 'inv-1', callbackToken: 'tok-1' },
    );
  });

  it('bound resume rewrites the SAME file with fresh credentials', () => {
    const first = prepareSessionCredentialFile(
      makeCallbackEnv({ threadId: 'th-resume', invocationId: 'inv-1', callbackToken: 'tok-1' }),
    );
    bindSessionCredentialFile('sess-r1', first.path);

    const second = prepareSessionCredentialFile(
      makeCallbackEnv({ threadId: 'th-resume', invocationId: 'inv-2', callbackToken: 'tok-2' }),
      'sess-r1',
    );
    assert.equal(second.path, first.path, 'resume must reuse the session-bound path (#1092 refresh)');
    assert.equal(readCreds(first.path).invocationId, 'inv-2', 'file must carry the fresh invocationId');
  });

  it('unknown resume target falls back to a fresh nonce path', () => {
    const prepared = prepareSessionCredentialFile(
      makeCallbackEnv({ threadId: 'th-unknown', invocationId: 'inv-1', callbackToken: 'tok-1' }),
      'sess-never-bound',
    );
    assert.ok(prepared);
    assert.match(prepared.path, /th-unknown_kimi_[0-9a-f-]{36}\.json$/);
  });

  it('P1 regression: a newer session never overwrites an older session file', () => {
    const older = prepareSessionCredentialFile(
      makeCallbackEnv({ threadId: 'th-vuln', invocationId: 'inv-old', callbackToken: 'tok-old' }),
    );
    bindSessionCredentialFile('sess-old', older.path);

    // Newer invocation, same (thread, cat), NEW session — the supersede scenario.
    const newer = prepareSessionCredentialFile(
      makeCallbackEnv({ threadId: 'th-vuln', invocationId: 'inv-new', callbackToken: 'tok-new' }),
    );
    assert.notEqual(newer.path, older.path, 'sessions must not share a credential file');
    assert.equal(
      readCreds(older.path).invocationId,
      'inv-old',
      "superseded session's file must NOT receive the newer invocation's credentials",
    );
  });

  it('refreshFrozenCredentialFile rewrites the spawn-frozen overlay path', () => {
    const frozenPath = join(credsDir, 'dsh-dsh.json');
    const first = refreshFrozenCredentialFile(
      makeCallbackEnv({ threadId: 'th-dsh', catId: 'dsh', invocationId: 'inv-1', callbackToken: 'tok-1' }),
      frozenPath,
    );
    assert.ok(first);
    assert.equal(first.path, frozenPath);
    const second = refreshFrozenCredentialFile(
      makeCallbackEnv({ threadId: 'th-dsh', catId: 'dsh', invocationId: 'inv-2', callbackToken: 'tok-2' }),
      frozenPath,
    );
    assert.equal(second.path, frozenPath);
    assert.equal(readCreds(frozenPath).invocationId, 'inv-2');
    assert.equal(readCreds(frozenPath).callbackToken, 'tok-2');
  });

  it('two nonce credential files stay isolated after a later invocation', () => {
    const olderPath = join(credsDir, 'dsh-old-nonce.json');
    const newerPath = join(credsDir, 'dsh-new-nonce.json');
    refreshFrozenCredentialFile(
      makeCallbackEnv({ threadId: 'th-bg', catId: 'dsh', invocationId: 'inv-old', callbackToken: 'tok-old' }),
      olderPath,
    );
    refreshFrozenCredentialFile(
      makeCallbackEnv({ threadId: 'th-bg', catId: 'dsh', invocationId: 'inv-new', callbackToken: 'tok-new' }),
      newerPath,
    );
    assert.equal(readCreds(olderPath).callbackToken, 'tok-old');
    assert.equal(readCreds(newerPath).callbackToken, 'tok-new');
  });
});

// ── Integration through AcpAgentService ──────────────────────

const TEST_POOL_KEY = { projectPath: '/tmp', providerProfile: 'test' };

function makeCapturingClient({ failLoad = false, zeroEventResume = false } = {}) {
  const client = {
    newSessions: [],
    loadSessions: [],
    prompts: [],
    nextSessionId: 'sess-1',
    async newSession(_cwd, mcpServers) {
      client.newSessions.push(mcpServers);
      return { sessionId: client.nextSessionId };
    },
    async loadSession(sessionId, _cwd, mcpServers) {
      client.loadSessions.push({ sessionId, mcpServers });
      if (failLoad) throw new Error('load failed');
      return { sessionId };
    },
    async setSessionConfigOption() {},
    cancelSession() {},
    async *promptStream(sessionId) {
      client.prompts.push(sessionId);
      if (zeroEventResume && sessionId === 'sess-1') return;
      yield {
        sessionId,
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'ok' } },
      };
    },
    onCapacity() {},
    offCapacity() {},
    clearRecentCapacitySignal() {},
    recentCapacitySignal: null,
  };
  return client;
}

function makeAdapter(client) {
  return new AcpAgentService({
    catId: 'kimi',
    pool: {
      async acquire(poolKey) {
        return { client, poolKey, release() {} };
      },
      rememberSession() {},
    },
    poolKey: TEST_POOL_KEY,
    projectRoot: '/tmp',
    providerName: 'kimi',
    modelName: 'kimi-acp',
    mcpServers: [{ name: 'cat-cafe-collab', command: 'node', args: [], env: [] }],
  });
}

function credentialPathFrom(mcpServers) {
  const server = mcpServers.find((s) => s.name === 'cat-cafe-collab');
  return server?.env.find((e) => e.name === 'CAT_CAFE_CREDENTIAL_FILE')?.value;
}

async function drain(iterable) {
  const out = [];
  for await (const msg of iterable) out.push(msg);
  return out;
}

describe('AcpAgentService session-scoped credential injection (integration)', () => {
  it('newSession → resume reuses one file; a second session gets its own', async () => {
    const client = makeCapturingClient();
    const adapter = makeAdapter(client);
    const threadId = 'th-int';

    // Invocation 1: fresh session sess-1
    await drain(
      adapter.invoke('hello', {
        callbackEnv: makeCallbackEnv({ threadId, invocationId: 'inv-1', callbackToken: 'tok-1' }),
      }),
    );
    const path1 = credentialPathFrom(client.newSessions[0]);
    assert.ok(path1, 'cat-cafe server env must carry CAT_CAFE_CREDENTIAL_FILE');
    assert.match(path1, /th-int_kimi_[0-9a-f-]{36}\.json$/, 'must be session-scoped, not <threadId>_<catId>.json');
    assert.equal(readCreds(path1).invocationId, 'inv-1');

    // Invocation 2: resumes sess-1 — same file, refreshed creds
    await drain(
      adapter.invoke('again', {
        sessionId: 'sess-1',
        callbackEnv: makeCallbackEnv({ threadId, invocationId: 'inv-2', callbackToken: 'tok-2' }),
      }),
    );
    assert.equal(client.loadSessions.length, 1);
    assert.equal(credentialPathFrom(client.loadSessions[0].mcpServers), path1, 'resume must reuse the bound path');
    assert.equal(readCreds(path1).invocationId, 'inv-2', 'resume must refresh the session file (#1092)');

    // Invocation 3: NEW session while sess-1's process could still be alive (supersede sim)
    client.nextSessionId = 'sess-2';
    await drain(
      adapter.invoke('newer', {
        callbackEnv: makeCallbackEnv({ threadId, invocationId: 'inv-3', callbackToken: 'tok-3' }),
      }),
    );
    const path2 = credentialPathFrom(client.newSessions[1]);
    assert.ok(path2);
    assert.notEqual(path2, path1, 'a new session must get its own credential file');
    assert.equal(
      readCreds(path1).invocationId,
      'inv-2',
      "P1 regression: sess-1's file must NOT see inv-3 — isLatest() guard stays intact",
    );
  });

  it('resume load failure falls back to a fresh session-scoped file', async () => {
    const firstClient = makeCapturingClient();
    const firstAdapter = makeAdapter(firstClient);
    const threadId = 'th-load-fail';

    await drain(
      firstAdapter.invoke('hello', {
        callbackEnv: makeCallbackEnv({ threadId, invocationId: 'inv-1', callbackToken: 'tok-1' }),
      }),
    );
    const path1 = credentialPathFrom(firstClient.newSessions[0]);
    assert.ok(path1);

    const failingClient = makeCapturingClient({ failLoad: true });
    failingClient.nextSessionId = 'sess-2';
    const adapter = makeAdapter(failingClient);
    await drain(
      adapter.invoke('fallback', {
        sessionId: 'sess-1',
        callbackEnv: makeCallbackEnv({ threadId, invocationId: 'inv-2', callbackToken: 'tok-2' }),
      }),
    );

    assert.equal(failingClient.loadSessions.length, 1);
    assert.equal(
      credentialPathFrom(failingClient.loadSessions[0].mcpServers),
      path1,
      'resume attempt should target the existing session file',
    );
    const fallbackPath = credentialPathFrom(failingClient.newSessions[0]);
    assert.ok(fallbackPath);
    assert.notEqual(fallbackPath, path1, 'fresh fallback session must not share the failed resume file');
    assert.equal(
      readCreds(path1).invocationId,
      'inv-1',
      "failed resume must not refresh the old session file with the new invocation's credentials",
    );
    assert.equal(readCreds(fallbackPath).invocationId, 'inv-2');
  });

  it('zero-event retry binds the fresh replacement session to its own file', async () => {
    const seedClient = makeCapturingClient();
    const seedAdapter = makeAdapter(seedClient);
    const threadId = 'th-zero-retry';

    await drain(
      seedAdapter.invoke('hello', {
        callbackEnv: makeCallbackEnv({ threadId, invocationId: 'inv-1', callbackToken: 'tok-1' }),
      }),
    );
    const path1 = credentialPathFrom(seedClient.newSessions[0]);
    assert.ok(path1);

    const retryClient = makeCapturingClient({ zeroEventResume: true });
    retryClient.nextSessionId = 'sess-2';
    const retryAdapter = makeAdapter(retryClient);
    await drain(
      retryAdapter.invoke('again', {
        sessionId: 'sess-1',
        callbackEnv: makeCallbackEnv({ threadId, invocationId: 'inv-2', callbackToken: 'tok-2' }),
      }),
    );

    assert.equal(retryClient.loadSessions.length, 1);
    assert.equal(credentialPathFrom(retryClient.loadSessions[0].mcpServers), path1);
    const retryPath = credentialPathFrom(retryClient.newSessions[0]);
    assert.ok(retryPath);
    assert.notEqual(retryPath, path1, 'fresh retry session must get a new nonce-scoped file');
    assert.equal(readCreds(path1).invocationId, 'inv-2', 'resume attempt still refreshes the old session file');
    assert.equal(readCreds(retryPath).invocationId, 'inv-2', 'replacement session gets current invocation creds');

    // Next invocation resumes the replacement session: only the replacement file refreshes.
    const followupClient = makeCapturingClient();
    const followupAdapter = makeAdapter(followupClient);
    await drain(
      followupAdapter.invoke('after retry', {
        sessionId: 'sess-2',
        callbackEnv: makeCallbackEnv({ threadId, invocationId: 'inv-3', callbackToken: 'tok-3' }),
      }),
    );
    assert.equal(credentialPathFrom(followupClient.loadSessions[0].mcpServers), retryPath);
    assert.equal(readCreds(retryPath).invocationId, 'inv-3');
    assert.equal(
      readCreds(path1).invocationId,
      'inv-2',
      "original dead session's file must not receive the replacement session's future credentials",
    );
  });

  it('invocation without callbackEnv still works (no file, env passthrough)', async () => {
    const client = makeCapturingClient();
    const adapter = makeAdapter(client);
    const messages = await drain(adapter.invoke('hello', {}));
    assert.equal(credentialPathFrom(client.newSessions[0]), undefined, 'no creds → no credential file injection');
    assert.equal(messages.at(-1).type, 'done');
  });
});
