// @ts-check
import assert from 'node:assert/strict';
import { execFileSync, execSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { createVignetteWriter, deriveSlug } from '../dist/domains/taste/services/writeVignette.js';

/** @returns {import('@cat-cafe/shared').TasteProposal} */
function makeProposal(overrides = {}) {
  return {
    id: 'proposal_abc123xyz',
    userId: 'user-1',
    catId: 'opus',
    threadId: 'thread-1',
    scene: 'operator said "太客服了" during review',
    quote: '太客服了，我要的是活人感',
    tags: ['活人感', 'authentic'],
    dimension: 'authentic-expression',
    privacy: 'public',
    status: 'approving',
    createdAt: 1720000000000,
    ...overrides,
  };
}

describe('writeVignette persistence boundary', () => {
  let workspaceDir;
  let originDir;

  beforeEach(() => {
    workspaceDir = join(tmpdir(), `vignette-persistence-test-${Date.now()}`);
    mkdirSync(workspaceDir, { recursive: true });
    execSync('git init -b main', { cwd: workspaceDir, stdio: 'pipe' });
    execSync('git config user.email "test@test.com"', { cwd: workspaceDir, stdio: 'pipe' });
    execSync('git config user.name "Test"', { cwd: workspaceDir, stdio: 'pipe' });
    writeFileSync(join(workspaceDir, 'README.md'), 'init');
    execSync('git add . && git commit -m "init"', { cwd: workspaceDir, stdio: 'pipe' });
    originDir = join(tmpdir(), `vignette-persistence-origin-${Date.now()}.git`);
    execFileSync('git', ['init', '--bare', '--initial-branch=main', originDir], { stdio: 'pipe' });
    execFileSync('git', ['remote', 'add', 'origin', originDir], { cwd: workspaceDir, stdio: 'pipe' });
    execFileSync('git', ['push', '-u', 'origin', 'main'], { cwd: workspaceDir, stdio: 'pipe' });
  });

  afterEach(() => {
    rmSync(workspaceDir, { recursive: true, force: true });
    rmSync(originDir, { recursive: true, force: true });
  });

  it('does not treat workspace environment roots as the canonical Taste locator', async () => {
    mkdirSync(join(workspaceDir, 'docs/taste'), { recursive: true });
    writeFileSync(join(workspaceDir, 'docs/taste/index.md'), '# Taste Index\n\n### 表达真实\n', 'utf8');
    execSync('git add docs/taste/index.md && git commit -m "add index"', {
      cwd: workspaceDir,
      stdio: 'pipe',
    });
    execFileSync('git', ['push', 'origin', 'main'], { cwd: workspaceDir, stdio: 'pipe' });

    const runtimeDir = join(tmpdir(), `vignette-runtime-test-${Date.now()}`);
    mkdirSync(runtimeDir, { recursive: true });
    execSync('git init -b runtime/main-sync', { cwd: runtimeDir, stdio: 'pipe' });
    const previousRuntimeRoot = process.env.CAT_CAFE_RUNTIME_ROOT;
    const previousWorkspaceRoot = process.env.CAT_CAFE_WORKSPACE_ROOT;
    process.env.CAT_CAFE_RUNTIME_ROOT = runtimeDir;
    process.env.CAT_CAFE_WORKSPACE_ROOT = runtimeDir;

    try {
      const writer = createVignetteWriter(workspaceDir);
      const proposal = makeProposal();
      const slug = deriveSlug(proposal);
      const result = await writer(proposal);

      assert.equal(result.path, `docs/taste/vignettes/${slug}.md`);
      assert.ok(!existsSync(join(workspaceDir, result.path)), 'primary workspace must not be mutated by publication');
      assert.ok(!existsSync(join(runtimeDir, result.path)), 'runtime checkout must not receive the vignette');
      assert.match(
        execFileSync('git', ['--git-dir', originDir, 'show', `main:${result.path}`], { encoding: 'utf8' }),
        /proposalId: proposal_abc123xyz/,
      );

      const sensitive = await writer(makeProposal({ id: 'proposal_sensitive_xyz', privacy: 'sensitive' }));
      assert.ok(sensitive.path.startsWith('private/taste/'));
      assert.ok(existsSync(join(workspaceDir, sensitive.path)), 'sensitive vignette should persist in the workspace');
      assert.ok(!existsSync(join(runtimeDir, sensitive.path)), 'sensitive vignette must not be stranded in runtime');
    } finally {
      if (previousRuntimeRoot === undefined) delete process.env.CAT_CAFE_RUNTIME_ROOT;
      else process.env.CAT_CAFE_RUNTIME_ROOT = previousRuntimeRoot;
      if (previousWorkspaceRoot === undefined) delete process.env.CAT_CAFE_WORKSPACE_ROOT;
      else process.env.CAT_CAFE_WORKSPACE_ROOT = previousWorkspaceRoot;
      rmSync(runtimeDir, { recursive: true, force: true });
    }
  });

  it('resolves the primary main worktree when runtime and workspace roots intentionally match', async () => {
    mkdirSync(join(workspaceDir, 'docs/taste'), { recursive: true });
    writeFileSync(join(workspaceDir, 'docs/taste/index.md'), '# Taste Index\n\n### 表达真实\n', 'utf8');
    execSync('git add docs/taste/index.md && git commit -m "add index"', {
      cwd: workspaceDir,
      stdio: 'pipe',
    });
    execFileSync('git', ['push', 'origin', 'main'], { cwd: workspaceDir, stdio: 'pipe' });

    const runtimeDir = join(tmpdir(), `vignette-runtime-worktree-test-${Date.now()}`);
    execFileSync('git', ['worktree', 'add', '-b', 'runtime/main-sync', runtimeDir], {
      cwd: workspaceDir,
      stdio: 'pipe',
    });
    const previousRuntimeRoot = process.env.CAT_CAFE_RUNTIME_ROOT;
    const previousWorkspaceRoot = process.env.CAT_CAFE_WORKSPACE_ROOT;
    process.env.CAT_CAFE_RUNTIME_ROOT = runtimeDir;
    process.env.CAT_CAFE_WORKSPACE_ROOT = runtimeDir;

    try {
      const proposal = makeProposal({ id: 'proposal_equal_roots_xyz' });
      const result = await createVignetteWriter(runtimeDir)(proposal);

      assert.ok(!existsSync(join(workspaceDir, result.path)), 'primary main worktree must remain operator-owned');
      assert.ok(!existsSync(join(runtimeDir, result.path)), 'runtime/main-sync must remain disposable');
      assert.match(
        execFileSync('git', ['--git-dir', originDir, 'show', `main:${result.path}`], { encoding: 'utf8' }),
        /proposalId: proposal_equal_roots_xyz/,
      );
      assert.equal(
        execSync('git branch --show-current', { cwd: workspaceDir, stdio: 'pipe' }).toString().trim(),
        'main',
      );
    } finally {
      if (previousRuntimeRoot === undefined) delete process.env.CAT_CAFE_RUNTIME_ROOT;
      else process.env.CAT_CAFE_RUNTIME_ROOT = previousRuntimeRoot;
      if (previousWorkspaceRoot === undefined) delete process.env.CAT_CAFE_WORKSPACE_ROOT;
      else process.env.CAT_CAFE_WORKSPACE_ROOT = previousWorkspaceRoot;
      execFileSync('git', ['worktree', 'remove', '--force', runtimeDir], { cwd: workspaceDir, stdio: 'pipe' });
    }
  });

  it('returns an already committed vignette on retry without another commit', async () => {
    mkdirSync(join(workspaceDir, 'docs/taste'), { recursive: true });
    writeFileSync(join(workspaceDir, 'docs/taste/index.md'), '# Taste Index\n\n### 表达真实\n', 'utf8');
    execSync('git add docs/taste/index.md && git commit -m "add index"', {
      cwd: workspaceDir,
      stdio: 'pipe',
    });
    execFileSync('git', ['push', 'origin', 'main'], { cwd: workspaceDir, stdio: 'pipe' });

    const writer = createVignetteWriter(workspaceDir);
    const first = await writer(makeProposal());
    const committedContent = execFileSync('git', ['--git-dir', originDir, 'show', `main:${first.path}`], {
      encoding: 'utf8',
    });
    const commitCountBefore = execFileSync('git', ['--git-dir', originDir, 'rev-list', '--count', 'main'], {
      encoding: 'utf8',
    }).trim();

    const retried = await writer(makeProposal());

    assert.deepEqual(retried, first);
    assert.equal(
      execFileSync('git', ['--git-dir', originDir, 'show', `main:${retried.path}`], { encoding: 'utf8' }),
      committedContent,
    );
    const commitCountAfter = execFileSync('git', ['--git-dir', originDir, 'rev-list', '--count', 'main'], {
      encoding: 'utf8',
    }).trim();
    assert.equal(commitCountAfter, commitCountBefore);
  });

  it('restores a pre-existing vignette when a replacement commit fails', async () => {
    const proposal = makeProposal();
    const vignettePath = join(workspaceDir, 'docs/taste/vignettes', `${deriveSlug(proposal)}.md`);
    const originalVignette = 'pre-existing canonical vignette\n';
    const originalIndex = '# Taste Index\n\n### 表达真实\n';
    mkdirSync(join(workspaceDir, 'docs/taste/vignettes'), { recursive: true });
    writeFileSync(vignettePath, originalVignette, 'utf8');
    writeFileSync(join(workspaceDir, 'docs/taste/index.md'), originalIndex, 'utf8');
    execSync('git add docs/taste && git commit -m "add existing vignette"', {
      cwd: workspaceDir,
      stdio: 'pipe',
    });
    execFileSync('git', ['push', 'origin', 'main'], { cwd: workspaceDir, stdio: 'pipe' });
    const hooksDir = join(workspaceDir, '.git/hooks');
    writeFileSync(join(hooksDir, 'pre-commit'), '#!/bin/sh\nexit 1\n');
    chmodSync(join(hooksDir, 'pre-commit'), 0o755);

    await assert.rejects(() => createVignetteWriter(workspaceDir)(proposal), /Vignette write failed/);

    assert.equal(readFileSync(vignettePath, 'utf8'), originalVignette);
    assert.equal(readFileSync(join(workspaceDir, 'docs/taste/index.md'), 'utf8'), originalIndex);
  });

  it('fails closed without changing a staged index output path', async () => {
    const proposal = makeProposal();
    const slug = deriveSlug(proposal);
    const indexPath = join(workspaceDir, 'docs/taste/index.md');
    const vignettePath = join(workspaceDir, 'docs/taste/vignettes', `${slug}.md`);
    const originalIndex = '# Taste Index\n\n### 表达真实\n';
    const stagedIndex = `${originalIndex}\nSTAGED INDEX MARKER\n`;
    mkdirSync(join(workspaceDir, 'docs/taste'), { recursive: true });
    writeFileSync(indexPath, originalIndex, 'utf8');
    execSync('git add docs/taste/index.md && git commit -m "add index"', {
      cwd: workspaceDir,
      stdio: 'pipe',
    });
    execFileSync('git', ['push', 'origin', 'main'], { cwd: workspaceDir, stdio: 'pipe' });
    writeFileSync(indexPath, stagedIndex, 'utf8');
    execSync('git add docs/taste/index.md', { cwd: workspaceDir, stdio: 'pipe' });
    const statusBefore = execSync(`git status --porcelain -- docs/taste/index.md docs/taste/vignettes/${slug}.md`, {
      cwd: workspaceDir,
      stdio: 'pipe',
    }).toString();
    const headBefore = execSync('git rev-parse HEAD', { cwd: workspaceDir, stdio: 'pipe' }).toString();

    await createVignetteWriter(workspaceDir)(proposal);

    assert.equal(readFileSync(indexPath, 'utf8'), stagedIndex, 'working-tree index bytes must be preserved');
    assert.equal(
      execSync('git show :docs/taste/index.md', { cwd: workspaceDir, stdio: 'pipe' }).toString(),
      stagedIndex,
      'staged index bytes must be preserved',
    );
    assert.ok(!existsSync(vignettePath), 'isolated publisher must not write the primary vignette path');
    assert.equal(
      execSync(`git status --porcelain -- docs/taste/index.md docs/taste/vignettes/${slug}.md`, {
        cwd: workspaceDir,
        stdio: 'pipe',
      }).toString(),
      statusBefore,
      'output-path staging state must be unchanged',
    );
    assert.equal(execSync('git rev-parse HEAD', { cwd: workspaceDir, stdio: 'pipe' }).toString(), headBefore);
  });

  it('fails closed without changing a staged vignette output path', async () => {
    const proposal = makeProposal();
    const slug = deriveSlug(proposal);
    const relativeVignettePath = `docs/taste/vignettes/${slug}.md`;
    const vignettePath = join(workspaceDir, relativeVignettePath);
    const indexPath = join(workspaceDir, 'docs/taste/index.md');
    const originalVignette = 'original vignette\n';
    const stagedVignette = 'STAGED VIGNETTE MARKER\n';
    const originalIndex = '# Taste Index\n\n### 表达真实\n';
    mkdirSync(join(workspaceDir, 'docs/taste/vignettes'), { recursive: true });
    writeFileSync(vignettePath, originalVignette, 'utf8');
    writeFileSync(indexPath, originalIndex, 'utf8');
    execSync('git add docs/taste && git commit -m "add existing outputs"', {
      cwd: workspaceDir,
      stdio: 'pipe',
    });
    execFileSync('git', ['push', 'origin', 'main'], { cwd: workspaceDir, stdio: 'pipe' });
    writeFileSync(vignettePath, stagedVignette, 'utf8');
    execSync(`git add ${relativeVignettePath}`, { cwd: workspaceDir, stdio: 'pipe' });
    const statusBefore = execSync(`git status --porcelain -- docs/taste/index.md ${relativeVignettePath}`, {
      cwd: workspaceDir,
      stdio: 'pipe',
    }).toString();
    const headBefore = execSync('git rev-parse HEAD', { cwd: workspaceDir, stdio: 'pipe' }).toString();

    await assert.rejects(() => createVignetteWriter(workspaceDir)(proposal), /Taste publication conflict/);

    assert.equal(readFileSync(vignettePath, 'utf8'), stagedVignette, 'working-tree vignette bytes must be preserved');
    assert.equal(
      execSync(`git show :${relativeVignettePath}`, { cwd: workspaceDir, stdio: 'pipe' }).toString(),
      stagedVignette,
      'staged vignette bytes must be preserved',
    );
    assert.equal(readFileSync(indexPath, 'utf8'), originalIndex, 'index bytes must remain unchanged');
    assert.equal(
      execSync(`git status --porcelain -- docs/taste/index.md ${relativeVignettePath}`, {
        cwd: workspaceDir,
        stdio: 'pipe',
      }).toString(),
      statusBefore,
      'output-path staging state must be unchanged',
    );
    assert.equal(execSync('git rev-parse HEAD', { cwd: workspaceDir, stdio: 'pipe' }).toString(), headBefore);
  });
});
