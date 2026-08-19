// @ts-check
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import {
  createVignetteWriter,
  deriveSlug,
  formatVignette,
  insertIntoIndex,
} from '../dist/domains/taste/services/writeVignette.js';

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

describe('writeVignette', () => {
  describe('deriveSlug', () => {
    it('derives slug from dimension + first tag + id suffix', () => {
      const slug = deriveSlug(makeProposal());
      assert.ok(slug.startsWith('authentic-expression-'));
      assert.ok(slug.includes('活人感'));
      assert.ok(slug.endsWith('23xyz'));
    });

    it('handles empty tags gracefully', () => {
      const slug = deriveSlug(makeProposal({ tags: [] }));
      assert.ok(slug.includes('untitled'));
    });

    it('sanitizes special characters', () => {
      const slug = deriveSlug(makeProposal({ tags: ['hello world! @#$'] }));
      // Spaces become dashes, special chars removed
      assert.ok(!slug.includes(' '));
      assert.ok(!slug.includes('@'));
    });
  });

  describe('formatVignette', () => {
    it('emits standard vignette frontmatter: when / quotes / scene / tags (spec B4)', () => {
      const content = formatVignette(makeProposal());
      // when: date derived from createdAt (1720000000000 → 2024-07-03)
      assert.ok(content.includes('when: 2024-07-03'), 'should have when date');
      // quotes: YAML array with the proposal quote
      assert.ok(content.includes('quotes:'), 'should have quotes key');
      assert.ok(content.includes('太客服了，我要的是活人感'), 'should contain the quote text');
      // scene: YAML block scalar
      assert.ok(content.includes('scene: >'), 'should have scene as block scalar');
      assert.ok(content.includes('operator said'), 'should contain scene text');
      // tags: inline YAML array
      assert.ok(content.includes('tags: ["活人感", "authentic"]'), 'should have tags inline array with quoted values');
    });

    it('includes extra metadata fields for traceability', () => {
      const content = formatVignette(makeProposal());
      assert.ok(content.includes('dimension: authentic-expression'));
      assert.ok(content.includes('privacy: public'));
      assert.ok(content.includes('catId: opus'));
      assert.ok(content.includes('proposalId: proposal_abc123xyz'));
    });

    it('escapes double quotes in quote text', () => {
      const content = formatVignette(makeProposal({ quote: 'said "hello" then left' }));
      assert.ok(content.includes('said \\"hello\\" then left'));
    });

    it('escapes newlines and tabs in quote text', () => {
      const content = formatVignette(makeProposal({ quote: 'line one\nline two\ttab' }));
      // Newlines and tabs must be escaped inside YAML double-quoted scalar
      assert.ok(content.includes('\\n'), 'should escape newlines');
      assert.ok(content.includes('\\t'), 'should escape tabs');
      assert.ok(!content.includes('line one\nline two'), 'raw newline must not appear in quote line');
    });

    it('escapes backslashes in quote text', () => {
      const content = formatVignette(makeProposal({ quote: 'path is C:\\Users\\test' }));
      assert.ok(content.includes('C:\\\\Users\\\\test'), 'should double-escape backslashes');
    });

    it('quotes and escapes tag values for YAML safety', () => {
      const content = formatVignette(makeProposal({ tags: ['tag, with comma', 'tag "quoted"'] }));
      assert.ok(content.includes('"tag, with comma"'), 'tags with commas should be quoted');
      assert.ok(content.includes('"tag \\"quoted\\""'), 'tags with quotes should be escaped');
    });

    it('body is empty after frontmatter (no markdown sections)', () => {
      const content = formatVignette(makeProposal());
      // Should end with closing --- and a blank line, no ## headings
      assert.ok(!content.includes('## When'), 'should not have markdown When heading');
      assert.ok(!content.includes('## Quote'), 'should not have markdown Quote heading');
      assert.ok(!content.includes('## Tags'), 'should not have markdown Tags heading');
    });
  });

  // ── P2-1 fix: insertIntoIndex places entries under matching dimension section ──

  describe('insertIntoIndex', () => {
    let tmpDir;
    let indexPath;

    beforeEach(() => {
      tmpDir = join(tmpdir(), `taste-index-test-${Date.now()}`);
      mkdirSync(tmpDir, { recursive: true });
      indexPath = join(tmpDir, 'index.md');
    });

    afterEach(() => {
      rmSync(tmpDir, { recursive: true, force: true });
    });

    it('inserts entry under the matching dimension section', () => {
      // Write a realistic index with sections
      const index = [
        '# Taste Index',
        '',
        '### 表达真实',
        '',
        '- [**existing entry**](vignettes/existing.md)',
        '  - 搜索词：existing',
        '',
        '### 架构审美',
        '',
        '- [**first principles**](vignettes/first-principles.md)',
        '  - 搜索词：first-principles',
        '',
        '## 如何新增 vignette',
        '',
        'Instructions here.',
      ].join('\n');
      writeFileSync(indexPath, index, 'utf8');

      const proposal = makeProposal({ dimension: 'authentic-expression' });
      const original = insertIntoIndex(indexPath, 'test-slug', proposal);

      // Should have saved original content for rollback
      assert.ok(original !== null);
      assert.equal(original, index);

      const updated = readFileSync(indexPath, 'utf8');
      // Entry should be under "### 表达真实", not at EOF
      const lines = updated.split('\n');
      const sectionIdx = lines.findIndex((l) => l.includes('### 表达真实'));
      const entryIdx = lines.findIndex((l) => l.includes('test-slug'));
      const howToIdx = lines.findIndex((l) => l.includes('如何新增'));

      assert.ok(sectionIdx !== -1, '表达真实 section should exist');
      assert.ok(entryIdx !== -1, 'new entry should exist');
      assert.ok(entryIdx > sectionIdx, 'entry should be after section header');
      assert.ok(entryIdx < howToIdx, 'entry should be before 如何新增 section');
    });

    it('creates fresh index when none exists', () => {
      assert.ok(!existsSync(indexPath));

      const result = insertIntoIndex(indexPath, 'fresh-slug', makeProposal());
      // null = newly created (delete on rollback)
      assert.equal(result, null);
      assert.ok(existsSync(indexPath));
    });

    it('falls back to before 如何新增 when dimension has no section', () => {
      const index = '# Taste Index\n\n## 如何新增 vignette\n\nInstructions.\n';
      writeFileSync(indexPath, index, 'utf8');

      insertIntoIndex(indexPath, 'fallback-slug', makeProposal({ dimension: 'unknown-dimension' }));

      const updated = readFileSync(indexPath, 'utf8');
      const entryIdx = updated.indexOf('fallback-slug');
      const howToIdx = updated.indexOf('如何新增');
      assert.ok(entryIdx !== -1, 'entry should exist');
      assert.ok(entryIdx < howToIdx, 'entry should be before 如何新增');
    });

    it('returns original content for rollback', () => {
      const original = '# Taste Index\n\n### 表达真实\n\n- existing\n';
      writeFileSync(indexPath, original, 'utf8');

      const returned = insertIntoIndex(indexPath, 'slug', makeProposal());
      assert.equal(returned, original);

      // Simulate rollback: restore original
      writeFileSync(indexPath, returned, 'utf8');
      assert.equal(readFileSync(indexPath, 'utf8'), original);
    });
  });

  // ── R2 P1: git index cleanup on commit failure ──

  describe('createVignetteWriter — git rollback', () => {
    let gitDir;

    beforeEach(() => {
      gitDir = join(tmpdir(), `vignette-git-test-${Date.now()}`);
      mkdirSync(gitDir, { recursive: true });
      execSync('git init -b main', { cwd: gitDir, stdio: 'pipe' });
      execSync('git config user.email "test@test.com"', { cwd: gitDir, stdio: 'pipe' });
      execSync('git config user.name "Test"', { cwd: gitDir, stdio: 'pipe' });
      // Initial commit so HEAD exists
      writeFileSync(join(gitDir, 'README.md'), 'init');
      execSync('git add . && git commit -m "init"', { cwd: gitDir, stdio: 'pipe' });
    });

    afterEach(() => {
      rmSync(gitDir, { recursive: true, force: true });
    });

    it('cleans git staging area on commit failure (no stale staged files)', async () => {
      // Install a pre-commit hook that always fails → git commit will throw
      const hooksDir = join(gitDir, '.git/hooks');
      mkdirSync(hooksDir, { recursive: true });
      writeFileSync(join(hooksDir, 'pre-commit'), '#!/bin/sh\nexit 1\n');
      chmodSync(join(hooksDir, 'pre-commit'), 0o755);

      // Create index so insertIntoIndex has something to work with
      mkdirSync(join(gitDir, 'docs/taste'), { recursive: true });
      writeFileSync(join(gitDir, 'docs/taste/index.md'), '# Taste Index\n\n### 表达真实\n', 'utf8');
      execSync('git add docs/taste/index.md && git commit -m "add index" --no-verify', {
        cwd: gitDir,
        stdio: 'pipe',
      });

      const writer = createVignetteWriter(gitDir);
      const proposal = makeProposal({ status: 'approving' });

      // Writer should throw because git commit fails
      await assert.rejects(() => writer(proposal), /Vignette write failed/);

      // CRITICAL: git index must be clean — no staged files left behind
      const staged = execSync('git diff --cached --name-only', { cwd: gitDir, stdio: 'pipe' }).toString().trim();
      assert.equal(staged, '', 'git index should have no staged files after failed commit rollback');
    });

    it('rolls back vignette file when index write fails (R4 P1)', async () => {
      // Make docs/taste/index.md readonly → insertIntoIndex will throw when trying to write
      mkdirSync(join(gitDir, 'docs/taste'), { recursive: true });
      writeFileSync(join(gitDir, 'docs/taste/index.md'), '# Taste Index\n\n### 表达真実\n', 'utf8');
      execSync('git add docs/taste/index.md && git commit -m "add index"', { cwd: gitDir, stdio: 'pipe' });

      // Make index file readonly to force insertIntoIndex to throw
      chmodSync(join(gitDir, 'docs/taste/index.md'), 0o444);

      const writer = createVignetteWriter(gitDir);
      const proposal = makeProposal({ status: 'approving' });

      await assert.rejects(() => writer(proposal), /Vignette write failed/);

      // The vignette file should have been cleaned up (rolled back)
      const slug = deriveSlug(proposal);
      const vignettePath = join(gitDir, 'docs/taste/vignettes', `${slug}.md`);
      assert.ok(!existsSync(vignettePath), 'vignette file should be cleaned up after index write failure');

      // Restore permissions for cleanup
      chmodSync(join(gitDir, 'docs/taste/index.md'), 0o644);
    });

    it('does not absorb unrelated pre-staged files into the taste commit (R3 P1)', async () => {
      // Set up docs/taste/index.md in repo
      mkdirSync(join(gitDir, 'docs/taste'), { recursive: true });
      writeFileSync(join(gitDir, 'docs/taste/index.md'), '# Taste Index\n\n### 表达真实\n', 'utf8');
      execSync('git add docs/taste/index.md && git commit -m "add index"', { cwd: gitDir, stdio: 'pipe' });

      // Stage an UNRELATED file before calling the writer
      writeFileSync(join(gitDir, 'unrelated.txt'), 'should not be committed by taste writer');
      execSync('git add unrelated.txt', { cwd: gitDir, stdio: 'pipe' });

      const writer = createVignetteWriter(gitDir);
      const proposal = makeProposal({ status: 'approving' });
      await writer(proposal);

      // The taste commit should NOT contain unrelated.txt
      const lastCommitFiles = execSync('git diff-tree --no-commit-id --name-only -r HEAD', {
        cwd: gitDir,
        stdio: 'pipe',
      })
        .toString()
        .trim()
        .split('\n');

      assert.ok(!lastCommitFiles.includes('unrelated.txt'), 'taste commit must not contain unrelated files');
      assert.ok(
        lastCommitFiles.some((f) => f.includes('vignettes/')),
        'taste commit should contain vignette file',
      );

      // unrelated.txt should STILL be staged (not lost)
      const staged = execSync('git diff --cached --name-only', { cwd: gitDir, stdio: 'pipe' }).toString().trim();
      assert.ok(staged.includes('unrelated.txt'), 'unrelated file should still be staged after taste commit');
    });

    it('refuses a repository with no checked-out main worktree', async () => {
      // Create a non-main branch to simulate runtime worktree scenario
      execSync('git checkout -b runtime/main-sync', { cwd: gitDir, stdio: 'pipe' });

      // Set up docs/taste/index.md
      mkdirSync(join(gitDir, 'docs/taste'), { recursive: true });
      writeFileSync(join(gitDir, 'docs/taste/index.md'), '# Taste Index\n\n### 表达真実\n', 'utf8');
      execSync('git add docs/taste/index.md && git commit -m "add index"', { cwd: gitDir, stdio: 'pipe' });

      const writer = createVignetteWriter(gitDir);
      const proposal = makeProposal({ status: 'approving' });

      // Writer must refuse — there is no canonical main worktree in this repository.
      await assert.rejects(
        () => writer(proposal),
        /cannot find a checked-out refs\/heads\/main worktree/,
        'should reject a repository without a canonical main worktree',
      );

      // No files should have been written to disk
      const slug = deriveSlug(proposal);
      const vignettePath = join(gitDir, 'docs/taste/vignettes', `${slug}.md`);
      assert.ok(!existsSync(vignettePath), 'vignette file must not exist after branch guard rejection');
    });

    it('allows commits on main branch (happy path with guard)', async () => {
      // We're already on main from beforeEach — set up docs/taste/index.md
      mkdirSync(join(gitDir, 'docs/taste'), { recursive: true });
      writeFileSync(join(gitDir, 'docs/taste/index.md'), '# Taste Index\n\n### 表达真実\n', 'utf8');
      execSync('git add docs/taste/index.md && git commit -m "add index"', { cwd: gitDir, stdio: 'pipe' });

      const writer = createVignetteWriter(gitDir);
      const proposal = makeProposal({ status: 'approving' });

      // Should succeed on main
      const result = await writer(proposal);
      assert.ok(result.slug, 'should return slug');
      assert.ok(result.path, 'should return path');
    });
  });
});
