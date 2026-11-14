import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { readInvocationMcpConfig } from '../dist/config/capabilities/invoke-mcp-config.js';
import {
  SHARED_BROWSER_HTTP_PATH,
  sharedBrowserStdioServer,
} from '../dist/domains/browser/shared-browser-descriptor.js';
import { resolveAcpMcpServers } from '../dist/domains/cats/services/agents/providers/acp/acp-mcp-resolver.js';
import {
  captureSessionMcpServers,
  materializeSessionMcpServers,
} from '../dist/domains/cats/services/agents/providers/acp/acp-session-env.js';
import { codexNativeMcpThreadConfig } from '../dist/domains/cats/services/agents/providers/codex-config-overrides.js';
import { resolveKimiMcpSurface } from '../dist/domains/cats/services/agents/providers/kimi-mcp-surface.js';
import { buildOpenCodeMcpSync } from '../dist/domains/cats/services/agents/providers/opencode-mcp-injection.js';
import { resolveProviderMcpConfig } from '../dist/domains/cats/services/agents/providers/provider-mcp-config.js';

const PLAYWRIGHT = {
  id: 'playwright',
  type: 'mcp',
  source: 'external',
  enabled: true,
  globalEnabled: true,
  mcpServer: { command: '', args: [], resolver: 'shared-browser' },
};

function fixture(t) {
  const make = () => {
    const p = mkdtempSync(join(tmpdir(), 'f333-browser-carriers-'));
    t.after(() => rmSync(p, { recursive: true, force: true }));
    mkdirSync(join(p, '.cat-cafe'));
    writeFileSync(join(p, '.cat-cafe/capabilities.json'), JSON.stringify({ version: 2, capabilities: [PLAYWRIGHT] }));
    return p;
  };
  const host = make();
  const project = make();
  const credential = join(host, 'turn.json');
  writeFileSync(credential, JSON.stringify({ invocationId: 'inv-1', callbackToken: 'tok-1' }), { mode: 0o600 });
  const shared = {
    CAT_CAFE_CAT_ID: 'opus55',
    CAT_CAFE_API_URL: 'http://127.0.0.1:3004',
    CAT_CAFE_INVOCATION_ID: 'inv-1',
    CAT_CAFE_CALLBACK_TOKEN: 'tok-1',
    CAT_CAFE_CREDENTIAL_FILE: credential,
    CAT_CAFE_MCP_TRANSPORT: 'shared',
  };
  return { host, project, shared, mcpServerPath: join(host, 'packages/mcp-server/dist/index.js') };
}

function assertSharedRoute(entry, label) {
  assert.ok(entry, `${label}: playwright is present`);
  const url = new URL(String(entry.url ?? entry.serverUrl));
  assert.equal(url.pathname, SHARED_BROWSER_HTTP_PATH, `${label}: routed to the shared browser`);
  assert.equal(entry.command, undefined, `${label}: no per-session Playwright process`);
}

test('Claude/AGY and Kimi resolve playwright to the shared route under the shared transport', async (t) => {
  const { project, shared, mcpServerPath } = fixture(t);
  const claude = await resolveProviderMcpConfig({ workingDirectory: project, mcpServerPath, callbackEnv: shared });
  assertSharedRoute(claude.playwright, 'claude');
  assert.equal(claude.playwright.headers['x-invocation-id'], 'inv-1');
  const nativeDirectory = mkdtempSync(join(tmpdir(), 'f333-kimi-native-'));
  t.after(() => rmSync(nativeDirectory, { recursive: true, force: true }));
  const kimi = await resolveKimiMcpSurface({
    workingDirectory: project,
    mcpServerPath,
    callbackEnv: shared,
    nativeDirectory,
  });
  assertSharedRoute(kimi.playwright, 'kimi');
});

