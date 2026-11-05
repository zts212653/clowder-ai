import assert from 'node:assert/strict';
import { test } from 'node:test';
import { restrictWatcherLaunch } from '../../src/infrastructure/harness-eval/watcher-offline/launch.js';

test('Codex read-only cannot inherit project knowledge or execute native tools during a replay', () => {
  const original = {
    command: 'codex',
    args: ['exec', '--json', '--sandbox', 'read-only', '--', '-'],
    stdinInput: 'frozen case',
  };
  const result = restrictWatcherLaunch('openai', original);
  const optionArgs = result.args.slice(0, result.args.indexOf('--'));
  assert.ok(optionArgs.includes('project_doc_max_bytes=0'));
  assert.ok(optionArgs.includes('features.shell_tool=false'));
  assert.ok(optionArgs.includes('features.multi_agent=false'));
  assert.ok(optionArgs.includes('mcp_servers={}'));
  assert.ok(optionArgs.includes('permissions.watcher_offline.network={enabled=false}'));
  assert.equal(optionArgs.includes('features.hooks=false'), false);
  assert.equal(
    optionArgs.includes('--sandbox'),
    false,
    'legacy read-only must not override the stricter named profile',
  );
  assert.deepEqual(result.args.slice(-2), ['--', '-']);
  assert.equal(result.stdinInput, original.stdinInput);
});

test('Claude starts without current memory/customizations and keeps its existing zero-tool policy', () => {
  const result = restrictWatcherLaunch('anthropic', {
    command: 'claude',
    args: ['-p', '--tools', '', '--strict-mcp-config', '--permission-mode', 'plan'],
  });
  assert.ok(result.args.includes('--safe-mode'));
  assert.equal(result.args[result.args.indexOf('--tools') + 1], '');
  assert.ok(result.args.includes('--strict-mcp-config'));
  assert.equal(result.args.includes('--dangerously-skip-permissions'), false);
});

test('managed Codex flags are not duplicated when adding the offline boundary', () => {
  const original = {
    command: 'codex',
    args: ['exec', '--ignore-user-config', '--ephemeral', '--sandbox', 'read-only', '--', '-'],
  };
  const result = restrictWatcherLaunch('openai', original);
  assert.equal(result.args.filter((arg) => arg === '--ignore-user-config').length, 1);
  assert.equal(result.args.filter((arg) => arg === '--ephemeral').length, 1);
});
