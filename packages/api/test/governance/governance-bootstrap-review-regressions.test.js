import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import {
  GovernanceBootstrapService,
  GovernancePreviewConflictError,
} from '../../dist/config/governance/governance-bootstrap.js';
import { hashGovernanceContent } from '../../dist/config/governance/governance-bootstrap-plan.js';

describe('GovernanceBootstrapService review regressions', () => {
  let catCafeRoot;
  let targetProject;

  beforeEach(async () => {
    catCafeRoot = await mkdtemp(join(tmpdir(), 'cat-cafe-root-'));
    targetProject = await mkdtemp(join(tmpdir(), 'target-project-'));
  });

  afterEach(async () => {
    await rm(catCafeRoot, { recursive: true, force: true });
    await rm(targetProject, { recursive: true, force: true });
  });

  async function recordGeneratedFile(service, file, content) {
    await service.getRegistry().recordBootstrap(
      targetProject,
      { packVersion: '1.4.1', checksum: 'legacy', syncedAt: 1, confirmedByUser: true },
      {
        projectPath: targetProject,
        timestamp: 1,
        packVersion: '1.4.1',
        dryRun: false,
        selection: {},
        previewChecksum: 'legacy',
        actions: [
          {
            file,
            action: 'created',
            group: 'docs-lifecycle',
            reason: 'generated file',
            contentHash: hashGovernanceContent(content),
          },
        ],
      },
    );
  }

  async function previewProjectGuide(projectRoot, manifest, lockfiles = []) {
    await mkdir(projectRoot, { recursive: true });
    await writeFile(join(projectRoot, 'package.json'), JSON.stringify(manifest));
    for (const lockfile of lockfiles) {
      await writeFile(join(projectRoot, lockfile), '{}\n');
    }
    const service = new GovernanceBootstrapService(catCafeRoot);
    const preview = await service.bootstrap(projectRoot, {
      dryRun: true,
      selection: { projectGuide: { thinEntrypoints: [] } },
    });
    const guide = preview.actions.find((action) => action.file === 'AGENTS.md')?.content;
    assert.equal(typeof guide, 'string');
    return guide;
  }

  it('uses unknown when packageManager only has a known-runner prefix', async () => {
    const guide = await previewProjectGuide(
      targetProject,
      { packageManager: 'pnpm-invalid', scripts: { test: 'node --test' } },
      ['pnpm-lock.yaml'],
    );
    assert.match(guide, /unknown \(package\.json script: test\)/);
    assert.doesNotMatch(guide, /pnpm run test/);
  });

  it('treats every non-string packageManager value as unknown without lockfile fallback', async () => {
    const values = [null, 1, true, {}, []];
    for (const [index, packageManager] of values.entries()) {
      const root = join(targetProject, `non-string-${index}`);
      const guide = await previewProjectGuide(root, { packageManager, scripts: { test: 'node --test' } }, [
        'pnpm-lock.yaml',
      ]);
      assert.match(guide, /unknown \(package\.json script: test\)/);
      assert.doesNotMatch(guide, /pnpm run test/);
    }
  });

  it('treats non-object manifests and non-record scripts as having no discovered commands', async () => {
    const manifests = [null, 1, true, [], 'package', { scripts: 'test', packageManager: 'pnpm@1.0.0' }];
    for (const [index, manifest] of manifests.entries()) {
      const guide = await previewProjectGuide(join(targetProject, `invalid-manifest-${index}`), manifest, [
        'pnpm-lock.yaml',
      ]);
      assert.match(guide, /unknown: inspect this repository's manifests and CI configuration/);
      assert.doesNotMatch(guide, /pnpm run|package\.json script:/);
    }
  });

  it('requires valid exact SemVer before trusting an explicit packageManager', async () => {
    const invalidVersions = ['pnpm@1.0.0-01', 'pnpm@01.0.0', 'pnpm@1.0', 'pnpm@1.0.0-'];
    for (const [index, packageManager] of invalidVersions.entries()) {
      const root = join(targetProject, `invalid-semver-${index}`);
      const guide = await previewProjectGuide(root, { packageManager, scripts: { test: 'node --test' } }, [
        'pnpm-lock.yaml',
      ]);
      assert.match(guide, /unknown \(package\.json script: test\)/);
      assert.doesNotMatch(guide, /pnpm run test/);
    }

    const validGuide = await previewProjectGuide(
      join(targetProject, 'valid-semver'),
      { packageManager: 'pnpm@1.0.0-alpha.1+sha512.abc', scripts: { test: 'node --test' } },
      ['package-lock.json'],
    );
    assert.match(validGuide, /pnpm run test/);
  });

  it('uses unknown when multiple lockfiles make the package runner ambiguous', async () => {
    const guide = await previewProjectGuide(targetProject, { scripts: { test: 'node --test' } }, [
      'pnpm-lock.yaml',
      'package-lock.json',
    ]);
    assert.match(guide, /unknown \(package\.json script: test\)/);
    assert.doesNotMatch(guide, /pnpm run test|npm run test/);
  });

  it('protects capabilities state when the registry ledger differs only by case', async () => {
    const service = new GovernanceBootstrapService(catCafeRoot);
    await mkdir(join(targetProject, '.cat-cafe'), { recursive: true });
    const capabilities = '{"version":2,"user":"case-fold-sentinel"}\n';
    await writeFile(join(targetProject, '.cat-cafe/capabilities.json'), capabilities);
    await writeFile(join(targetProject, '.cat-cafe/CAPABILITIES.json'), capabilities);
    await recordGeneratedFile(service, '.cat-cafe/CAPABILITIES.json', capabilities);

    const preview = await service.cleanup(targetProject, { dryRun: true });
    assert.equal(preview.actions[0]?.action, 'skipped');
    assert.equal(preview.actions[0]?.reason, 'protected shared config');
    await service.cleanup(targetProject, {
      dryRun: false,
      expectedPreviewChecksum: preview.previewChecksum,
    });
    assert.equal(await readFile(join(targetProject, '.cat-cafe/capabilities.json'), 'utf8'), capabilities);
    assert.equal(await readFile(join(targetProject, '.cat-cafe/CAPABILITIES.json'), 'utf8'), capabilities);
  });

  it('protects canonical capabilities.json when the registry ledger uses a path alias', async () => {
    const service = new GovernanceBootstrapService(catCafeRoot);
    await mkdir(join(targetProject, '.cat-cafe'), { recursive: true });
    const capabilities = '{"version":2,"user":"sentinel"}\n';
    await writeFile(join(targetProject, '.cat-cafe/capabilities.json'), capabilities);
    await recordGeneratedFile(service, '.cat-cafe/./capabilities.json', capabilities);

    const preview = await service.cleanup(targetProject, { dryRun: true });
    assert.equal(preview.actions[0]?.action, 'skipped');
    assert.equal(preview.actions[0]?.reason, 'protected shared config');
    await service.cleanup(targetProject, {
      dryRun: false,
      expectedPreviewChecksum: preview.previewChecksum,
    });
    assert.equal(await readFile(join(targetProject, '.cat-cafe/capabilities.json'), 'utf8'), capabilities);
  });

  it('rejects a generated file whose parent is replaced by a symlink after preview', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'governance-cleanup-outside-'));
    try {
      const service = new GovernanceBootstrapService(catCafeRoot);
      const generated = '# generated SOP\n';
      await mkdir(join(targetProject, 'docs'));
      await writeFile(join(targetProject, 'docs/SOP.md'), generated);
      await recordGeneratedFile(service, 'docs/SOP.md', generated);
      const preview = await service.cleanup(targetProject, { dryRun: true });
      assert.equal(preview.actions[0]?.action, 'deleted');

      await rm(join(targetProject, 'docs'), { recursive: true });
      await writeFile(join(outside, 'SOP.md'), generated);
      await symlink(outside, join(targetProject, 'docs'));

      await assert.rejects(
        service.cleanup(targetProject, {
          dryRun: false,
          expectedPreviewChecksum: preview.previewChecksum,
        }),
        GovernancePreviewConflictError,
      );
      assert.equal(await readFile(join(outside, 'SOP.md'), 'utf8'), generated);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});
