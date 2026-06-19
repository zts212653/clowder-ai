/**
 * check:env-registry — CI gate for env var registration completeness.
 *
 * Scans `packages/api/src` and `packages/mcp-server/src` for `process.env.XXX`
 * references and verifies each is either:
 *   1. Registered in `env-registry.ts` ENV_VARS array, OR
 *   2. Listed in the ALLOWLIST below (with a reason).
 *
 * Run: `node --test scripts/check-env-registry.test.mjs`
 * Wire: `pnpm check:env-registry` in root package.json
 */

import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, it } from 'node:test';

const ROOT = resolve(import.meta.dirname, '..');

// ── Allowlist: vars used in code that should NOT be in env-registry ──
// Each entry MUST have a reason (enforced by test below).
const ALLOWLIST = new Map([
  ['HOME', 'OS-provided home directory'],
  ['SHELL', 'OS-provided shell path'],
  ['PATH', 'OS-provided executable search path'],
  ['USER', 'OS-provided username'],
  ['USERNAME', 'Windows OS-provided username'],
  ['USERPROFILE', 'Windows OS-provided home directory (F212 sanitizer path redaction)'],
  ['LANG', 'OS-provided locale'],
  ['LC_ALL', 'OS-provided locale override'],
  ['APPDATA', 'Windows OS variable (cli-spawn-win.ts)'],
  ['LOCALAPPDATA', 'Windows OS variable (cli-resolve.ts)'],
  ['SYSTEMROOT', 'Windows OS variable (project-path.ts)'],
  ['PROGRAMFILES', 'Windows OS variable (ImageExporter.ts Chrome detection)'],
  ['PATHEXT', 'Windows OS variable (capability-orchestrator.ts executable extension lookup)'],
  ['NODE_ENV', 'Node.js standard'],
  ['https_proxy', 'Standard proxy convention (lowercase variant of HTTPS_PROXY)'],
  ['http_proxy', 'Standard proxy convention (lowercase variant of HTTP_PROXY)'],
  ['all_proxy', 'Standard proxy convention (lowercase variant of ALL_PROXY)'],
  ['npm_execpath', 'Package-manager metadata injected by npm/pnpm; not user-configurable'],
  ['npm_config_user_agent', 'Package-manager metadata injected by npm/pnpm; not user-configurable'],
  ['INIT_CWD', 'Package-manager metadata injected by npm/pnpm; original invocation directory'],
  ['COGVIDEO_API_KEY', 'F139 MediaHub CogVideoX provider — mcp-server-local credential'],
  // F240: Per-connector env vars migrated to YAML manifests (connector.yaml / plugin.yaml).
  // Runtime still reads process.env as fallback in resolveConnectorEnv() chain, but
  // documentation/display is now driven by the YAML config.fields declarations.
  ['TELEGRAM_BOT_TOKEN', 'F240: defined in connectors/telegram/connector.yaml'],
  ['FEISHU_APP_ID', 'F240: defined in connectors/feishu/connector.yaml'],
  ['FEISHU_APP_SECRET', 'F240: defined in connectors/feishu/connector.yaml'],
  ['FEISHU_VERIFICATION_TOKEN', 'F240: defined in connectors/feishu/connector.yaml'],
  ['FEISHU_BOT_OPEN_ID', 'F240: defined in connectors/feishu/connector.yaml'],
  ['FEISHU_ADMIN_OPEN_IDS', 'F240: defined in connectors/feishu/connector.yaml'],
  ['FEISHU_CONNECTION_MODE', 'F240: defined in connectors/feishu/connector.yaml'],
  ['DINGTALK_APP_KEY', 'F240: defined in connectors/dingtalk/connector.yaml'],
  ['DINGTALK_APP_SECRET', 'F240: defined in connectors/dingtalk/connector.yaml'],
  ['XIAOYI_AK', 'F240: defined in connectors/xiaoyi/connector.yaml'],
  ['XIAOYI_SK', 'F240: defined in connectors/xiaoyi/connector.yaml'],
  ['XIAOYI_AGENT_ID', 'F240: defined in connectors/xiaoyi/connector.yaml'],
  ['WEIXIN_BOT_TOKEN', 'F240: defined in connectors/weixin/connector.yaml'],
  ['WECOM_BOT_ID', 'F240: defined in connectors/wecom/connector.yaml'],
  ['WECOM_BOT_SECRET', 'F240: defined in connectors/wecom/connector.yaml'],
  ['WECOM_CORP_ID', 'F240: defined in connectors/wecom/connector.yaml'],
  ['WECOM_AGENT_ID', 'F240: defined in connectors/wecom/connector.yaml'],
  ['WECOM_AGENT_SECRET', 'F240: defined in connectors/wecom/connector.yaml'],
  ['WECOM_TOKEN', 'F240: defined in connectors/wecom/connector.yaml'],
  ['WECOM_ENCODING_AES_KEY', 'F240: defined in connectors/wecom/connector.yaml'],
  ['GITHUB_AUTHORITATIVE_REVIEW_LOGINS', 'F240: deprecated, defined in plugins/github/plugin.yaml'],
  ['GITHUB_SETUP_NOISE_BOT_LOGINS', 'F240: defined in plugins/github/plugin.yaml'],
  ['GITHUB_TOKEN', 'F240: defined in plugins/github/plugin.yaml'],
]);

