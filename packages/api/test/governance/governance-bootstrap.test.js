import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, readFile, readlink, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { GovernanceBootstrapService } from '../../dist/config/governance/governance-bootstrap.js';
import {
  GOVERNANCE_PACK_VERSION,
  MANAGED_BLOCK_END,
  MANAGED_BLOCK_START,
} from '../../dist/config/governance/governance-pack.js';

describe('GovernanceBootstrapService', () => {
  let catCafeRoot;
  let targetProject;

  beforeEach(async () => {
    catCafeRoot = await mkdtemp(join(tmpdir(), 'cat-cafe-root-'));
    targetProject = await mkdtemp(join(tmpdir(), 'target-project-'));
    // Create cat-cafe-skills source directory with sample skills
    const skillsRoot = join(catCafeRoot, 'cat-cafe-skills');
    await mkdir(skillsRoot, { recursive: true });
    // ADR-025: per-skill symlinks need actual skills to link
    for (const name of ['tdd', 'worktree', 'quality-gate']) {
      await mkdir(join(skillsRoot, name));
      await writeFile(join(skillsRoot, name, 'SKILL.md'), `# ${name}`);
    }
    // Non-skill dir (no SKILL.md) — should be ignored
    await mkdir(join(skillsRoot, 'refs'));
  });

  afterEach(async () => {
    await rm(catCafeRoot, { recursive: true, force: true });
    await rm(targetProject, { recursive: true, force: true });
  });

  it('bootstraps empty project with all governance files', async () => {
    const svc = new GovernanceBootstrapService(catCafeRoot);
    const report = await svc.bootstrap(targetProject, { dryRun: false });

    assert.equal(report.dryRun, false);
    assert.equal(report.packVersion, GOVERNANCE_PACK_VERSION);
    assert.ok(report.actions.length > 0);

    // Should create CLAUDE.md, AGENTS.md, GEMINI.md, KIMI.md
    for (const f of ['CLAUDE.md', 'AGENTS.md', 'GEMINI.md', 'KIMI.md']) {
      const content = await readFile(join(targetProject, f), 'utf-8');
      assert.ok(content.includes(MANAGED_BLOCK_START), `${f} should have managed block start`);
      assert.ok(content.includes(MANAGED_BLOCK_END), `${f} should have managed block end`);
    }

    // Should create methodology skeleton
    const backlog = await readFile(join(targetProject, 'BACKLOG.md'), 'utf-8');
    assert.ok(backlog.includes('doc_kind:'));

    const sop = await readFile(join(targetProject, 'docs/SOP.md'), 'utf-8');
    assert.ok(sop.includes('worktree'));
  });

  it('creates per-skill symlinks for all 4 providers (ADR-025)', async () => {
    const svc = new GovernanceBootstrapService(catCafeRoot);
    await svc.bootstrap(targetProject, { dryRun: false });

    const skillsRoot = resolve(catCafeRoot, 'cat-cafe-skills');
    for (const dir of ['.claude/skills', '.codex/skills', '.gemini/skills', '.kimi/skills']) {
      // Each skill should have its own symlink (not directory-level)
      for (const skill of ['tdd', 'worktree', 'quality-gate']) {
        const linkPath = join(targetProject, dir, skill);
        const st = await lstat(linkPath);
        assert.ok(st.isSymbolicLink(), `${dir}/${skill} should be a symlink`);
        const target = await readlink(linkPath);
        const resolved = resolve(dirname(linkPath), target);
        assert.equal(resolved, resolve(skillsRoot, skill), `${dir}/${skill} should point to cat-cafe-skills/${skill}`);
      }
      // refs/ dir (no SKILL.md) should not be symlinked
      await assert.rejects(lstat(join(targetProject, dir, 'refs')), { code: 'ENOENT' });
    }
  });

  it('writes skills-state.json with managed skill names (ADR-025)', async () => {
    const svc = new GovernanceBootstrapService(catCafeRoot);
    await svc.bootstrap(targetProject, { dryRun: false });

    const raw = await readFile(join(targetProject, '.cat-cafe', 'skills-state.json'), 'utf-8');
    const state = JSON.parse(raw);
    assert.deepStrictEqual(state.managedSkillNames, ['quality-gate', 'tdd', 'worktree']); // sorted
    assert.ok(state.sourceManifestHash.startsWith('sha256:'));
    assert.ok(state.lastSyncedAt);
  });

  it('appends managed block to existing CLAUDE.md', async () => {
    const existing = '# My Project\n\nSome existing content.\n';
    await writeFile(join(targetProject, 'CLAUDE.md'), existing, 'utf-8');

    const svc = new GovernanceBootstrapService(catCafeRoot);
    await svc.bootstrap(targetProject, { dryRun: false });

    const content = await readFile(join(targetProject, 'CLAUDE.md'), 'utf-8');
    assert.ok(content.startsWith('# My Project'), 'existing content preserved');
    assert.ok(content.includes('Some existing content.'), 'existing content preserved');
    assert.ok(content.includes(MANAGED_BLOCK_START), 'managed block appended');
  });

  it('replaces existing managed block on re-bootstrap', async () => {
    // First bootstrap
    const svc = new GovernanceBootstrapService(catCafeRoot);
    await svc.bootstrap(targetProject, { dryRun: false });

    const _contentBefore = await readFile(join(targetProject, 'CLAUDE.md'), 'utf-8');

    // Second bootstrap — should replace, not duplicate
    await svc.bootstrap(targetProject, { dryRun: false });
    const contentAfter = await readFile(join(targetProject, 'CLAUDE.md'), 'utf-8');

    // Count managed block markers — should be exactly 1 pair
    const startCount = (contentAfter.match(new RegExp(MANAGED_BLOCK_START, 'g')) || []).length;
    const endCount = (contentAfter.match(new RegExp(MANAGED_BLOCK_END, 'g')) || []).length;
    assert.equal(startCount, 1, 'should have exactly 1 start marker');
    assert.equal(endCount, 1, 'should have exactly 1 end marker');
  });

  it('does not overwrite existing methodology files', async () => {
    const customBacklog = '# My Custom Backlog\n';
    await writeFile(join(targetProject, 'BACKLOG.md'), customBacklog, 'utf-8');

    const svc = new GovernanceBootstrapService(catCafeRoot);
    const report = await svc.bootstrap(targetProject, { dryRun: false });

    // BACKLOG.md should be untouched
    const content = await readFile(join(targetProject, 'BACKLOG.md'), 'utf-8');
    assert.equal(content, customBacklog, 'existing BACKLOG.md should not be overwritten');

    // The action should say 'skipped'
    const backlogAction = report.actions.find((a) => a.file === 'BACKLOG.md');
    assert.ok(backlogAction);
    assert.equal(backlogAction.action, 'skipped');
  });

  it('is idempotent — second run produces no created actions', async () => {
    const svc = new GovernanceBootstrapService(catCafeRoot);
    await svc.bootstrap(targetProject, { dryRun: false });

    const report2 = await svc.bootstrap(targetProject, { dryRun: false });
    const created = report2.actions.filter((a) => a.action === 'created');
    assert.equal(created.length, 0, 'no files should be created on second run');
  });

  it('dry-run writes nothing to disk', async () => {
    const svc = new GovernanceBootstrapService(catCafeRoot);
    const report = await svc.bootstrap(targetProject, { dryRun: true });

    assert.equal(report.dryRun, true);
    assert.ok(report.actions.length > 0);

    // No files should exist
    for (const f of ['CLAUDE.md', 'AGENTS.md', 'GEMINI.md', 'BACKLOG.md']) {
      await assert.rejects(lstat(join(targetProject, f)), { code: 'ENOENT' });
    }
  });

  it('saves bootstrap report to .cat-cafe/', async () => {
    const svc = new GovernanceBootstrapService(catCafeRoot);
    await svc.bootstrap(targetProject, { dryRun: false });

    const reportPath = join(targetProject, '.cat-cafe/governance-bootstrap-report.json');
    const raw = await readFile(reportPath, 'utf-8');
    const report = JSON.parse(raw);
    assert.equal(report.projectPath, targetProject);
    assert.equal(report.packVersion, GOVERNANCE_PACK_VERSION);
    assert.ok(Array.isArray(report.actions));
  });

  it('registers project in governance registry', async () => {
    const svc = new GovernanceBootstrapService(catCafeRoot);
    await svc.bootstrap(targetProject, { dryRun: false });

    const registry = svc.getRegistry();
    const entry = await registry.get(targetProject);
    assert.ok(entry);
    assert.equal(entry.packVersion, GOVERNANCE_PACK_VERSION);
    assert.equal(entry.confirmedByUser, true);
  });

  it('skips symlink if already correct', async () => {
    const svc = new GovernanceBootstrapService(catCafeRoot);
    await svc.bootstrap(targetProject, { dryRun: false });

    const report2 = await svc.bootstrap(targetProject, { dryRun: false });
    const symlinkActions = report2.actions.filter((a) => a.file.includes('skills'));
    for (const a of symlinkActions) {
      assert.equal(a.action, 'skipped', `${a.file} should be skipped on second run`);
    }
  });

  it('creates hooks symlink for claude provider', async () => {
    // Create source hooks dir in catCafeRoot
    await mkdir(join(catCafeRoot, '.claude', 'hooks'), { recursive: true });

    const svc = new GovernanceBootstrapService(catCafeRoot);
    await svc.bootstrap(targetProject, { dryRun: false });

    const hooksPath = join(targetProject, '.claude', 'hooks');
    const stat = await lstat(hooksPath);
    assert.ok(stat.isSymbolicLink(), '.claude/hooks should be a symlink');
  });

  it('creates hooks symlink for kimi provider when source exists', async () => {
    await mkdir(join(catCafeRoot, '.kimi', 'hooks'), { recursive: true });

    const svc = new GovernanceBootstrapService(catCafeRoot);
    await svc.bootstrap(targetProject, { dryRun: false });

    const hooksPath = join(targetProject, '.kimi', 'hooks');
    const stat = await lstat(hooksPath);
    assert.ok(stat.isSymbolicLink(), '.kimi/hooks should be a symlink');
  });

  it('skips hooks symlink when source hooks dir does not exist', async () => {
    // Don't create .claude/hooks in catCafeRoot
    const svc = new GovernanceBootstrapService(catCafeRoot);
    const report = await svc.bootstrap(targetProject, { dryRun: false });

    // Should have no hooks action (symlinkHooks returns null when source missing)
    const hooksAction = report.actions.find((a) => a.file.includes('hooks'));
    assert.equal(hooksAction, undefined, 'no hooks action when source hooks dir missing');
    // hooks dir should not exist in target
    await assert.rejects(lstat(join(targetProject, '.claude', 'hooks')), { code: 'ENOENT' });
  });
});
