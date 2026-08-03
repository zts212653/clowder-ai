import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import { resolveWorktreeIdByPath } from '../../dist/domains/workspace/workspace-security.js';
import { evalHubRoutes } from '../../dist/routes/eval-hub.js';

const repoHarnessFeedbackRoot = fileURLToPath(new URL('../../../../docs/harness-feedback', import.meta.url));

function buildApp(harnessFeedbackRoot) {
  const app = Fastify({ logger: false });
  app.addHook('preHandler', async (request) => {
    const userId = request.headers['x-test-user-id'];
    if (typeof userId === 'string') {
      request.sessionUserId = userId;
    }
  });
  app.register(evalHubRoutes, { harnessFeedbackRoot });
  return app;
}

function seedDuplicateBasenameWorktreeHarness() {
  const tempRoot = mkdtempSync(join(tmpdir(), 'f248-route-worktreeid-'));
  const mainRoot = resolve(tempRoot, 'primary', 'cat-cafe');
  const twinRoot = resolve(tempRoot, 'secondary', 'cat-cafe');
  mkdirSync(mainRoot, { recursive: true });
  execFileSync('git', ['init', '-b', 'main'], { cwd: mainRoot, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'F248 Test'], { cwd: mainRoot, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'f248@example.com'], { cwd: mainRoot, stdio: 'ignore' });
  mkdirSync(join(mainRoot, 'seed'), { recursive: true });
  execFileSync('git', ['add', '.'], { cwd: mainRoot, stdio: 'ignore' });
  execFileSync('git', ['commit', '--allow-empty', '-m', 'seed'], { cwd: mainRoot, stdio: 'ignore' });
  execFileSync('git', ['worktree', 'add', twinRoot, '-b', 'feat/twin'], { cwd: mainRoot, stdio: 'ignore' });

  const harnessFeedbackRoot = join(twinRoot, 'docs', 'harness-feedback');
  cpSync(repoHarnessFeedbackRoot, harnessFeedbackRoot, { recursive: true });
  return { harnessFeedbackRoot, repoProjectPath: twinRoot };
}

describe('Eval Hub API route — F248 Phase C worktree id normalization', () => {
  it('returns the de-duplicated repoWorktreeId for duplicate-basename worktrees', async () => {
    const fixture = seedDuplicateBasenameWorktreeHarness();
    const app = buildApp(fixture.harnessFeedbackRoot);

    const response = await app.inject({
      method: 'GET',
      url: '/api/eval-hub/summary',
      headers: { 'x-test-user-id': 'you' },
    });

    assert.equal(response.statusCode, 200);
    const body = response.json();
    const expectedWorktreeId = await resolveWorktreeIdByPath(fixture.repoProjectPath, fixture.repoProjectPath);
    assert.equal(body.repoProjectPath, fixture.repoProjectPath);
    assert.equal(body.repoWorktreeId, expectedWorktreeId);
    await app.close();
  });
});
