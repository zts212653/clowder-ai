import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { GovernanceBootstrapService } from '../../dist/config/governance/governance-bootstrap.js';

describe('governance preview and confirmation', () => {
  let catCafeRoot;
  let externalProject;

  beforeEach(async () => {
    catCafeRoot = await mkdtemp(join(tmpdir(), 'cat-cafe-root-'));
    externalProject = await mkdtemp(join(tmpdir(), 'external-project-'));
    await mkdir(join(catCafeRoot, 'cat-cafe-skills'), { recursive: true });
  });

  afterEach(async () => {
    await rm(catCafeRoot, { recursive: true, force: true });
    await rm(externalProject, { recursive: true, force: true });
  });

  it('preview is zero-write and confirmed checksum executes the same actions', async () => {
    const service = new GovernanceBootstrapService(catCafeRoot);
    const selection = { projectGuide: { thinEntrypoints: [] } };
    const preview = await service.bootstrap(externalProject, { dryRun: true, selection });
    await assert.rejects(readFile(join(externalProject, 'AGENTS.md'), 'utf8'), { code: 'ENOENT' });
    const report = await service.bootstrap(externalProject, {
      dryRun: false,
      selection,
      expectedPreviewChecksum: preview.previewChecksum,
    });
    assert.equal(report.dryRun, false);
    assert.deepStrictEqual(report.actions, preview.actions);
    assert.ok(await readFile(join(externalProject, 'AGENTS.md'), 'utf8'));
    assert.equal(
      (await service.getRegistry().get(externalProject))?.lastBootstrapReport?.previewChecksum,
      preview.previewChecksum,
    );
  });

  it('execute without an exact preview checksum is rejected', async () => {
    const service = new GovernanceBootstrapService(catCafeRoot);
    await assert.rejects(
      service.bootstrap(externalProject, {
        dryRun: false,
        selection: { docsLifecycle: true },
      }),
      /preview changed/i,
    );
  });
});
