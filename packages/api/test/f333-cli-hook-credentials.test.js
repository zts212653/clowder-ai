import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { resolveModeFilePath } from '../../../.claude/hooks/f236-anchor-posttool.mjs';
import { originFromEnvironment } from '../../../scripts/lib/worktree-origin.mjs';
import { buildClaudeEnvOverrides } from '../dist/domains/cats/services/agents/providers/ClaudeAgentService.js';
import { buildChildEnv } from '../dist/utils/cli-spawn.js';

const hook = resolve('../../.claude/hooks/f24-compaction.mjs');
function run(args, env, input, executable = process.execPath) {
  return new Promise((done, reject) => {
    const child = spawn(executable, args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '',
      stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => done({ code, stdout, stderr }));
    child.stdin.end(JSON.stringify(input));
  });
}

for (const transport of ['shared', 'stdio']) {
  test(`${transport} real Claude launch env preserves anchor and worktree source without an inline secret`, () => {
    const env = buildChildEnv(
      buildClaudeEnvOverrides({
        CAT_CAFE_INVOCATION_ID: 'fixture-hook-A',
        CAT_CAFE_CALLBACK_TOKEN: 'fixture-private-hook-A',
        CAT_CAFE_THREAD_ID: 'thread_fixture_hooks',
        CAT_CAFE_MCP_TRANSPORT: transport,
        CAT_CAFE_CREDENTIAL_FILE: '/fixture/original-turn.json',
      }),
    );
    assert.equal(resolveModeFilePath(env), '/tmp/cat-cafe-anchor-mode-fixture-hook-A');
    assert.equal(originFromEnvironment(env).sourceRef, 'invocation:fixture-hook-A');
    assert.equal(env.CAT_CAFE_CALLBACK_TOKEN, undefined);
  });

  test(`${transport} installed compaction and bookmark carrier authenticates the original file, never refreshed B`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'f333-hook-'));
    const file = join(root, 'original-turn.json');
    const invocationId = `fixture-${randomUUID()}`;
    const sessionId = `fixture-${randomUUID()}`;
    const token = `fixture-private-${randomUUID()}`;
    writeFileSync(file, JSON.stringify({ invocationId, callbackToken: token }), { mode: 0o600 });
    const requests = [];
    const server = createServer(async (req, res) => {
      let body = '';
      for await (const chunk of req) body += chunk;
      requests.push({
        path: req.url,
        id: req.headers['x-invocation-id'],
        token: req.headers['x-callback-token'],
        carrier: req.headers['x-clowder-compaction-carrier'],
        legacyBearer: req.headers['x-cat-cafe-hook-token'],
        authorization: req.headers.authorization,
        body,
      });
      if (body.includes(`${sessionId}-redirect`)) {
        res.writeHead(302, { location: '/must-not-receive-callback-auth' });
        res.end();
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          skill: 'tdd',
          sopStage: 'development',
          contextEpoch: { status: 'observed' },
          postCompact: { status: 'projected', contextPacket: 'fixture cold packet' },
        }),
      );
    });
    await new Promise((done) => server.listen(0, '127.0.0.1', done));
    const port = server.address().port;
    const env = buildChildEnv(
      buildClaudeEnvOverrides({
        CAT_CAFE_INVOCATION_ID: invocationId,
        CAT_CAFE_CALLBACK_TOKEN: token,
        CAT_CAFE_CREDENTIAL_FILE: file,
        CAT_CAFE_MCP_TRANSPORT: transport,
        CAT_CAFE_API_URL: `http://127.0.0.1:${port}`,
        API_SERVER_PORT: String(port),
      }),
    );
    // A stale legacy environment must not replace original-turn file auth.
    env.CAT_CAFE_CALLBACK_TOKEN = 'stale';
    env.CAT_CAFE_HOOK_TOKEN = 'retired';
    try {
      for (const phase of ['pre', 'post', 'sop-set', 'sop-get', 'legacy-pre', 'legacy-digest']) {
        const result = await run([hook, phase], env, {
          session_id: sessionId,
          trigger: 'manual',
          skill: 'tdd',
          sopStage: 'development',
        });
        assert.equal(result.code, 0, `${phase}: ${result.stderr}`);
        assert.ok(!result.stdout.includes(token) && !result.stderr.includes(token));
      }
      assert.equal(requests.length, 6, 'file-only hook calls must not silently skip');
      for (const wrapper of ['sop-stage-bookmark.sh', 'f24-pre-compact.sh', 'f24-post-compact-bootstrap.sh']) {
        const result = await run(
          [resolve('../../.claude/hooks', wrapper)],
          env,
          {
            session_id: sessionId,
            trigger: 'manual',
            tool_input: { skill: 'tdd' },
          },
          '/bin/bash',
        );
        assert.equal(result.code, 0, `${wrapper}: ${result.stderr}`);
        assert.ok(!result.stdout.includes(token) && !result.stderr.includes(token));
        if (wrapper === 'f24-post-compact-bootstrap.sh') {
          assert.ok(
            result.stdout.includes('fixture cold packet'),
            'legacy bootstrap must recover the actual callback projection',
          );
          assert.ok(result.stdout.includes('stage: development'), 'bookmark callback must survive compaction');
        }
      }
      assert.equal(requests.length, 10, 'the shell entrypoints must also perform their original callback operations');
      assert.ok(requests.every((request) => request.id === invocationId && request.token === token));
      assert.ok(
        requests.every((request) => request.legacyBearer === undefined && request.authorization === undefined),
        'legacy global bearer headers must not accompany the invocation pair',
      );
      assert.ok(
        requests.every((request, index) => request.carrier === (index < 2 ? 'f296-node-v1' : undefined)),
        'only managed pre/post actions may attest compaction',
      );
      const redirected = await run([hook, 'pre'], env, { session_id: `${sessionId}-redirect` });
      assert.equal(redirected.code, 1, 'a callback redirect must not send original credentials to another destination');
      assert.equal(requests.length, 11, 'redirect response must not cause another authenticated request');
      writeFileSync(file, JSON.stringify({ invocationId: 'fixture-B', callbackToken: 'fixture-private-B' }));
      const late = await run([hook, 'pre'], env, { session_id: sessionId });
      assert.equal(late.code, 1, 'configured mismatched file must fail closed');
      assert.equal(requests.length, 11, 'A cannot send a request using B');
      writeFileSync(file, 'not-json');
      const corrupt = await run([hook, 'post'], env, { session_id: sessionId });
      assert.equal(corrupt.code, 1, 'configured invalid files cannot fall back to ambient credentials');
      rmSync(file);
      const removed = await run([hook, 'sop-get'], env, { session_id: sessionId });
      assert.equal(removed.code, 1, 'revoked file cannot silently skip a callback');
      assert.equal(requests.length, 11);
    } finally {
      server.closeAllConnections();
      await new Promise((done) => server.close(done));
      rmSync(root, { recursive: true, force: true });
      for (const name of [
        `cat-cafe-opus-compact-state-${sessionId}.json`,
        `cat-cafe-opus-recent-compact-${sessionId}.marker`,
        `cat-cafe-sop-stage-${sessionId}.json`,
      ]) {
        rmSync(join('/tmp', name), { force: true });
      }
    }
  });
}
