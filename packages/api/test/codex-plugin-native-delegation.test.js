import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { resolveCliCommand } from '../dist/utils/cli-resolve.js';
import { pluginNativeCliFixture } from './helpers/plugin-native-cli-fixture.js';

const cli = process.env.F329_CODEX_CLI ?? resolveCliCommand('codex');
const available = cli !== null && spawnSync(cli, ['--version'], { timeout: 5000 }).status === 0;

for (const kind of ['scoped-member', 'public'])
  for (const model of ['gpt-6-astra', 'gpt-6.1-sol']) {
    test(
      `${kind} ${model}: admitted MCP works and native delegation cannot create child requests`,
      { timeout: 45000, skip: !available },
      async () => {
        const r = await pluginNativeCliFixture({ model, kind, cli });
        assert.equal(r.timedOut, false, r.stderr);
        assert.equal(r.status.code, 0, r.stderr);
        assert.equal(r.fixtureClosed, true, 'CLI, loopback server and temporary private homes must close');
        assert.ok(
          r.requests.every((q) => typeof q.agentName === 'string'),
          'child detection requires actual native agent metadata',
        );
        assert.ok(
          r.requests.every((q) => q.body.model === model),
          'the requested model mode must reach Responses',
        );
        assert.equal(r.mcpCalls, 1, 'admitted MCP positive control must execute exactly once');
        assert.match(JSON.stringify(r.outputs), /F329_MCP_POSITIVE/);
        assert.equal(r.childRequests, 0, 'native direct or nested delegation created a child Responses request');
        assert.ok(r.wireTools.includes('functions.exec'), 'the real code-mode dispatcher must remain registered');
        assert.ok(
          r.wireTools.every((name) => !/collaboration|multi_agent|spawn_agent/.test(name)),
          JSON.stringify(r.wireTools),
        );
        // Deliberate native-CLI canaries: inspect new tools or protocol rounds before updating these expectations.
        // An upgrade failure is never a reason to silently allow a new delegation entry.
        assert.equal(r.parentRequests, 5, 'all parent probe rounds must complete');
        const direct = r.outputs.filter((o) => o.type === 'function_call_output');
        assert.equal(direct.length, 2, 'both V2 and legacy direct calls must return an explicit denial');
        for (const output of direct)
          assert.match(JSON.stringify(output), /unsupported|disabled|not allowed|not enabled/i);
        const nested = r.outputs.filter((o) => o.type === 'custom_tool_call_output');
        const wire = JSON.stringify(nested);
        assert.match(wire, /nestedDelegationNames/);
        assert.doesNotMatch(wire, /"nestedResult"|"directNestedResult"/);
        const inventories = nested
          .flatMap((o) => o.output)
          .map((o) => o.text)
          .filter((s) => s?.startsWith('{"toolNames"'))
          .map((s) => JSON.parse(s).toolNames);
        assert.equal(inventories.length, 2, 'enumerate the actual nested table before and after direct denial');
        for (const names of inventories)
          assert.deepEqual(names, [
            'apply_patch',
            'clock__curr_time',
            'list_mcp_resource_templates',
            'list_mcp_resources',
            'mcp__plugin_fixture__probe',
            'read_mcp_resource',
          ]);
      },
    );
  }

for (const model of ['gpt-6-astra', 'gpt-6.1-sol']) {
  test(
    `${model}: removing only the new delegation fence really creates a child request`,
    { timeout: 45000, skip: !available },
    async () => {
      const r = await pluginNativeCliFixture({ model, cli, omitDelegationFence: true });
      assert.equal(r.timedOut, false, r.stderr);
      assert.equal(r.status.code, 0, r.stderr);
      assert.equal(r.fixtureClosed, true);
      assert.equal(r.mcpCalls, 1, 'ablation must keep the admitted MCP positive control');
      assert.match(JSON.stringify(r.outputs), /F329_MCP_POSITIVE/);
      assert.ok(r.requests.every((q) => typeof q.agentName === 'string' && q.body.model === model));
      assert.ok(r.wireTools.includes('collaboration.spawn_agent'), 'the attack name must be a real registered tool');
      assert.equal(r.childRequests, 1, 'the unfenced native tool must reach the local provider child boundary');
      assert.ok(r.requests.some((q) => q.child && q.agentName === '/root/forbidden_child'));
      assert.match(JSON.stringify(r.outputs), /\/root\/forbidden_child/);
    },
  );
}
