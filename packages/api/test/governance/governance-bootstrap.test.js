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
  let previousGlobalRoot;

  beforeEach(async () => {
    catCafeRoot = await mkdtemp(join(tmpdir(), 'cat-cafe-root-'));
    targetProject = await mkdtemp(join(tmpdir(), 'target-project-'));
    previousGlobalRoot = process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT;
    process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT = catCafeRoot;

    await mkdir(join(catCafeRoot, '.cat-cafe'), { recursive: true });

    // Create cat-cafe-skills source directory (bootstrap symlinks to it)
    await mkdir(join(catCafeRoot, 'cat-cafe-skills'), { recursive: true });

    // Runtime bootstrap source template (used to create target .cat-cafe/cat-catalog.json)
    await writeFile(
      join(catCafeRoot, 'cat-template.json'),
      `${JSON.stringify(
        {
          version: 2,
          breeds: [],
          roster: {},
          reviewPolicy: {
            requireDifferentFamily: true,
            preferActiveInThread: true,
            preferLead: true,
            excludeUnavailable: true,
          },
        },
        null,
        2,
      )}\n`,
      'utf-8',
    );
  });

  afterEach(async () => {
    if (previousGlobalRoot === undefined) delete process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT;
    else process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT = previousGlobalRoot;
    await rm(catCafeRoot, { recursive: true, force: true });
    await rm(targetProject, { recursive: true, force: true });
  });

  it('bootstraps empty project with all governance files', async () => {
    const svc = new GovernanceBootstrapService(catCafeRoot);
    const report = await svc.bootstrap(targetProject, { dryRun: false });

    assert.equal(report.dryRun, false);
    assert.equal(report.packVersion, GOVERNANCE_PACK_VERSION);
    assert.ok(report.actions.length > 0);

    // Should create CLAUDE.md, AGENTS.md, GEMINI.md
    for (const f of ['CLAUDE.md', 'AGENTS.md', 'GEMINI.md']) {
      const content = await readFile(join(targetProject, f), 'utf-8');
      assert.ok(content.includes(MANAGED_BLOCK_START), `${f} should have managed block start`);
      assert.ok(content.includes(MANAGED_BLOCK_END), `${f} should have managed block end`);
    }

    // Should create methodology skeleton
    const backlog = await readFile(join(targetProject, 'BACKLOG.md'), 'utf-8');
    assert.ok(backlog.includes('doc_kind:'));

    const sop = await readFile(join(targetProject, 'docs/SOP.md'), 'utf-8');
    assert.ok(sop.includes('worktree'));

    // Should create runtime catalog for account resolution in external project threads
    const runtimeCatalog = JSON.parse(await readFile(join(targetProject, '.cat-cafe', 'cat-catalog.json'), 'utf-8'));
    assert.equal(runtimeCatalog.version, 2);
    assert.ok(runtimeCatalog.reviewPolicy);
  });

  it('creates skills symlinks for all 3 providers', async () => {
    const svc = new GovernanceBootstrapService(catCafeRoot);
    await svc.bootstrap(targetProject, { dryRun: false });

    const sourcePath = resolve(catCafeRoot, 'cat-cafe-skills');
    for (const dir of ['.claude/skills', '.codex/skills', '.gemini/skills']) {
      const linkPath = join(targetProject, dir);
      const stat = await lstat(linkPath);
      assert.ok(stat.isSymbolicLink(), `${dir} should be a symlink`);
      const target = await readlink(linkPath);
      const resolved = resolve(dirname(linkPath), target);
      assert.equal(resolved, sourcePath, `${dir} should point to cat-cafe-skills`);
    }
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

  it('migrates legacy provider profiles into target project catalog accounts', async () => {
    await writeFile(
      join(catCafeRoot, '.cat-cafe', 'provider-profiles.json'),
      JSON.stringify(
        {
          version: 3,
          activeProfileId: null,
          providers: [
            {
              id: 'my-glm',
              displayName: 'My GLM',
              kind: 'api_key',
              authType: 'api_key',
              builtin: false,
              protocol: 'openai',
              baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
              models: ['glm-5'],
              createdAt: '2026-01-01',
              updatedAt: '2026-01-01',
            },
          ],
          bootstrapBindings: {},
        },
        null,
        2,
      ),
      'utf-8',
    );

    await writeFile(
      join(catCafeRoot, '.cat-cafe', 'provider-profiles.secrets.local.json'),
      JSON.stringify(
        {
          version: 3,
          profiles: {
            'my-glm': { apiKey: 'glm-key-xxx' },
          },
        },
        null,
        2,
      ),
      'utf-8',
    );

    const svc = new GovernanceBootstrapService(catCafeRoot);
    const report = await svc.bootstrap(targetProject, { dryRun: false });

    const migrationAction = report.actions.find((a) => a.file === '.cat-cafe/accounts-migration');
    assert.ok(migrationAction);
    assert.equal(migrationAction.action, 'updated');

    const catalog = JSON.parse(await readFile(join(targetProject, '.cat-cafe', 'cat-catalog.json'), 'utf-8'));
    assert.equal(catalog.accounts['my-glm'].protocol, 'openai');
    assert.equal(catalog.accounts['my-glm'].authType, 'api_key');

    const creds = JSON.parse(await readFile(join(catCafeRoot, '.cat-cafe', 'credentials.json'), 'utf-8'));
    assert.equal(creds['my-glm'].apiKey, 'glm-key-xxx');
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