test('ACP and Codex app-server nominate the same pinned launch to the shared route', async (t) => {
  const { host, project, shared } = fixture(t);
  const config = readInvocationMcpConfig(host, project).config;
  const acp = await resolveAcpMcpServers(host, ['playwright'], undefined, {
    capabilitiesConfig: config,
    configSourceRoot: project,
  });
  const [acpEntry] = materializeSessionMcpServers(captureSessionMcpServers(acp), shared);
  assert.equal(acpEntry.type, 'http');
  assert.equal(new URL(acpEntry.url).pathname, SHARED_BROWSER_HTTP_PATH);

  // Codex writes the stdio launch as CLI config, then nominates it in the private thread RPC.
  const pinned = sharedBrowserStdioServer();
  const args = [
    '--config',
    `mcp_servers.playwright.command=${JSON.stringify(pinned.command)}`,
    '--config',
    `mcp_servers.playwright.args=[${pinned.args.map((arg) => JSON.stringify(arg)).join(', ')}]`,
    '--config',
    'mcp_servers.playwright.enabled=true',
  ];
  const servers = codexNativeMcpThreadConfig(args, shared).mcp_servers;
  // Codex deep-merges this over its own config files, which may already hold a stdio `playwright`
  // table (2026-11-09 incident): the shared route gets its own name, and `playwright` stays a
  // complete, disabled stdio table so the merge is valid whether or not that table exists.
  const codex = servers.playwright_shared;
  assert.equal(new URL(codex.url).pathname, SHARED_BROWSER_HTTP_PATH, 'codex: routed to the shared browser');
  assert.equal(codex.http_headers['x-invocation-id'], 'inv-1');
  assert.deepEqual(servers.playwright, { command: pinned.command, args: pinned.args, enabled: false });
  assert.equal(servers.playwright.url, undefined, 'never a url next to a command');
});

/** TOML literal for -c overrides; JSON strings, arrays and inline tables are valid TOML here. */
const tomlValue = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? `{ ${Object.entries(value)
        .map(([k, v]) => `${JSON.stringify(k)} = ${tomlValue(v)}`)
        .join(', ')} }`
    : JSON.stringify(value);

function codexBinary() {
  try {
    return execFileSync('sh', ['-c', 'command -v codex'], { encoding: 'utf8' }).trim() || undefined;
  } catch {
    return undefined;
  }
}

test(
  'the real codex binary loads the Codex thread config over an account config that already has playwright (2026-11-09 incident)',
  {
    skip: codexBinary() ? false : 'codex is not installed here',
  },
  async (t) => {
    const { shared } = fixture(t);
    const pinned = sharedBrowserStdioServer();
    const args = [
      '--config',
      `mcp_servers.playwright.command=${JSON.stringify(pinned.command)}`,
      '--config',
      `mcp_servers.playwright.args=[${pinned.args.map((arg) => JSON.stringify(arg)).join(', ')}]`,
      '--config',
      'mcp_servers.playwright.enabled=true',
    ];
    const overrides = Object.entries(codexNativeMcpThreadConfig(args, shared).mcp_servers).flatMap(([name, server]) =>
      Object.entries(server).flatMap(([key, value]) => ['-c', `mcp_servers.${name}.${key}=${tomlValue(value)}`]),
    );
    const legacy = '[mcp_servers.playwright]\ncommand = "npx"\nargs = [ "@playwright/mcp@latest", "--headless" ]\n';
    for (const [label, accountConfig] of [
      ['with a legacy playwright table', legacy],
      ['without one', ''],
    ]) {
      const home = mkdtempSync(join(tmpdir(), 'f333-codex-home-'));
      t.after(() => rmSync(home, { recursive: true, force: true }));
      writeFileSync(join(home, 'config.toml'), accountConfig);
      const listed = JSON.parse(
        execFileSync(codexBinary(), [...overrides, 'mcp', 'list', '--json'], {
          encoding: 'utf8',
          env: { ...process.env, CODEX_HOME: home },
        }),
      );
      const byName = Object.fromEntries(listed.map((server) => [server.name, server]));
      assert.equal(byName.playwright.enabled, false, `${label}: the stdio table is disabled`);
      assert.equal(byName.playwright_shared.enabled, true, label);
      assert.equal(byName.playwright_shared.transport.type, 'streamable_http', label);
      assert.equal(new URL(byName.playwright_shared.transport.url).pathname, SHARED_BROWSER_HTTP_PATH, label);
      assert.ok(existsSync(join(home, 'config.toml')), 'the account config is read, not rewritten');
    }
  },
);

test('carriers that stay on stdio get the pinned isolated fallback, never npx or the shared profile', async (t) => {
  const { host, project, shared, mcpServerPath } = fixture(t);
  const scoped = await resolveProviderMcpConfig({
    workingDirectory: project,
    mcpServerPath,
    callbackEnv: { ...shared, CAT_CAFE_MCP_TRANSPORT: 'stdio' },
  });
  assert.deepEqual(scoped.playwright.args, sharedBrowserStdioServer().args);
  assert.ok(scoped.playwright.args.includes('--isolated'));
  const openCode = buildOpenCodeMcpSync(mcpServerPath, 'opus55', host, project);
  assert.ok(openCode.playwright.command.includes('--isolated'), 'opencode falls back to isolated');
  assert.ok(!openCode.playwright.command.some((part) => String(part).includes('@latest')));
});
