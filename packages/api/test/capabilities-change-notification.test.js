import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import {
  inheritFullyBlockedMcpCapabilitiesForNewCatsSync,
  readCapabilitiesConfig,
  writeCapabilitiesConfig,
} from '../dist/config/capabilities/capability-orchestrator.js';
import { configEventBus } from '../dist/config/config-event-bus.js';
import { syncMcpProject } from '../dist/mcp/mcp-sync-engine.js';

for (const writer of ['async', 'sync-inheritance', 'project-sync']) {
  test(`the ${writer} capability writer notifies only after the committed source is readable`, async (t) => {
    const parent = resolve('artifacts/role-agent-refactor/capabilities-notification');
    mkdirSync(parent, { recursive: true });
    const root = mkdtempSync(join(parent, 'fixture-'));
    const config = {
      version: 2,
      capabilities: [
        {
          id: 'fixture-server',
          type: 'mcp',
          enabled: true,
          globalEnabled: true,
          blockedCats: ['codex'],
          source: 'manual',
          mcpServer: { command: process.execPath, args: [], env: { TOKEN: 'owned-fixture-secret' } },
        },
      ],
    };
    await writeCapabilitiesConfig(root, config);
    const target = writer === 'project-sync' ? join(root, 'project') : root;
    if (writer === 'project-sync') await writeCapabilitiesConfig(target, { version: 2, capabilities: [] });
    const received = [],
      committed = [];
    let unrelatedReloads = 0;
    t.after(configEventBus.onKeysChange(['VAPID_PUBLIC_KEY'], () => unrelatedReloads++));
    t.after(
      configEventBus.onConfigChange((event) => {
        if (event.source !== 'capabilities') return;
        received.push(event);
        committed.push(JSON.parse(readFileSync(join(target, '.cat-cafe/capabilities.json'), 'utf8')));
      }),
    );
    if (writer === 'async') await writeCapabilitiesConfig(root, { ...config, capabilities: [] });
    else if (writer === 'sync-inheritance')
      assert.equal(inheritFullyBlockedMcpCapabilitiesForNewCatsSync(root, ['new-member'], new Set(['codex'])), true);
    else await syncMcpProject(target, root);
    assert.equal(received.length, 1);
    assert.equal(received[0].scope, 'domain');
    assert.deepEqual(received[0].changedKeys, [target]);
    assert.ok(received[0].changeSetId);
    assert.ok(Number.isFinite(received[0].timestamp));
    assert.ok(
      !JSON.stringify(received).includes('owned-fixture-secret'),
      'the event carries resource identity, not config or secrets',
    );
    if (writer === 'async') assert.deepEqual(committed[0].capabilities, []);
    else if (writer === 'sync-inheritance')
      assert.deepEqual(committed[0].capabilities[0].blockedCats, ['codex', 'new-member']);
    else assert.equal(committed[0].capabilities[0].id, 'fixture-server');
    await readCapabilitiesConfig(target);
    if (writer === 'sync-inheritance')
      assert.equal(inheritFullyBlockedMcpCapabilitiesForNewCatsSync(root, ['new-member'], new Set(['codex'])), false);
    const invalidRoot = join(root, 'not-a-directory');
    writeFileSync(invalidRoot, 'owned failure fixture');
    await assert.rejects(writeCapabilitiesConfig(invalidRoot, config));
    assert.equal(received.length, 1, 'reads, no-op inheritance and failed writes do not emit commits');
    assert.equal(unrelatedReloads, 0, 'capability writes do not trigger unrelated env-key reloads');
  });
}
