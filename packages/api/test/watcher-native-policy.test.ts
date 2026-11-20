import assert from 'node:assert/strict';
import { test } from 'node:test';
import { codexWatcherPolicyArgs } from '../src/domains/cats/services/agents/providers/codex-watcher-policy.js';
import { probeCodexNativePolicy } from './fixtures/codex-native-policy-probe.mjs';

test(
  'installed Codex ordinary watcher policy keeps selected MCP and removes native effect tools',
  { timeout: 55000 },
  async () => {
    // Real binary against an owned local protocol fixture. No real model, account, or runtime endpoint.
    const result = await probeCodexNativePolicy({
      policyArgs: [...codexWatcherPolicyArgs(false), '--config', 'sandbox_mode="read-only"'],
      carrier: 'app_server',
    });
    assert.equal(result.timedOut, false);
    assert.equal(result.exitCode, 0, result.stderr);
    assert.equal(result.callbacks.length, 1, 'the selected MCP tool must actually run');
    assert.equal(result.forbiddenEffect, false);
    const tools = result.requests[0].tools.flatMap(
      (tool: { type: string; name: string; tools?: { name: string }[] }) =>
        tool.type === 'namespace' && !tool.name.startsWith('mcp__') ? (tool.tools ?? []) : [tool],
    );
    assert.ok(tools.some((tool: { name: string }) => tool.name.startsWith('mcp__')));
    assert.equal(
      tools.some((tool: { name: string }) =>
        /exec_command|shell|apply_patch|spawn_agent|write_file|browser|computer/.test(tool.name),
      ),
      false,
    );
  },
);
