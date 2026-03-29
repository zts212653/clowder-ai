/**
 * Test 2: invoke-single-cat shared-state preflight behavior
 *
 * Covers:
 * - unpushedFiles → invocation_created → ⚠️ system_info → service.invoke IS called
 * - uncommittedFiles → invocation_created → ⚠️ system_info → service.invoke IS called
 * - clean → no preflight messages, service called normally
 *
 * Strategy: uses real temp git repos + process.chdir() so that
 * findMonorepoRoot(process.cwd()) resolves to a controlled repo.
 * No mocking of native modules needed.
 */
import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

let invokeSingleCat;
const tempDirs = [];
let originalCwd;
let originalPreflightDisable;

async function collect(iterable) {
  const msgs = [];
  for await (const msg of iterable) msgs.push(msg);
  return msgs;
}

function makeDeps() {
  let counter = 0;
  return {
    registry: {
      create: () => ({ invocationId: `inv-${++counter}`, callbackToken: `tok-${counter}` }),
      verify: () => null,
    },
    sessionManager: {
      get: async () => undefined,
      getOrCreate: async () => ({}),
      store: async () => {},
      delete: async () => {},
      resolveWorkingDirectory: () => '/tmp/test',
    },
    threadStore: null,
    apiUrl: 'http://127.0.0.1:3004',
  };
}

/** Create a temp git repo with pnpm-workspace.yaml so findMonorepoRoot finds it. */
function createTestRepo(name) {
  const dir = mkdtempSync(join(tmpdir(), `ss-invoke-${name}-`));
  execSync('git init -b main', { cwd: dir, stdio: 'ignore' });
  execSync('git config user.email "test@test.com"', { cwd: dir, stdio: 'ignore' });
  execSync('git config user.name "test"', { cwd: dir, stdio: 'ignore' });
  // pnpm-workspace.yaml so findMonorepoRoot resolves here
  writeFileSync(join(dir, 'pnpm-workspace.yaml'), 'packages:\n  - packages/*\n');
  writeFileSync(join(dir, 'README.md'), '# test');
  execSync('git add -A && git commit -m "init"', { cwd: dir, stdio: 'ignore' });
  return dir;
}

function addBareRemote(repoDir) {
  const bare = mkdtempSync(join(tmpdir(), 'ss-invoke-bare-'));
  execSync('git init --bare -b main', { cwd: bare, stdio: 'ignore' });
  execSync(`git remote add origin ${bare}`, { cwd: repoDir, stdio: 'ignore' });
  execSync('git push -u origin main', { cwd: repoDir, stdio: 'ignore' });
  return bare;
}

