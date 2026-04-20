import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { GovernanceBootstrapService } from '../../dist/config/governance/governance-bootstrap.js';
import { GOVERNANCE_PACK_VERSION } from '../../dist/config/governance/governance-pack.js';
import { checkGovernancePreflight } from '../../dist/config/governance/governance-preflight.js';
import { GovernanceRegistry } from '../../dist/config/governance/governance-registry.js';

describe('governance-preflight', () => {
  let catCafeRoot;
  let externalProject;

  beforeEach(async () => {
    catCafeRoot = await mkdtemp(join(tmpdir(), 'cat-cafe-root-'));
    externalProject = await mkdtemp(join(tmpdir(), 'external-project-'));
    // ADR-025: bootstrap needs at least one skill to create per-skill symlinks
    await mkdir(join(catCafeRoot, 'cat-cafe-skills', 'tdd'), { recursive: true });
    await writeFile(join(catCafeRoot, 'cat-cafe-skills', 'tdd', 'SKILL.md'), '# TDD');
  });

  afterEach(async () => {
    await rm(catCafeRoot, { recursive: true, force: true });
    await rm(externalProject, { recursive: true, force: true });
  });

  it('passes for cat-cafe project (not external)', async () => {
    const result = await checkGovernancePreflight(catCafeRoot, catCafeRoot);
    assert.equal(result.ready, true);
    assert.equal(result.reason, undefined);
  });

  it('returns needsBootstrap for unbootstrapped external project', async () => {
    const result = await checkGovernancePreflight(externalProject, catCafeRoot);
    assert.equal(result.ready, false);
    assert.equal(result.needsBootstrap, true, 'Should signal bootstrap is needed');
    assert.ok(result.reason?.includes('not bootstrapped'));
  });

  it('returns needsConfirmation for unconfirmed project', async () => {
    const registry = new GovernanceRegistry(catCafeRoot);
    await registry.register(externalProject, {
      packVersion: GOVERNANCE_PACK_VERSION,
      checksum: 'abc',
      syncedAt: Date.now(),
      confirmedByUser: false,
    });

    const result = await checkGovernancePreflight(externalProject, catCafeRoot);
    assert.equal(result.ready, false);
    assert.equal(result.needsConfirmation, true, 'Should signal confirmation is needed');
    assert.ok(result.reason?.includes('confirmation'));
  });

  it('passes for bootstrapped and confirmed project', async () => {
    const service = new GovernanceBootstrapService(catCafeRoot);
    await service.bootstrap(externalProject, { dryRun: false });

    const result = await checkGovernancePreflight(externalProject, catCafeRoot);
    assert.equal(result.ready, true);
  });

  it('fails when registry confirmed but CLAUDE.md deleted', async () => {
    const service = new GovernanceBootstrapService(catCafeRoot);
    await service.bootstrap(externalProject, { dryRun: false });
    await rm(join(externalProject, 'CLAUDE.md'));

    const result = await checkGovernancePreflight(externalProject, catCafeRoot);
    assert.equal(result.ready, false);
    assert.ok(result.reason?.includes('CLAUDE.md'));
  });

  it('fails when registry confirmed but skills symlinks removed', async () => {
    const service = new GovernanceBootstrapService(catCafeRoot);
    await service.bootstrap(externalProject, { dryRun: false });
    for (const dir of ['.claude/skills', '.codex/skills', '.gemini/skills', '.kimi/skills']) {
      await rm(join(externalProject, dir), { recursive: true, force: true }).catch(() => {});
    }

    const result = await checkGovernancePreflight(externalProject, catCafeRoot);
    assert.equal(result.ready, false);
    assert.ok(result.reason?.includes('skills'));
  });

  it('provides actionable bootstrapCommand for new projects', async () => {
    const result = await checkGovernancePreflight(externalProject, catCafeRoot);
    assert.equal(result.ready, false);
    assert.ok(result.bootstrapCommand, 'Should include a bootstrap command hint');
  });

  it('uses KIMI.md and .kimi/skills when preflighting a kimi project', async () => {
    const service = new GovernanceBootstrapService(catCafeRoot);
    await service.bootstrap(externalProject, { dryRun: false });
    await rm(join(externalProject, 'KIMI.md'));

    const result = await checkGovernancePreflight(externalProject, catCafeRoot, 'kimi');
    assert.equal(result.ready, false);
    assert.ok(result.reason?.includes('KIMI.md'));
  });

  it('requires .kimi/skills when preflighting a kimi project', async () => {
    const service = new GovernanceBootstrapService(catCafeRoot);
    await service.bootstrap(externalProject, { dryRun: false });
    await rm(join(externalProject, '.kimi/skills'), { recursive: true, force: true });

    const result = await checkGovernancePreflight(externalProject, catCafeRoot, 'kimi');
    assert.equal(result.ready, false);
    assert.ok(result.reason?.includes('.kimi/skills'));
  });
});
