import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { CODEX_LIVE_POLICY_ARGS } from '../src/domains/cats/services/agents/providers/codex-live-policy.js';
import { probeCollectiveCodex } from './fixtures/collective-codex-native-probe.mjs';

test(
  'installed Codex applies Live native restrictions while retaining an explicitly configured MCP',
  {
    skip: spawnSync('codex', ['--version']).status !== 0,
    timeout: 55_000,
  },
  async () => {
    // Reuse the synthetic local provider/MCP fixture, not its public-participation launch policy.
    // This proves native executable restrictions, not Live callback auth or its 27-tool inventory.
    const result = await probeCollectiveCodex({ policyArgs: [...CODEX_LIVE_POLICY_ARGS, '--sandbox', 'read-only'] });
    const diagnostic = `timing=${JSON.stringify(result.timing)} requests=${result.requests.length} callbacks=${result.callbacks.length} stdout=${result.stdout.slice(-2000)} stderr=${result.stderr.slice(-2000)}`;
    assert.equal(result.timedOut, false, `native probe timed out: ${diagnostic}`);
    assert.equal(result.exitCode, 0, result.stderr);
    assert.equal(
      result.callbacks.length,
      1,
      `positive control: selected MCP still runs; tools=${JSON.stringify(result.requests[0]?.tools?.map((tool: { name: string }) => tool.name))}; ${diagnostic}`,
    );
    assert.equal(result.forbiddenEffect, false);
    assert.match(result.stderr, /unsupported call: exec_command/);
    const tools = result.requests[0].tools;
    assert.ok(tools.some((tool: { name: string }) => tool.name === 'mcp__cat_cafe_collab'));
    assert.equal(
      tools.some((tool: { name: string }) => /exec|shell|image|web|browser|computer|spawn_agent/.test(tool.name)),
      false,
    );
  },
);