describe('invokeSingleCat shared-state preflight', () => {
  before(async () => {
    originalCwd = process.cwd();
    originalPreflightDisable = process.env.CAT_CAFE_DISABLE_SHARED_STATE_PREFLIGHT;
    delete process.env.CAT_CAFE_DISABLE_SHARED_STATE_PREFLIGHT;
    const auditDir = mkdtempSync(join(tmpdir(), 'cat-audit-'));
    tempDirs.push(auditDir);
    process.env.AUDIT_LOG_DIR = auditDir;
    const mod = await import('../dist/domains/cats/services/agents/invocation/invoke-single-cat.js');
    invokeSingleCat = mod.invokeSingleCat;
  });

  after(() => {
    process.chdir(originalCwd);
    if (originalPreflightDisable === undefined) {
      delete process.env.CAT_CAFE_DISABLE_SHARED_STATE_PREFLIGHT;
    } else {
      process.env.CAT_CAFE_DISABLE_SHARED_STATE_PREFLIGHT = originalPreflightDisable;
    }
    for (const dir of tempDirs) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
    }
  });

  it('warn-only: unpushedFiles → invocation_created → ⚠️ → service.invoke called', async () => {
    const repo = createTestRepo('unpushed');
    const bare = addBareRemote(repo);
    tempDirs.push(repo, bare);

    // Commit shared-state file but don't push
    mkdirSync(join(repo, 'docs'), { recursive: true });
    writeFileSync(join(repo, 'docs/ROADMAP.md'), '# Backlog');
    execSync('git add docs/ROADMAP.md && git commit -m "add backlog"', { cwd: repo, stdio: 'ignore' });

    // chdir so findMonorepoRoot(process.cwd()) resolves to this repo
    process.chdir(repo);

    let serviceCalled = false;
    const stubService = {
      async *invoke() {
        serviceCalled = true;
        yield { type: 'text', catId: 'codex', content: 'hello', timestamp: Date.now() };
        yield { type: 'done', catId: 'codex', timestamp: Date.now() };
      },
    };

    const msgs = await collect(
      invokeSingleCat(makeDeps(), {
        catId: 'codex',
        service: stubService,
        prompt: 'test preflight unpushed warn',
        userId: 'user1',
        threadId: 'thread-preflight-block',
        isLastCat: true,
      }),
    );

    // Restore cwd
    process.chdir(originalCwd);

    // 砚砚 钉子 1: sequence must include invocation_created before ⚠️, then provider output
    const types = msgs.map((m) => m.type);
    assert.ok(types.includes('system_info'), 'should have system_info messages');
    assert.ok(types.includes('done'), 'should end with done');

    // Find the invocation_created message
    const invCreated = msgs.find((m) => {
      if (m.type !== 'system_info' || !m.content) return false;
      try {
        return JSON.parse(m.content).type === 'invocation_created';
      } catch {
        return false;
      }
    });
    assert.ok(invCreated, 'should have invocation_created');

    // Find the ⚠️ preflight message
    const warned = msgs.find((m) => m.type === 'system_info' && m.content?.includes('⚠️'));
    assert.ok(warned, 'should have ⚠️ warning message');
    assert.ok(warned.content.includes('docs/ROADMAP.md'), 'warning should name the file');
    assert.ok(warned.content.includes('git push'), 'warning should tell user to push');

    // Verify order: invocation_created before ⚠️ before provider text
    const invCreatedIdx = msgs.indexOf(invCreated);
    const warnedIdx = msgs.indexOf(warned);
    const textIdx = msgs.findIndex((m) => m.type === 'text' && m.content?.includes('hello'));
    assert.ok(invCreatedIdx < warnedIdx, 'invocation_created must come before ⚠️');
    assert.ok(warnedIdx < textIdx, '⚠️ must come before provider output');

    // Service SHOULD have been called
    assert.equal(serviceCalled, true, 'service.invoke MUST be called when shared-state is only warned');
  });

  it('warn-only: uncommittedFiles → invocation_created → ⚠️ → service.invoke called', async () => {
    const repo = createTestRepo('uncommitted');
    const bare = addBareRemote(repo);
    tempDirs.push(repo, bare);

    // Stage cat-template.json but don't commit — git diff --cached catches this
    writeFileSync(join(repo, 'cat-template.json'), '{}');
    execSync('git add cat-template.json', { cwd: repo, stdio: 'ignore' });

    process.chdir(repo);

    let serviceCalled = false;
    const stubService = {
      async *invoke() {
        serviceCalled = true;
        yield { type: 'text', catId: 'codex', content: 'hello from service', timestamp: Date.now() };
        yield { type: 'done', catId: 'codex', timestamp: Date.now() };
      },
    };

    const msgs = await collect(
      invokeSingleCat(makeDeps(), {
        catId: 'codex',
        service: stubService,
        prompt: 'test preflight warn',
        userId: 'user1',
        threadId: 'thread-preflight-warn',
        isLastCat: true,
      }),
    );

    process.chdir(originalCwd);

    // 砚砚 钉子 2: invocation_created comes first, then ⚠️, then provider output
    const invCreated = msgs.find((m) => {
      if (m.type !== 'system_info' || !m.content) return false;
      try {
        return JSON.parse(m.content).type === 'invocation_created';
      } catch {
        return false;
      }
    });
    assert.ok(invCreated, 'should have invocation_created');

    const warned = msgs.find((m) => m.type === 'system_info' && m.content?.includes('⚠️'));
    assert.ok(warned, 'should have ⚠️ warning message');
    assert.ok(warned.content.includes('cat-template.json'), 'warning should name the file');

    // Service SHOULD have been called
    assert.equal(serviceCalled, true, 'service.invoke MUST be called when preflight only warns');

    // Should have text output from service
    const textMsg = msgs.find((m) => m.type === 'text' && m.content?.includes('hello from service'));
    assert.ok(textMsg, 'service output should be present in yielded messages');
  });

  it('clean: no preflight messages when everything is ok', async () => {
    const repo = createTestRepo('clean');
    const bare = addBareRemote(repo);
    tempDirs.push(repo, bare);

    // Everything pushed, nothing dirty
    process.chdir(repo);

    let serviceCalled = false;
    const stubService = {
      async *invoke() {
        serviceCalled = true;
        yield { type: 'text', catId: 'codex', content: 'clean run', timestamp: Date.now() };
        yield { type: 'done', catId: 'codex', timestamp: Date.now() };
      },
    };

    const msgs = await collect(
      invokeSingleCat(makeDeps(), {
        catId: 'codex',
        service: stubService,
        prompt: 'test preflight clean',
        userId: 'user1',
        threadId: 'thread-preflight-clean',
        isLastCat: true,
      }),
    );

    process.chdir(originalCwd);

    // No 🚫 or ⚠️ messages
    const preflight = msgs.filter(
      (m) => m.type === 'system_info' && (m.content?.includes('🚫') || m.content?.includes('⚠️')),
    );
    assert.equal(preflight.length, 0, 'should have no preflight messages when clean');

    assert.equal(serviceCalled, true, 'service.invoke should be called');
  });
});
