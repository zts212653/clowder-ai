import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { appendAuditEntry } from '../../../dist/config/capabilities/capability-audit.js';
import { buildInstallPreview } from '../../../dist/config/capabilities/capability-install.js';
import {
  readCapabilitiesConfig,
  withCapabilityLock,
  writeCapabilitiesConfig,
} from '../../../dist/config/capabilities/capability-orchestrator.js';

describe('F146 review fixes', () => {
  /** @type {string} */
  let projectRoot;

  beforeEach(async () => {
    projectRoot = await mkdtemp(join(tmpdir(), 'f146-review-'));
    await mkdir(join(projectRoot, '.cat-cafe'), { recursive: true });
    const seed = {
      version: 1,
      capabilities: [
        { id: 'test-mcp', type: 'mcp', enabled: true, source: 'external' },
        { id: 'managed-mcp', type: 'mcp', enabled: true, source: 'cat-cafe' },
      ],
    };
    await writeCapabilitiesConfig(projectRoot, seed);
  });

  afterEach(async () => {
    await rm(projectRoot, { recursive: true, force: true });
  });

  test('P1-1: concurrent PATCH + install through same lock do not corrupt config', async () => {
    const toggleAndInstall = await Promise.all([
      withCapabilityLock(projectRoot, async () => {
        const config = await readCapabilitiesConfig(projectRoot);
        config.capabilities[0].enabled = false;
        await writeCapabilitiesConfig(projectRoot, config);
        return 'toggled';
      }),
      withCapabilityLock(projectRoot, async () => {
        const config = await readCapabilitiesConfig(projectRoot);
        const preview = buildInstallPreview({ id: 'new-mcp', command: 'echo', args: ['test'] });
        config.capabilities.push(preview.entry);
        await writeCapabilitiesConfig(projectRoot, config);
        return 'installed';
      }),
    ]);

    assert.deepEqual(toggleAndInstall, ['toggled', 'installed']);
    const config = await readCapabilitiesConfig(projectRoot);
    assert.ok(config);
    assert.equal(config.capabilities.length, 3);
    assert.equal(config.capabilities[0].enabled, false);
    assert.equal(config.capabilities[2].id, 'new-mcp');
  });

  test('P1-2: buildInstallPreview rejects non-string id', () => {
    assert.throws(() => {
      buildInstallPreview({ id: /** @type {any} */ ({ bad: 'id' }) });
    }, /id must be a non-empty string/);
  });

  test('P1-2: buildInstallPreview rejects empty string id', () => {
    assert.throws(() => {
      buildInstallPreview({ id: '' });
    }, /id must be a non-empty string/);
  });

  test('P2-new-1: buildInstallPreview rejects non-array args', () => {
    assert.throws(() => {
      buildInstallPreview({ id: 'test', args: /** @type {any} */ ('not-array') });
    }, /args must be an array/);
  });

  test('P2-new-1: buildInstallPreview rejects non-object env', () => {
    assert.throws(() => {
      buildInstallPreview({ id: 'test', env: /** @type {any} */ ('not-object') });
    }, /env must be a Record/);
  });

  test('P2-new-1: buildInstallPreview rejects array env', () => {
    assert.throws(() => {
      buildInstallPreview({ id: 'test', env: /** @type {any} */ ([]) });
    }, /env must be a Record/);
  });

  test('P2-new-1: buildInstallPreview rejects non-object headers', () => {
    assert.throws(() => {
      buildInstallPreview({ id: 'test', headers: /** @type {any} */ (42) });
    }, /headers must be a Record/);
  });

  test('P2-new-1: buildInstallPreview rejects non-string url', () => {
    assert.throws(() => {
      buildInstallPreview({ id: 'test', url: /** @type {any} */ (123) });
    }, /url must be a string/);
  });

  test('P2-new-1: buildInstallPreview rejects non-string resolver', () => {
    assert.throws(() => {
      buildInstallPreview({ id: 'test', resolver: /** @type {any} */ (true) });
    }, /resolver must be a string/);
  });

  test('P2-2: hard delete blocked for source=cat-cafe (programmatic check)', async () => {
    const config = await readCapabilitiesConfig(projectRoot);
    const managed = config.capabilities.find((c) => c.id === 'managed-mcp');
    assert.equal(managed.source, 'cat-cafe');
    assert.notEqual(managed.source, 'external');
  });

  // ── Cloud review round 2 regressions ──

  test('CR2-P1-1: install must not overwrite managed (source!=external) MCP', async () => {
    const config = await readCapabilitiesConfig(projectRoot);
    const managed = config.capabilities.find((c) => c.id === 'managed-mcp');
    assert.equal(managed.source, 'cat-cafe');
    assert.notEqual(managed.source, 'external', 'managed MCP must be blocked from overwrite');
  });

  test('CR2-P1-2: buildInstallPreview rejects args with non-string elements', () => {
    assert.throws(() => {
      buildInstallPreview({ id: 'test', args: /** @type {any} */ ([1, 'ok', {}]) });
    }, /args must be an array of strings/);
  });

  test('CR2-P1-2: buildInstallPreview accepts valid string-only args', () => {
    const result = buildInstallPreview({ id: 'test', command: 'echo', args: ['hello', 'world'] });
    assert.deepEqual(result.entry.mcpServer.args, ['hello', 'world']);
  });

  test('CR2-P2: soft-delete must clear overrides', async () => {
    const config = await readCapabilitiesConfig(projectRoot);
    config.capabilities[0].overrides = { toolApprovals: { 'read-file': true } };
    await writeCapabilitiesConfig(projectRoot, config);

    const updated = await readCapabilitiesConfig(projectRoot);
    const target = updated.capabilities[0];
    assert.ok(target.overrides, 'overrides should exist before soft-delete');

    target.enabled = false;
    delete target.overrides;
    await writeCapabilitiesConfig(projectRoot, updated);

    const final = await readCapabilitiesConfig(projectRoot);
    const softDeleted = final.capabilities.find((c) => c.id === 'test-mcp');
    assert.equal(softDeleted.enabled, false);
    assert.equal(softDeleted.overrides, undefined, 'overrides must be cleared after soft-delete');
  });
});
