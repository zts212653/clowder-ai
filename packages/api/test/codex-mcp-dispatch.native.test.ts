import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
// @ts-expect-error The installed-CLI fixture is an untyped local .mjs helper.
import { probeCodexNativePolicy } from './fixtures/codex-native-policy-probe.mjs';

const available = spawnSync('codex', ['--version'], { timeout: 5_000 }).status === 0;

for (const qualified of [false, true]) {
  test(
    `Codex MCP ${qualified ? 'dispatches the registered namespace' : 'rejects a bare short name'} with file credentials`,
    { skip: !available, timeout: 55_000 },
    async () => {
      const result = await probeCodexNativePolicy({
        carrier: 'app_server',
        credentialFile: true,
        requestedCall: ({ ordinal }: { ordinal: number }) =>
          ordinal === 1
            ? {
                type: 'function_call',
                id: 'fc_mcp_probe',
                call_id: 'call_mcp_probe',
                ...(qualified ? { namespace: 'mcp__cat_cafe_collab' } : {}),
                name: 'cat_cafe_get_thread_context',
                arguments: '{}',
              }
            : undefined,
      });
      assert.equal(result.timedOut, false);
      assert.equal(result.exitCode, 0, result.stderr);
      assert.ok(result.requests[0]?.tools.some((tool: { name: string }) => tool.name === 'mcp__cat_cafe_collab'));
      assert.equal(result.callbacks.length, qualified ? 1 : 0);
      if (qualified) {
        assert.equal(result.callbacks[0].headers['x-callback-token'], 'probe-token');
        assert.match(JSON.stringify(result.requests.slice(1)), /probe-thread/);
        assert.doesNotMatch(result.stderr, /unsupported call/);
      } else {
        assert.match(JSON.stringify(result.requests.slice(1)), /unsupported call: cat_cafe_get_thread_context/);
      }
    },
  );
}

test(
  'Codex code mode discovers and calls the registered MCP key with file credentials',
  { skip: !available, timeout: 55_000 },
  async () => {
    const result = await probeCodexNativePolicy({
      carrier: 'app_server',
      credentialFile: true,
      codeMode: true,
      requestedCall: ({ ordinal }: { ordinal: number }) =>
        ordinal === 1
          ? {
              type: 'custom_tool_call',
              id: 'fc_mcp_code_probe',
              call_id: 'call_mcp_code_probe',
              namespace: 'functions',
              name: 'exec',
              input:
                "const entry = ALL_TOOLS.find(x => x.name === 'mcp__cat_cafe_collab__cat_cafe_get_thread_context'); text(await tools[entry.name]({}));",
            }
          : undefined,
    });
    assert.equal(result.timedOut, false);
    assert.equal(result.exitCode, 0, result.stderr);
    assert.equal(result.callbacks.length, 1);
    assert.equal(result.callbacks[0].headers['x-callback-token'], 'probe-token');
    assert.match(JSON.stringify(result.requests.slice(1)), /probe-thread/);
    assert.doesNotMatch(result.stderr, /unsupported call/);
  },
);

test(
  'parallel Codex carriers preserve namespace dispatch and callback identity',
  { skip: !available, timeout: 55_000 },
  async () => {
    const identities = ['a', 'b'].map((suffix) => ({
      invocationId: `parallel-invocation-${suffix}`,
      callbackToken: `parallel-token-${suffix}`,
      threadId: `parallel-thread-${suffix}`,
    }));
    const results = await Promise.all(
      identities.map((identity) =>
        probeCodexNativePolicy({
          carrier: 'app_server',
          credentialFile: true,
          identity,
          requestedCall: ({ ordinal }: { ordinal: number }) =>
            ordinal === 1
              ? {
                  type: 'function_call',
                  id: 'fc_parallel_mcp',
                  call_id: 'call_parallel_mcp',
                  namespace: 'mcp__cat_cafe_collab',
                  name: 'cat_cafe_get_thread_context',
                  arguments: '{}',
                }
              : undefined,
        }),
      ),
    );
    results.forEach((result, index) => {
      assert.equal(result.timedOut, false);
      assert.equal(result.exitCode, 0, result.stderr);
      assert.equal(result.callbacks.length, 1);
      assert.equal(result.callbacks[0].headers['x-invocation-id'], identities[index].invocationId);
      assert.equal(result.callbacks[0].headers['x-callback-token'], identities[index].callbackToken);
      const outputs = JSON.stringify(result.requests.slice(1));
      assert.match(outputs, new RegExp(identities[index].threadId));
      assert.doesNotMatch(outputs, new RegExp(identities[1 - index].threadId));
      assert.doesNotMatch(result.stderr, /unsupported call/);
    });
  },
);
