import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { migrateLegacyPlaywrightToSharedBrowser } from '../dist/config/capabilities/shared-browser-migration.js';
import { sharedBrowserStdioServer } from '../dist/domains/browser/shared-browser-descriptor.js';

function project(capabilities, mcpServers) {
  const root = mkdtempSync(join(tmpdir(), 'f333-browser-migrate-'));
  mkdirSync(join(root, '.cat-cafe'));
  writeFileSync(
    join(root, '.cat-cafe/capabilities.json'),
    `${JSON.stringify({ version: 2, capabilities }, null, 2)}\n`,
  );
  if (mcpServers) writeFileSync(join(root, '.mcp.json'), `${JSON.stringify({ mcpServers }, null, 2)}\n`);
  return root;
}

const legacy = {
  id: 'playwright',
  type: 'mcp',
  enabled: true,
  globalEnabled: true,
  source: 'external',
  overrides: [{ catId: 'sonnet', enabled: false }],
  mcpServer: { command: 'npx', args: ['@playwright/mcp@latest', '--headless'] },
};

test('the seeded entry moves to the shared browser, keeps its switches, and leaves a 0600 backup', async () => {
  const root = project(
    [legacy, { id: 'pencil', type: 'mcp', mcpServer: { command: '', args: [], resolver: 'pencil' } }],
    {
      playwright: { command: '/opt/homebrew/opt/node@24/bin/npx', args: ['@playwright/mcp@latest', '--headless'] },
      other: { command: 'x', args: [] },
    },
  );
  try {
    assert.deepEqual((await migrateLegacyPlaywrightToSharedBrowser(root)).sort(), [
      '.cat-cafe/capabilities.json',
      '.mcp.json',
    ]);
    const caps = JSON.parse(readFileSync(join(root, '.cat-cafe/capabilities.json'), 'utf8')).capabilities;
    assert.deepEqual(caps[0], { ...legacy, mcpServer: { command: '', args: [], resolver: 'shared-browser' } });
    assert.deepEqual(caps[1].mcpServer.resolver, 'pencil');
    const mcp = JSON.parse(readFileSync(join(root, '.mcp.json'), 'utf8')).mcpServers;
    assert.deepEqual(mcp.playwright, sharedBrowserStdioServer(), 'terminal sessions get the isolated pinned launch');
    assert.deepEqual(mcp.other, { command: 'x', args: [] });
    const backups = readdirSync(join(root, '.cat-cafe')).filter((name) => name.includes('.before-f333-browser-'));
    assert.equal(backups.length, 1);
    assert.equal(statSync(join(root, '.cat-cafe', backups[0])).mode & 0o777, 0o600);
    assert.deepEqual(await migrateLegacyPlaywrightToSharedBrowser(root), [], 'second run is a no-op');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('anything a person edited is left exactly as written', async () => {
  const edited = [
    { ...legacy, mcpServer: { command: 'npx', args: ['@playwright/mcp@latest', '--headless', '--proxy-server=x'] } },
  ];
  const root = project(edited, { playwright: { command: 'npx', args: ['@playwright/mcp@0.0.70'] } });
  try {
    const before = readFileSync(join(root, '.cat-cafe/capabilities.json'), 'utf8');
    assert.deepEqual(await migrateLegacyPlaywrightToSharedBrowser(root), []);
    assert.equal(readFileSync(join(root, '.cat-cafe/capabilities.json'), 'utf8'), before);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
