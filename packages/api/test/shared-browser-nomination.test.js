import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { materializeNativeMcpHttp } from '../dist/config/capabilities/managed-mcp-config.js';
import {
  isSharedBrowserStdioServer,
  SHARED_BROWSER_HTTP_PATH,
  sharedBrowserStdioServer,
  workspaceProfileDir,
} from '../dist/domains/browser/shared-browser-descriptor.js';

function sharedCallback(root) {
  const path = join(root, 'turn.json');
  writeFileSync(path, JSON.stringify({ invocationId: 'inv-1', callbackToken: 'token-1' }), { mode: 0o600 });
  return {
    CAT_CAFE_API_URL: 'http://127.0.0.1:3004',
    CAT_CAFE_INVOCATION_ID: 'inv-1',
    CAT_CAFE_CALLBACK_TOKEN: 'token-1',
    CAT_CAFE_CREDENTIAL_FILE: path,
    CAT_CAFE_MCP_TRANSPORT: 'shared',
  };
}

test('only the pinned launch is nominated to the shared browser route, with invocation headers', () => {
  const root = mkdtempSync(join(tmpdir(), 'f333-browser-nominate-'));
  try {
    const pinned = sharedBrowserStdioServer();
    const servers = {
      playwright: pinned,
      legacy: { command: 'npx', args: ['@playwright/mcp@latest', '--headless'] },
      edited: { command: pinned.command, args: [pinned.args[0], '--headless'] },
    };
    const out = materializeNativeMcpHttp(servers, sharedCallback(root));
    const url = new URL(String(out.playwright.url));
    assert.equal(out.playwright.type, 'http');
    assert.equal(out.playwright.command, undefined, 'no per-session Playwright process');
    assert.equal(url.origin, 'http://127.0.0.1:3004');
    assert.equal(url.pathname, SHARED_BROWSER_HTTP_PATH);
    assert.equal(out.playwright.headers['x-invocation-id'], 'inv-1');
    assert.equal(out.playwright.headers['x-callback-token'], 'token-1');
    assert.match(out.playwright.headers['x-mcp-connection-id'], /^[A-Za-z0-9_-]+$/);
    assert.deepEqual(out.legacy, servers.legacy, 'a name or npx launch is not authority');
    assert.deepEqual(out.edited, servers.edited, 'an edited launch stays as written');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('outside the shared transport the pinned launch stays an isolated stdio fallback', () => {
  const root = mkdtempSync(join(tmpdir(), 'f333-browser-fallback-'));
  try {
    const pinned = sharedBrowserStdioServer();
    const out = materializeNativeMcpHttp(
      { playwright: pinned },
      { ...sharedCallback(root), CAT_CAFE_MCP_TRANSPORT: 'stdio' },
    );
    assert.deepEqual(out.playwright, pinned);
    assert.ok(pinned.args.includes('--isolated'), 'never races the shared service for the profile lock');
    assert.ok(!pinned.args.some((arg) => arg.includes('@latest')), 'pinned, no npx lookup');
    assert.equal(isSharedBrowserStdioServer({ ...pinned, enabled: false }), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('workspace profile matches the directory upstream derives today, so logins carry over', () => {
  // Fixed upstream SHA-256 vector for a synthetic workspace; portable through the public sanitizer.
  assert.match(
    workspaceProfileDir('/example/shared-browser-workspace', 'darwin'),
    /\/Library\/Caches\/ms-playwright-mcp\/mcp-chrome-d5a082a$/,
  );
  assert.equal(workspaceProfileDir('/w', 'linux', { XDG_CACHE_HOME: '/c' }), '/c/ms-playwright-mcp/mcp-chrome-d1bb8ca');
});
