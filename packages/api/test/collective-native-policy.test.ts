import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { prepareCollectiveCodexHome } from '../src/domains/cats/services/agents/providers/collective-codex-home.js';
import { probeCollectiveCodex } from './fixtures/collective-codex-native-probe.mjs';

test('public login projection preserves canonical credential refresh without copying private context', async () => {
  const root = await mkdtemp(join(tmpdir(), 'collective-auth-projection-'));
  try {
    const original = join(root, 'original');
    await mkdir(original);
    await writeFile(join(original, 'auth.json'), '{"test":"old"}', { mode: 0o600 });
    await writeFile(join(original, 'AGENTS.md'), 'PRIVATE');
    const env = await prepareCollectiveCodexHome(join(root, 'public'), 'oauth', original);
    assert.equal(await readFile(join(env.CODEX_HOME, 'auth.json'), 'utf8'), '{"test":"old"}');
    await writeFile(join(env.CODEX_HOME, 'auth.json'), '{"test":"refreshed"}');
    assert.equal(await readFile(join(original, 'auth.json'), 'utf8'), '{"test":"refreshed"}');
    await assert.rejects(readFile(join(env.CODEX_HOME, 'AGENTS.md')));
    await assert.rejects(prepareCollectiveCodexHome(join(root, 'missing'), 'oauth', join(root, 'absent')), {
      code: 'PARTICIPATION_AUTH_UNAVAILABLE',
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test(
  'installed headless Codex mounts the seven bounded tools, uses current-context, blocks a forced native command and excludes private bytes',
  { skip: spawnSync('codex', ['--version']).status !== 0, timeout: 55000 },
  async () => {
    const probe = await probeCollectiveCodex();
    assert.equal(probe.timedOut, false, `native probe timed out: ${probe.stderr}`);
    assert.equal(probe.exitCode, 0, probe.stderr);
    const tools = probe.requests[0]?.tools;
    const collab = tools.find((tool) => tool.name === 'mcp__cat_cafe_collab');
    assert.deepEqual(collab.tools.map((tool) => tool.name).sort(), [
      'cat_cafe_collective_accept_work',
      'cat_cafe_collective_continue_work',
      'cat_cafe_collective_current_context',
      'cat_cafe_collective_propose_work',
      'cat_cafe_collective_read_context',
      'cat_cafe_collective_reply',
      'cat_cafe_collective_set_interest',
    ]);
    assert.equal(probe.callbacks.length, 1);
    assert.equal(probe.callbacks[0].headers['x-invocation-id'], 'probe-invocation');
    assert.equal(probe.callbacks[0].headers['x-callback-token'], 'probe-token');
    assert.equal(probe.requests.length, 3);
    assert.match(probe.stderr, /unsupported call: exec_command/);
    assert.equal(probe.forbiddenEffect, false);
    assert.equal(JSON.stringify(probe.requests).includes(probe.privateCanary), false);
    assert.equal(
      tools.some((tool) => /exec|shell|image|web|browser|computer|memory|spawn_agent/.test(tool.name)),
      false,
    );
  },
);

test(
  'installed code-mode-only Codex can call bounded Collective MCP without native shell or private context',
  { skip: spawnSync('codex', ['--version']).status !== 0, timeout: 55000 },
  async () => {
    const probe = await probeCollectiveCodex({ codeMode: true });
    assert.equal(probe.timedOut, false, `native probe timed out: ${probe.stderr}`);
    assert.equal(probe.exitCode, 0, probe.stderr);
    assert.equal(probe.callbacks.length, 1, probe.stderr);
    const output = JSON.stringify(probe.requests.at(-1)?.input ?? []);
    assert.match(output, /probe-context/);
    const outputItems = (
      probe.requests.at(-1)?.input as Array<{ type?: string; output?: Array<{ text?: string }> }>
    ).find((item) => item.type === 'custom_tool_call_output')?.output;
    const observations = (outputItems ?? []).flatMap((item) => {
      try {
        return item.text ? [JSON.parse(item.text) as Record<string, unknown>] : [];
      } catch {
        return [];
      }
    });
    const environment = observations.find((item) => item.shell === 'undefined');
    assert.deepEqual(environment, {
      shell: 'undefined',
      patch: 'undefined',
      process: 'undefined',
      require: 'undefined',
      fetch: 'undefined',
      WebSocket: 'undefined',
      XMLHttpRequest: 'undefined',
    });
    assert.deepEqual(observations.find((item) => Array.isArray(item.toolNames))?.toolNames, [
      'list_mcp_resource_templates',
      'list_mcp_resources',
      'mcp__cat_cafe_collab__cat_cafe_collective_accept_work',
      'mcp__cat_cafe_collab__cat_cafe_collective_continue_work',
      'mcp__cat_cafe_collab__cat_cafe_collective_current_context',
      'mcp__cat_cafe_collab__cat_cafe_collective_propose_work',
      'mcp__cat_cafe_collab__cat_cafe_collective_read_context',
      'mcp__cat_cafe_collab__cat_cafe_collective_reply',
      'mcp__cat_cafe_collab__cat_cafe_collective_set_interest',
      'read_mcp_resource',
    ]);
    assert.match(
      String(observations.find((item) => typeof item.importResult === 'string')?.importResult),
      /unsupported import in exec/,
    );
    assert.deepEqual(JSON.parse(String(observations.find((item) => item.resourceResult)?.resourceResult)), {
      resources: [],
    });
    assert.equal(output.includes(probe.privateCanary), false);
    assert.equal(probe.forbiddenEffect, false);
  },
);
