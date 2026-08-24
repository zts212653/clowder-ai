import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, readdir, readFile, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import {
  GovernanceBootstrapService,
  GovernancePreviewConflictError,
} from '../../dist/config/governance/governance-bootstrap.js';

describe('GovernanceBootstrapService F302', () => {
  let catCafeRoot;
  let targetProject;

  beforeEach(async () => {
    catCafeRoot = await mkdtemp(join(tmpdir(), 'cat-cafe-root-'));
    targetProject = await mkdtemp(join(tmpdir(), 'target-project-'));
    for (const name of ['tdd', 'worktree']) {
      await mkdir(join(catCafeRoot, 'cat-cafe-skills', name), { recursive: true });
      await writeFile(join(catCafeRoot, 'cat-cafe-skills', name, 'SKILL.md'), `# ${name}\n`);
    }
    await mkdir(join(catCafeRoot, 'cat-cafe-skills', 'refs'), { recursive: true });
    await writeFile(join(catCafeRoot, 'cat-cafe-skills', 'refs', 'shared-rules.md'), '# rules\n');
  });

  afterEach(async () => {
    await rm(catCafeRoot, { recursive: true, force: true });
    await rm(targetProject, { recursive: true, force: true });
  });

  async function install(selection) {
    const service = new GovernanceBootstrapService(catCafeRoot);
    const preview = await service.bootstrap(targetProject, { dryRun: true, selection });
    const report = await service.bootstrap(targetProject, {
      dryRun: false,
      selection,
      expectedPreviewChecksum: preview.previewChecksum,
    });
    return { service, preview, report };
  }

  it('treats missing or empty selection as zero actions and zero state', async () => {
    const service = new GovernanceBootstrapService(catCafeRoot);
    const preview = await service.bootstrap(targetProject, { dryRun: true });
    assert.deepStrictEqual(preview.selection, {});
    assert.deepStrictEqual(preview.actions, []);
    await service.bootstrap(targetProject, {
      dryRun: false,
      expectedPreviewChecksum: preview.previewChecksum,
    });
    assert.deepStrictEqual(await readdir(targetProject), []);
    assert.equal(await service.getRegistry().get(targetProject), undefined);
  });

  it('writes one AGENTS.md body and only selected Claude/Gemini thin entries', async () => {
    await writeFile(join(targetProject, 'CLAUDE.md'), '# existing Claude instructions\n');
    const selection = { projectGuide: { thinEntrypoints: ['gemini', 'claude'] } };
    const { preview } = await install(selection);

    assert.equal((await readFile(join(targetProject, 'CLAUDE.md'), 'utf8')).trim(), '# existing Claude instructions');
    assert.equal(await readFile(join(targetProject, 'GEMINI.md'), 'utf8'), '@AGENTS.md\n');
    assert.match(await readFile(join(targetProject, 'AGENTS.md'), 'utf8'), /project instructions/);
    await assert.rejects(lstat(join(targetProject, 'KIMI.md')), { code: 'ENOENT' });
    assert.equal(preview.actions.find((action) => action.file === 'CLAUDE.md')?.action, 'skipped');
  });

  it('renders only repository scripts with its detected package manager', async () => {
    await writeFile(
      join(targetProject, 'package.json'),
      JSON.stringify({
        name: 'community-plugin',
        packageManager: 'pnpm@10.0.0',
        scripts: { build: 'tsc', test: 'vitest' },
      }),
    );
    await writeFile(join(targetProject, 'yarn.lock'), '# conflicting lockfile\n');
    await writeFile(join(targetProject, 'package-lock.json'), '{}\n');
    await install({ projectGuide: { thinEntrypoints: [] }, docsLifecycle: true });
    const guide = await readFile(join(targetProject, 'AGENTS.md'), 'utf8');
    const sop = await readFile(join(targetProject, 'docs/SOP.md'), 'utf8');
    for (const text of [guide, sop]) {
      assert.match(text, /pnpm run build/);
      assert.match(text, /pnpm run test/);
      assert.doesNotMatch(text, /pnpm gate|pnpm check|pnpm lint/);
    }
  });

  it('uses unknown when package scripts exist but the runner is not discoverable', async () => {
    await writeFile(join(targetProject, 'package.json'), JSON.stringify({ scripts: { verify: 'custom-tool' } }));
    await install({ projectGuide: { thinEntrypoints: [] } });
    assert.match(await readFile(join(targetProject, 'AGENTS.md'), 'utf8'), /unknown \(package\.json script: verify\)/);
  });

  it('materializes only selected Skills and providers without capabilities or target reports', async () => {
    await install({ projectSkills: { skillIds: ['tdd'], providers: ['codex'] } });
    const skillPath = join(targetProject, '.codex/skills/tdd');
    assert.equal(resolve(dirname(skillPath), await readlink(skillPath)), join(catCafeRoot, 'cat-cafe-skills', 'tdd'));
    const refsPath = join(targetProject, '.codex/skills/.cat-cafe-shared-refs');
    assert.equal(resolve(dirname(refsPath), await readlink(refsPath)), join(catCafeRoot, 'cat-cafe-skills', 'refs'));
    await assert.rejects(lstat(join(targetProject, '.claude')), { code: 'ENOENT' });
    await assert.rejects(lstat(join(targetProject, '.cat-cafe')), { code: 'ENOENT' });
  });

  it('returns a fresh preview and writes nothing when the target changes after preview', async () => {
    const service = new GovernanceBootstrapService(catCafeRoot);
    const selection = { projectGuide: { thinEntrypoints: ['claude'] }, docsLifecycle: true };
    const preview = await service.bootstrap(targetProject, { dryRun: true, selection });
    await writeFile(join(targetProject, 'AGENTS.md'), '# arrived after preview\n');

    await assert.rejects(
      service.bootstrap(targetProject, {
        dryRun: false,
        selection,
        expectedPreviewChecksum: preview.previewChecksum,
      }),
      (error) =>
        error instanceof GovernancePreviewConflictError &&
        error.freshPreview.previewChecksum !== preview.previewChecksum,
    );
    await assert.rejects(lstat(join(targetProject, 'CLAUDE.md')), { code: 'ENOENT' });
    await assert.rejects(lstat(join(targetProject, 'docs')), { code: 'ENOENT' });
  });

  it('normalizes duplicate selection coordinates into one checksum and one action', async () => {
    const service = new GovernanceBootstrapService(catCafeRoot);
    const first = await service.bootstrap(targetProject, {
      dryRun: true,
      selection: { projectSkills: { skillIds: ['tdd', 'tdd'], providers: ['codex', 'codex'] } },
    });
    const second = await service.bootstrap(targetProject, {
      dryRun: true,
      selection: { projectSkills: { skillIds: ['tdd'], providers: ['codex'] } },
    });
    assert.equal(first.previewChecksum, second.previewChecksum);
    assert.equal(first.actions.filter((action) => action.file.endsWith('/tdd')).length, 1);
  });

  it('skips writes through a symlinked provider directory', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'governance-outside-'));
    try {
      await symlink(outside, join(targetProject, '.codex'));
      const service = new GovernanceBootstrapService(catCafeRoot);
      const preview = await service.bootstrap(targetProject, {
        dryRun: true,
        selection: { projectSkills: { skillIds: ['tdd'], providers: ['codex'] } },
      });
      assert.ok(preview.actions.every((action) => action.action === 'skipped'));
      assert.deepStrictEqual(await readdir(outside), []);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('undo deletes matching generated files and symlinks from the registry ledger', async () => {
    const { service } = await install({
      projectGuide: { thinEntrypoints: ['claude'] },
      projectSkills: { skillIds: ['tdd'], providers: ['codex'] },
    });
    const preview = await service.cleanup(targetProject, { dryRun: true });
    assert.ok(preview.actions.some((action) => action.action === 'deleted'));
    await service.cleanup(targetProject, {
      dryRun: false,
      expectedPreviewChecksum: preview.previewChecksum,
    });
    for (const file of ['AGENTS.md', 'CLAUDE.md', '.codex/skills/tdd', '.codex/skills/.cat-cafe-shared-refs']) {
      await assert.rejects(lstat(join(targetProject, file)), { code: 'ENOENT' });
    }
  });

  it('undo skips edited generated files and keeps capabilities.json byte-identical', async () => {
    const { service } = await install({ projectGuide: { thinEntrypoints: [] } });
    await writeFile(join(targetProject, 'AGENTS.md'), '# user edit\n');
    await mkdir(join(targetProject, '.cat-cafe'), { recursive: true });
    const capabilities = '{"version":2,"user":"sentinel"}\n';
    await writeFile(join(targetProject, '.cat-cafe/capabilities.json'), capabilities);
    const preview = await service.cleanup(targetProject, { dryRun: true });
    assert.equal(preview.actions.find((action) => action.file === 'AGENTS.md')?.action, 'skipped');
    await service.cleanup(targetProject, {
      dryRun: false,
      expectedPreviewChecksum: preview.previewChecksum,
    });
    assert.equal(await readFile(join(targetProject, 'AGENTS.md'), 'utf8'), '# user edit\n');
    assert.equal(await readFile(join(targetProject, '.cat-cafe/capabilities.json'), 'utf8'), capabilities);
  });

  it('legacy cleanup removes only a still-matching symlink and never trusts hashless files', async () => {
    const legacySource = join(catCafeRoot, 'cat-cafe-skills', 'tdd');
    await mkdir(join(targetProject, '.claude/skills'), { recursive: true });
    await symlink(legacySource, join(targetProject, '.claude/skills/tdd'));
    await writeFile(join(targetProject, 'CLAUDE.md'), '# legacy but user-editable\n');
    await mkdir(join(targetProject, '.cat-cafe'), { recursive: true });
    const capabilities = '{"version":2}\n';
    await writeFile(join(targetProject, '.cat-cafe/capabilities.json'), capabilities);
    await writeFile(
      join(targetProject, '.cat-cafe/governance-bootstrap-report.json'),
      JSON.stringify({
        projectPath: targetProject,
        timestamp: 1,
        packVersion: '1.4.1',
        dryRun: false,
        actions: [
          { file: 'CLAUDE.md', action: 'created', reason: 'legacy file' },
          { file: '.claude/skills/tdd', action: 'symlinked', reason: `linked to ${legacySource}` },
          { file: '.cat-cafe/capabilities.json', action: 'created', reason: 'legacy shared state' },
        ],
      }),
    );
    const service = new GovernanceBootstrapService(catCafeRoot);
    const preview = await service.cleanup(targetProject, { dryRun: true });
    assert.equal(preview.actions.find((action) => action.file === 'CLAUDE.md')?.action, 'skipped');
    assert.equal(preview.actions.find((action) => action.file === '.claude/skills/tdd')?.action, 'deleted');
    assert.equal(
      preview.actions.find((action) => action.file === '.cat-cafe/capabilities.json')?.reason,
      'protected shared config',
    );
    await service.cleanup(targetProject, {
      dryRun: false,
      expectedPreviewChecksum: preview.previewChecksum,
    });
    await assert.rejects(lstat(join(targetProject, '.claude/skills/tdd')), { code: 'ENOENT' });
    assert.equal(await readFile(join(targetProject, 'CLAUDE.md'), 'utf8'), '# legacy but user-editable\n');
    assert.equal(await readFile(join(targetProject, '.cat-cafe/capabilities.json'), 'utf8'), capabilities);
    assert.ok(await readFile(join(targetProject, '.cat-cafe/governance-bootstrap-report.json'), 'utf8'));
    assert.ok(await service.getRegistry().get(targetProject), 'confirmed legacy cleanup is recorded in Clowder AI');
  });

  it('legacy cleanup removes its report last when every generated candidate is disposed', async () => {
    const legacySource = join(catCafeRoot, 'cat-cafe-skills', 'tdd');
    await mkdir(join(targetProject, '.claude/skills'), { recursive: true });
    await symlink(legacySource, join(targetProject, '.claude/skills/tdd'));
    await mkdir(join(targetProject, '.cat-cafe'), { recursive: true });
    const legacyReport = join(targetProject, '.cat-cafe/governance-bootstrap-report.json');
    await writeFile(
      legacyReport,
      JSON.stringify({
        projectPath: targetProject,
        timestamp: 1,
        packVersion: '1.4.1',
        dryRun: false,
        actions: [
          { file: '.claude/skills/tdd', action: 'symlinked', reason: `linked to ${legacySource}` },
          { file: 'already-gone.md', action: 'created', reason: 'legacy file' },
        ],
      }),
    );

    const service = new GovernanceBootstrapService(catCafeRoot);
    const preview = await service.cleanup(targetProject, { dryRun: true });
    assert.equal(
      preview.actions.at(-1)?.file,
      '.cat-cafe/governance-bootstrap-report.json',
      'legacy report must be the final visible action',
    );
    assert.equal(preview.actions.at(-1)?.action, 'deleted');
    await service.cleanup(targetProject, {
      dryRun: false,
      expectedPreviewChecksum: preview.previewChecksum,
    });
    await assert.rejects(lstat(legacyReport), { code: 'ENOENT' });
    const registry = await service.getRegistry().get(targetProject);
    assert.equal(registry?.lastCleanupReport?.dryRun, false);
  });
});
