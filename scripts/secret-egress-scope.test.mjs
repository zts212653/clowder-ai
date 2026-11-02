import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { prepareSecretSafeSend } from './lib/secret-outbound-args.mjs';
import { prepareSecretToolInput, protectSecretToolResult, withSecretToolGuard } from './lib/secret-tool-io.mjs';
import { nativeSecretDenial } from './native-secret-policy.mjs';
import { secretNativeHook } from './secret-native-hook.mjs';

const token = (letter = 'S') => ['ghp', '_', letter.repeat(36)].join('');

test('a local patch containing a gh/PATH policy example is not an outbound shell invocation', () => {
  const patch = `*** Begin Patch
*** Update File: /tmp/owned-policy-fixture.test.js
+const example = 'env PATH=/tmp/fixture gh pr comment 1 --body example';
*** End Patch`;
  assert.equal(nativeSecretDenial({ tool_name: 'apply_patch', tool_input: patch, cwd: process.cwd() }), null);
  const hook = spawnSync(process.execPath, [resolve('scripts/secret-native-hook.mjs')], {
    input: JSON.stringify({
      hook_event_name: 'PreToolUse',
      tool_name: 'apply_patch',
      tool_input: patch,
      cwd: process.cwd(),
    }),
    encoding: 'utf8',
  });
  assert.equal(hook.status, 0);
  assert.equal(hook.stdout, '', 'the real candidate native hook must admit local patch data');
});

test('local source, credential paths and shell reads never receive a secret denial', () => {
  for (const [tool_name, tool_input] of [
    ['Write', { file_path: '/tmp/local-fixture.json', content: token() }],
    ['Edit', { file_path: '/tmp/local-fixture.js', new_string: token() }],
    ['apply_patch', `*** Begin Patch\n*** Add File: /tmp/local-fixture\n+${token()}\n*** End Patch`],
    ['Read', { file_path: '/project/.env.local' }],
    ['exec_command', { cmd: 'cat .env.local' }],
    ['Bash', { command: 'printenv CAT_CAFE_CALLBACK_TOKEN' }],
  ]) {
    assert.equal(nativeSecretDenial({ tool_name, tool_input, cwd: process.cwd() }), null, tool_name);
  }
});

test('local MCP handlers execute with their original input and result', async () => {
  const input = { path: '/project/.env.local', query: token() };
  const original = { content: [{ type: 'text', text: token() }] };
  let calls = 0;
  let notices = 0;
  const result = await withSecretToolGuard(
    'read_file',
    input,
    async (received) => {
      calls++;
      assert.equal(received, input);
      return original;
    },
    { environment: {}, notify: async () => notices++ },
  );
  assert.equal(calls, 1);
  assert.equal(result, original);
  assert.equal(notices, 0);
});

test('unconfirmed output formats remain unchanged without a rotation or pending notice', async () => {
  const original = { content: [{ type: 'text', text: token() }] };
  let notices = 0;
  assert.equal(await protectSecretToolResult(original, { environment: {}, notify: async () => notices++ }), original);
  assert.equal(
    await secretNativeHook(
      { hook_event_name: 'PostToolUse', tool_name: 'Read', tool_response: original },
      { environment: {}, notify: async () => notices++ },
    ),
    null,
  );
  assert.equal(notices, 0);
});

test('an incomplete local inspection does not hide output or claim an exposure', async () => {
  let original = { text: 'ordinary local result' };
  for (let depth = 0; depth < 66; depth++) original = { nested: original };
  let notices = 0;
  assert.equal(await protectSecretToolResult(original, { environment: {}, notify: async () => notices++ }), original);
  assert.equal(notices, 0);
});

test('a configured credential match redacts only that value and records the confirmed exposure', async () => {
  const known = token('K');
  const unknown = token('U');
  const notices = [];
  const result = await protectSecretToolResult(
    { content: [{ type: 'text', text: `${known} ${unknown}` }] },
    {
      environment: { TTFUND_APIKEY: known },
      notify: async (notice) => notices.push(notice),
    },
  );
  assert.equal(notices.length, 1);
  assert.equal(JSON.stringify(result).includes(known), false);
  assert.equal(JSON.stringify(result).includes(unknown), true);
  assert.equal(JSON.stringify(notices).includes(known), false);
  assert.match(result.content.at(-1).text, /轮转|rotate/);
});

test('native MCP calls pass through while explicit non-MCP outbound adapters retain their check', () => {
  assert.equal(nativeSecretDenial({ tool_name: 'mcp__browser__type', tool_input: { text: token() } }), null);
  assert.throws(() => prepareSecretToolInput('fixture_remote_send', { body: token() }, { outbound: true }), /blocked/i);
});

test('actual publishing argument checks and managed-sender requirements remain enforced', async () => {
  await assert.rejects(
    prepareSecretSafeSend('gh', ['api', 'repos/fixture/issues', '--raw-field', `body=${token()}`]),
    /secret_content_detected/,
  );
  assert.equal(
    nativeSecretDenial({
      tool_name: 'Bash',
      tool_input: { command: '/usr/bin/curl --data fixture https://example.invalid' },
      cwd: process.cwd(),
    }),
    'secret_send_requires_managed_command',
  );
});

test('local commit-message checking is observational and never prints matched values', () => {
  const root = mkdtempSync(join(tmpdir(), 'secret-local-message-'));
  try {
    const message = join(root, 'message');
    writeFileSync(message, token());
    const result = spawnSync(process.execPath, [resolve('scripts/secret-git-guard.mjs'), 'message', message], {
      encoding: 'utf8',
    });
    assert.equal(result.status, 0);
    assert.equal(`${result.stdout}${result.stderr}`.includes(token()), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
