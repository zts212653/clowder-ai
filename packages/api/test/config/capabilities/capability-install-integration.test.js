import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { appendAuditEntry, readAuditLog } from '../../../dist/config/capabilities/capability-audit.js';
import { buildInstallPreview } from '../../../dist/config/capabilities/capability-install.js';
import {
  readCapabilitiesConfig,
  withCapabilityLock,
  writeCapabilitiesConfig,
} from '../../../dist/config/capabilities/capability-orchestrator.js';

describe('F146 validation scenario: browser 3-backend integration', () => {
  /** @type {string} */
  let projectRoot;

  beforeEach(async () => {
    projectRoot = await mkdtemp(join(tmpdir(), 'f146-int-'));
    await mkdir(join(projectRoot, '.cat-cafe'), { recursive: true });
    /** @type {import('@cat-cafe/shared').CapabilitiesConfig} */
    const seed = { version: 1, capabilities: [] };
    await writeCapabilitiesConfig(projectRoot, seed);
  });

  afterEach(async () => {
    await rm(projectRoot, { recursive: true, force: true });
  });

  test('install agent-browser via write path', async () => {
    const preview = buildInstallPreview({
      id: 'agent-browser',
      command: 'npx',
      args: ['agent-browser-mcp'],
    });
    assert.equal(preview.entry.id, 'agent-browser');
    assert.equal(preview.risks.length, 0);
    assert.equal(preview.willProbe, true);

    await withCapabilityLock(projectRoot, async () => {
      const config = await readCapabilitiesConfig(projectRoot);
      config.capabilities.push(preview.entry);
      await writeCapabilitiesConfig(projectRoot, config);
      await appendAuditEntry(projectRoot, {
        timestamp: new Date().toISOString(),
        userId: 'test-cat',
        action: 'install',
        capabilityId: 'agent-browser',
        before: null,
        after: preview.entry,
      });
    });

    const config = await readCapabilitiesConfig(projectRoot);
    assert.ok(config);
    assert.equal(config.capabilities.length, 1);
    assert.equal(config.capabilities[0].id, 'agent-browser');
  });

  test('install pinchtab via write path', async () => {
    const preview = buildInstallPreview({
      id: 'pinchtab',
      command: '/home/user/pinchtab-darwin-arm64',
      args: ['mcp'],
    });
    assert.equal(preview.entry.id, 'pinchtab');
    assert.equal(preview.willProbe, true);

    await withCapabilityLock(projectRoot, async () => {
      const config = await readCapabilitiesConfig(projectRoot);
      config.capabilities.push(preview.entry);
      await writeCapabilitiesConfig(projectRoot, config);
      await appendAuditEntry(projectRoot, {
        timestamp: new Date().toISOString(),
        userId: 'test-cat',
        action: 'install',
        capabilityId: 'pinchtab',
        before: null,
        after: preview.entry,
      });
    });

    const config = await readCapabilitiesConfig(projectRoot);
    assert.ok(config);
    const cap = config.capabilities.find((c) => c.id === 'pinchtab');
    assert.ok(cap);
    assert.equal(cap.mcpServer?.command, '/home/user/pinchtab-darwin-arm64');
  });

  test('install claude-in-chrome via resolver', async () => {
    const preview = buildInstallPreview({
      id: 'claude-in-chrome',
      resolver: 'chrome-extension',
    });
    assert.equal(preview.entry.mcpServer?.resolver, 'chrome-extension');
    assert.equal(preview.willProbe, false);

    await withCapabilityLock(projectRoot, async () => {
      const config = await readCapabilitiesConfig(projectRoot);
      config.capabilities.push(preview.entry);
      await writeCapabilitiesConfig(projectRoot, config);
      await appendAuditEntry(projectRoot, {
        timestamp: new Date().toISOString(),
        userId: 'test-cat',
        action: 'install',
        capabilityId: 'claude-in-chrome',
        before: null,
        after: preview.entry,
      });
    });

    const config = await readCapabilitiesConfig(projectRoot);
    assert.ok(config);
    assert.equal(config.capabilities.find((c) => c.id === 'claude-in-chrome')?.mcpServer?.resolver, 'chrome-extension');
  });

  test('full scenario: install 3 → delete 1 → verify audit', async () => {
    const backends = [
      { id: 'agent-browser', command: 'npx', args: ['agent-browser-mcp'] },
      { id: 'pinchtab', command: '/home/user/pinchtab-darwin-arm64', args: ['mcp'] },
      { id: 'claude-in-chrome', resolver: 'chrome-extension' },
    ];

    for (const b of backends) {
      const preview = buildInstallPreview(b);
      await withCapabilityLock(projectRoot, async () => {
        const config = await readCapabilitiesConfig(projectRoot);
        config.capabilities.push(preview.entry);
        await writeCapabilitiesConfig(projectRoot, config);
        await appendAuditEntry(projectRoot, {
          timestamp: new Date().toISOString(),
          userId: 'opus',
          action: 'install',
          capabilityId: b.id,
          before: null,
          after: preview.entry,
        });
      });
    }

    let config = await readCapabilitiesConfig(projectRoot);
    assert.equal(config.capabilities.length, 3);

    await withCapabilityLock(projectRoot, async () => {
      const c = await readCapabilitiesConfig(projectRoot);
      const idx = c.capabilities.findIndex((cap) => cap.id === 'agent-browser');
      const before = structuredClone(c.capabilities[idx]);
      c.capabilities.splice(idx, 1);
      await writeCapabilitiesConfig(projectRoot, c);
      await appendAuditEntry(projectRoot, {
        timestamp: new Date().toISOString(),
        userId: 'opus',
        action: 'delete',
        capabilityId: 'agent-browser',
        before,
        after: null,
      });
    });

    config = await readCapabilitiesConfig(projectRoot);
    assert.equal(config.capabilities.length, 2);
    assert.ok(!config.capabilities.some((c) => c.id === 'agent-browser'));

    const audit = await readAuditLog(projectRoot);
    assert.equal(audit.length, 4);
    assert.equal(audit[0].action, 'install');
    assert.equal(audit[0].capabilityId, 'agent-browser');
    assert.equal(audit[3].action, 'delete');
    assert.equal(audit[3].capabilityId, 'agent-browser');
    assert.equal(audit[3].before?.id, 'agent-browser');
    assert.equal(audit[3].after, null);
  });

  test('concurrent installs do not lose entries', async () => {
    const ids = Array.from({ length: 5 }, (_, i) => `mcp-${i}`);

    await Promise.all(
      ids.map((id) =>
        withCapabilityLock(projectRoot, async () => {
          const config = await readCapabilitiesConfig(projectRoot);
          const preview = buildInstallPreview({ id, command: 'echo', args: [id] });
          config.capabilities.push(preview.entry);
          await writeCapabilitiesConfig(projectRoot, config);
        }),
      ),
    );

    const config = await readCapabilitiesConfig(projectRoot);
    assert.equal(config.capabilities.length, 5, 'All 5 concurrent installs must persist');
  });
});
