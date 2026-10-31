import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { CODEX_LIVE_POLICY_ARGS } from '../src/domains/cats/services/agents/providers/codex-live-policy.js';
import { probeCodexNativePolicy } from './fixtures/codex-native-policy-probe.mjs';

test(
  'installed Codex applies Live native restrictions while retaining an explicitly configured MCP',
  {
    skip: spawnSync('codex', ['--version']).status !== 0,
    timeout: 55_000,
  },
  async () => {
    // Reuse the synthetic local provider/MCP fixture, not its public-participation launch policy.
    // This proves native executable restrictions, not Live callback auth or its 27-tool inventory.
    const result = await probeCodexNativePolicy({ policyArgs: [...CODEX_LIVE_POLICY_ARGS, '--sandbox', 'read-only'] });
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
    const nativeTools = tools.flatMap((tool: { type: string; name: string; tools?: { name: string }[] }) =>
      tool.type === 'namespace' && !tool.name.startsWith('mcp__') ? (tool.tools ?? []) : tool,
    );
    assert.ok(tools.some((tool: { name: string }) => tool.name === 'mcp__cat_cafe_collab'));
    assert.equal(
      nativeTools.some((tool: { name: string }) =>
        /exec_command|shell|apply_patch|write_file|image|web|browser|computer/.test(tool.name),
      ),
      false,
    );
    assert.ok(
      nativeTools.some((tool: { name: string }) => tool.name === 'spawn_agent'),
      `the trial must expose a usable native child entry; toolSchema=${JSON.stringify(tools)}; ${diagnostic}`,
    );
  },
);

test(
  'installed Live policy can execute a supplied-material child and return its result without enabling effect tools',
  {
    skip: spawnSync('codex', ['--version']).status !== 0,
    timeout: 55_000,
  },
  async () => {
    const result = await probeCodexNativePolicy({
      policyArgs: [...CODEX_LIVE_POLICY_ARGS, '--sandbox', 'read-only'],
      nativeSubtask: true,
    });
    assert.equal(result.exitCode, 0, result.stderr);
    assert.equal(result.timedOut, false);
    assert.ok(result.childRequestCount > 0, `no child model request: ${result.stdout}`);
    assert.match(result.stdout, /F317_ROOT_ACK/);
    assert.equal(result.forbiddenEffect, false);
    assert.equal(result.callbacks.length, 0, 'the pure supplied-material task needs no household API calls');
    const tools = result.requests.flatMap(
      (request: { tools: { name: string; type: string; tools?: { name: string }[] }[] }) =>
        request.tools.flatMap((tool) =>
          tool.type === 'namespace' && !tool.name.startsWith('mcp__') ? (tool.tools ?? []) : tool,
        ),
    );
    assert.equal(
      tools.some((tool: { name: string }) =>
        /exec_command|shell|apply_patch|write_file|image|web|browser|computer/.test(tool.name),
      ),
      false,
    );
  },
);
