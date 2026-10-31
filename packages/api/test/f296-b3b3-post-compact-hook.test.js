import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { readFile, unlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

test('F296 B3b-3 hook injects only the API-selected cold packet, never the raw digest', async () => {
  const sessionId = `f296-b3b3-${process.pid}-${Date.now()}`;
  const statePath = `/tmp/cat-cafe-opus-compact-state-${sessionId}.json`;
  const requests = [];
  const api = createServer((request, response) => {
    requests.push({ path: request.url, method: request.method, headers: request.headers });
    response.setHeader('content-type', 'application/json');
    if (request.url === `/api/sessions/latest-digest?cliSessionId=${sessionId}`) {
      response.end(
        JSON.stringify({
          digest: { secretHistory: 'RAW-DIGEST-MUST-NOT-ENTER-PROMPT' },
          postCompact: {
            status: 'projected',
            contextPacket: '[Context Continuity]\n{"contextMode":"cold"}\nTRUSTED-UNREAD-TAIL',
          },
        }),
      );
    } else {
      response.writeHead(404).end('{}');
    }
  });
  api.listen(0, '127.0.0.1');
  await once(api, 'listening');
  await writeFile(
    statePath,
    JSON.stringify({
      sessionId,
      trigger: 'auto',
      compactedAt: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
      sealStatus: 'ok',
    }),
  );

  try {
    // Exercise the actual Node carrier. A fake curl no longer intercepts its
    // callback, and a synchronous child would starve this fixture HTTP server.
    const pending = promisify(execFile)('bash', [join(REPO_ROOT, '.claude/hooks/f24-post-compact-bootstrap.sh')], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      timeout: 15_000,
      env: {
        ...process.env,
        CAT_CAFE_CREDENTIAL_FILE: '',
        CAT_CAFE_API_URL: `http://127.0.0.1:${api.address().port}`,
        CAT_CAFE_INVOCATION_ID: 'fixture-invocation',
        CAT_CAFE_CALLBACK_TOKEN: 'fixture-callback-token',
      },
    });
    pending.child.stdin.end(JSON.stringify({ session_id: sessionId }));
    const result = await pending;
    assert.deepEqual(
      requests.map(({ path, method }) => ({ path, method })),
      ['latest-digest', 'sop-bookmark'].map((endpoint) => ({
        path: `/api/sessions/${endpoint}?cliSessionId=${sessionId}`,
        method: 'GET',
      })),
    );
    for (const { headers } of requests) {
      assert.equal(headers['x-invocation-id'], 'fixture-invocation');
      assert.equal(headers['x-callback-token'], 'fixture-callback-token');
      assert.equal(headers['x-clowder-compaction-carrier'], undefined, 'legacy recovery cannot attest a managed hook');
    }
    const hookOutput = JSON.parse(result.stdout);
    const additionalContext = hookOutput.hookSpecificOutput.additionalContext;
    assert.match(additionalContext, /F296 Trusted Cold Packet/);
    assert.match(additionalContext, /TRUSTED-UNREAD-TAIL/);
    assert.doesNotMatch(additionalContext, /RAW-DIGEST-MUST-NOT-ENTER-PROMPT/);
    assert.doesNotMatch(additionalContext, /Latest Sealed Session Digest/);
    // Recovery must not reintroduce an obsolete parallel authority after compaction.
    assert.doesNotMatch(additionalContext, /布偶猫|All work in this session is YOUR work/);
    assert.doesNotMatch(additionalContext, /explicit user instruction in THIS conversation turn/);
    assert.doesNotMatch(additionalContext, /subagent_type|SUBAGENT COST|Magic Word = 持久偏好信号/);
    assert.match(additionalContext, /current native L0/);
    // F231's recovery-boundary activation survives; the current semantic router owns destinations.
    assert.match(additionalContext, /Post-Compact Signal Check/);
    assert.match(additionalContext, /pre-compact user signals/);
    assert.match(additionalContext, /personal\/relationship facts/);
    assert.match(additionalContext, /reusable taste/);
    assert.match(additionalContext, /repeated tool\/workflow friction/);
    assert.match(additionalContext, /proactive-memory-judgment/);
    assert.match(additionalContext, /profile, taste, harness, or no action/);
    assert.doesNotMatch(additionalContext, /cat_cafe_propose_profile_update/);
    assert.match(additionalContext, /Pre-Compact State Snapshot/);
    assert.match(additionalContext, /F073 SOP STAGE RECOVERY/);
    await assert.rejects(readFile(statePath), { code: 'ENOENT' });
  } finally {
    await unlink(statePath).catch(() => {});
    api.closeAllConnections();
    await new Promise((resolve, reject) => api.close((error) => (error ? reject(error) : resolve())));
  }
});

for (const condition of ['missing', 'expired']) {
  test(`F324 recovery remains silent for ${condition} snapshots`, async () => {
    const sessionId = `f324-${condition}-${process.pid}-${Date.now()}`;
    const statePath = `/tmp/cat-cafe-opus-compact-state-${sessionId}.json`;
    if (condition === 'expired') {
      await writeFile(
        statePath,
        JSON.stringify({
          sessionId,
          compactedAt: new Date(Date.now() - 31 * 60_000).toISOString().replace(/\.\d{3}Z$/, 'Z'),
        }),
      );
    }
    try {
      const result = spawnSync('bash', [join(REPO_ROOT, '.claude/hooks/f24-post-compact-bootstrap.sh')], {
        cwd: REPO_ROOT,
        input: JSON.stringify({ session_id: sessionId }),
        encoding: 'utf8',
      });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, '');
      await assert.rejects(readFile(statePath), { code: 'ENOENT' });
    } finally {
      await unlink(statePath).catch(() => {});
    }
  });
}
