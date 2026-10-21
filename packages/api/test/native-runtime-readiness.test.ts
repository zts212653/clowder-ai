import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { nativeAuthenticationStatus, nativeRuntimeReadiness } from '../src/routes/native-runtime-readiness.js';

test('login probe honors the shell required by a Windows fallback spawn plan', async () => {
  const root = mkdtempSync(join(tmpdir(), 'native-login-shell-'));
  const command = join(root, process.platform === 'win32' ? 'fake-claude.cmd' : 'fake-claude.sh');
  const marker = join(root, 'called.json');
  const script = join(root, 'status.cjs');
  writeFileSync(
    script,
    `require('node:fs').writeFileSync(${JSON.stringify(marker)},JSON.stringify(process.argv.slice(2)));console.log('{"loggedIn":true}');`,
  );
  writeFileSync(
    command,
    process.platform === 'win32'
      ? `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`
      : `#!/bin/sh\n"${process.execPath}" "${script}" "$@"\n`,
  );
  chmodSync(command, 0o755);
  const keys = ['CLAUDE_CONFIG_DIR', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'];
  const original = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  try {
    process.env.CLAUDE_CONFIG_DIR = root;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_AUTH_TOKEN;
    const result = await nativeRuntimeReadiness({ id: 'claude', installed: true, command }, root);
    assert.equal(result.status, 'configured');
    assert.deepEqual(JSON.parse(readFileSync(marker, 'utf8')), ['auth', 'status', '--json']);
  } finally {
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
  }
});

test('Claude login status accepts JSON when the CLI writes a warning to stderr', async () => {
  const root = mkdtempSync(join(tmpdir(), 'native-claude-warning-'));
  const command = join(root, process.platform === 'win32' ? 'fake-claude.cmd' : 'fake-claude.sh');
  const script = join(root, 'status.cjs');
  writeFileSync(
    script,
    `console.error('WARNING: PATH alias unavailable - private-sentinel');console.log(JSON.stringify({loggedIn:true}));`,
  );
  writeFileSync(
    command,
    process.platform === 'win32'
      ? `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`
      : `#!/bin/sh\n"${process.execPath}" "${script}" "$@"\n`,
  );
  chmodSync(command, 0o755);
  const previous = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = root;
  try {
    const result = await nativeRuntimeReadiness({ id: 'claude', installed: true, command }, root, true);
    assert.equal(result.status, 'configured');
    assert.doesNotMatch(JSON.stringify(result), /private-sentinel/);
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test('installed is not authenticated; supported CLIs report missing login before a model turn', () => {
  assert.equal(nativeAuthenticationStatus('claude', { loggedIn: false }), 'login_required');
  assert.equal(nativeAuthenticationStatus('codex', { account: null, requiresOpenaiAuth: true }), 'login_required');
});
test('recognizes native login without returning its credentials or declaring model availability', () => {
  assert.equal(
    nativeAuthenticationStatus('claude', { loggedIn: true, email: 'private', authMethod: 'api_key' }),
    'configured',
  );
  assert.equal(nativeAuthenticationStatus('codex', { account: { type: 'chatgpt', email: 'private' } }), 'configured');
  assert.equal(nativeAuthenticationStatus('codex', { account: { type: 'apiKey' } }), 'configured');
  assert.equal(nativeAuthenticationStatus('codex', { account: null, requiresOpenaiAuth: false }), 'configured');
});
test('unsupported ACP auth and malformed observations remain unknown rather than usable', () => {
  for (const input of [null, {}, { loggedIn: 'true' }, { account: {} }]) {
    assert.equal(nativeAuthenticationStatus('claude', input), 'unknown');
    assert.equal(nativeAuthenticationStatus('codex', input), 'unknown');
  }
  assert.equal(nativeAuthenticationStatus('dsh', { loggedIn: true }), 'unknown');
});