// ── Extract registered names from env-registry.ts ──
function loadRegisteredNames() {
  const src = readFileSync(join(ROOT, 'packages/api/src/config/env-registry.ts'), 'utf-8');
  const names = new Set();
  // Match: name: 'VAR_NAME' or name: "VAR_NAME"
  for (const m of src.matchAll(/name:\s*['"]([A-Z_][A-Z0-9_]*)['"],?/g)) {
    names.add(m[1]);
  }
  return names;
}

// ── Recursively collect .ts files ──
function collectTsFiles(dir) {
  const results = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory() && entry.name !== 'node_modules') {
      results.push(...collectTsFiles(full));
    } else if (entry.isFile() && entry.name.endsWith('.ts')) {
      results.push(full);
    }
  }
  return results;
}

// ── Extract process.env references from source files ──
function extractEnvRefs(dirs) {
  /** @type {Map<string, string[]>} varName → [file:line, ...] */
  const refs = new Map();

  for (const dir of dirs) {
    const absDir = join(ROOT, dir);
    try {
      statSync(absDir);
    } catch {
      continue;
    }
    for (const file of collectTsFiles(absDir)) {
      const lines = readFileSync(file, 'utf-8').split('\n');
      let inBlockComment = false;
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const trimmed = line.trimStart();
        // Track multi-line block comments
        if (inBlockComment) {
          if (line.includes('*/')) {
            inBlockComment = false;
          }
          continue;
        }
        // Single-line block comment: /** ... */ or /* ... */ on one line
        if (trimmed.startsWith('/*') && line.includes('*/')) continue;
        // Start of multi-line block comment (no closing on same line)
        if (trimmed.startsWith('/*')) {
          inBlockComment = true;
          continue;
        }
        // Skip pure line comments
        if (trimmed.startsWith('//')) continue;
        // Strip inline comments before matching (trailing // and inline /* */)
        const code = line.replace(/\/\/.*$/, '').replace(/\/\*.*?\*\//g, '');
        // Match process.env.VAR_NAME and process.env['VAR_NAME']
        const dotMatches = code.matchAll(/process\.env\.([A-Za-z_][A-Za-z0-9_]*)/g);
        const bracketMatches = code.matchAll(/process\.env\[['"]([A-Za-z_][A-Za-z0-9_]*)['"]\]/g);
        for (const m of [...dotMatches, ...bracketMatches]) {
          const name = m[1];
          if (!refs.has(name)) refs.set(name, []);
          refs.get(name).push(`${file.replace(ROOT + '/', '')}:${i + 1}`);
        }
      }
    }
  }

  return refs;
}

// ── Tests ──
describe('env-registry completeness', () => {
  const registeredNames = loadRegisteredNames();
  const envRefs = extractEnvRefs(['packages/api/src', 'packages/mcp-server/src']);
  const repoInboxEnvNames = ['GITHUB_WEBHOOK_SECRET', 'GITHUB_REPO_ALLOWLIST', 'GITHUB_REPO_INBOX_CAT_ID'];
  const githubSelfFilterEnvNames = ['GITHUB_SELF_LOGIN'];
  const weixinRuntimeFlagNames = [
    'WEIXIN_VOICE_ITEM_MODE',
    'WEIXIN_ENABLE_UNSAFE_VOICE_MODES',
    'WEIXIN_CAPTURE_INBOUND_VOICE_MEDIA',
  ];

  it('every allowlist entry has a non-empty reason', () => {
    for (const [name, reason] of ALLOWLIST) {
      assert.ok(reason && reason.length > 0, `ALLOWLIST entry "${name}" has no reason`);
    }
  });

  it('keeps GitHub Repo Inbox process env vars in env-registry', () => {
    for (const name of repoInboxEnvNames) {
      assert.ok(registeredNames.has(name), `${name} should be registered in env-registry.ts`);
      assert.ok(!ALLOWLIST.has(name), `${name} is runtime user config and must not be allowlisted`);
    }
  });

  it('keeps GitHub feedback self-filter fallback in env-registry', () => {
    for (const name of githubSelfFilterEnvNames) {
      assert.ok(registeredNames.has(name), `${name} should be registered in env-registry.ts`);
      assert.ok(!ALLOWLIST.has(name), `${name} is runtime user config and must not be allowlisted`);
    }
  });

  it('keeps Weixin runtime voice flags in env-registry', () => {
    for (const name of weixinRuntimeFlagNames) {
      assert.ok(registeredNames.has(name), `${name} should stay registered; it is not a connector credential`);
      assert.ok(!ALLOWLIST.has(name), `${name} is not declared in connectors/weixin/connector.yaml`);
    }
  });

  it('every process.env.XXX is registered or allowlisted', () => {
    const missing = [];
    for (const [name, locations] of envRefs) {
      if (!registeredNames.has(name) && !ALLOWLIST.has(name)) {
        missing.push({ name, locations: locations.slice(0, 3) });
      }
    }
    if (missing.length > 0) {
      const lines = missing.map((m) => `  ${m.name} (${m.locations.join(', ')})`);
      assert.fail(
        `${missing.length} env var(s) used in code but not registered in env-registry.ts:\n` +
          lines.join('\n') +
          '\n\nFix: add to ENV_VARS in packages/api/src/config/env-registry.ts, ' +
          'or add to ALLOWLIST in this script with a reason.',
      );
    }
  });

  it('no allowlist entry that is actually registered (redundant)', () => {
    const redundant = [];
    for (const name of ALLOWLIST.keys()) {
      if (registeredNames.has(name)) {
        redundant.push(name);
      }
    }
    if (redundant.length > 0) {
      assert.fail(`These ALLOWLIST entries are already registered (remove from allowlist): ${redundant.join(', ')}`);
    }
  });
});
