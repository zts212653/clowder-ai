import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { probePrivateNative } from './fixtures/collective-private-native-probe.mjs';

test(
  'installed private native launcher bounds filesystem and shell secrets, reads admitted skills, and blocks the next effect after revocation',
  { skip: spawnSync('codex', ['--version']).status !== 0, timeout: 55000 },
  async () => {
    const probe = await probePrivateNative();
    assert.equal(
      probe.timedOut,
      false,
      JSON.stringify({
        stderr: probe.stderr,
        stdout: probe.stdout,
        requests: probe.requests.length,
        callbacks: probe.callbacks.length,
      }),
    );
    assert.equal(probe.exitCode, 0, probe.stderr);
    assert.equal(probe.allowed, 'allowed\n', probe.stdout + probe.stderr);
    assert.equal(probe.forbidden, false);
    assert.equal(probe.successorResult, 'CURRENT_EXECUTION_2', 'old native scope cannot overwrite the next generation');
    assert.equal(
      probe.replacementResult,
      'REPLACEMENT_ATTEMPT',
      'old native scope cannot overwrite a replacement attempt',
    );
    assert.equal(probe.revoked, false);
    assert.equal(probe.forbiddenNetwork, 0);
    assert.equal(probe.callbacks.length, 2, probe.stdout + probe.stderr);
    const tools = probe.requests[0]?.tools.find((tool: { name: string }) => tool.name === 'mcp__cat_cafe_collab');
    assert.ok(tools);
    const names = tools.tools.map((tool: { name: string }) => tool.name);
    assert.ok(names.includes('cat_cafe_post_message'));
    assert.ok(names.includes('cat_cafe_collective_reply'));
    assert.ok(names.includes('cat_cafe_update_entrusted_work'), 'native Work exposes canonical Artifact-ref CAS');
    assert.ok(
      names.includes('cat_cafe_collective_progress'),
      'the admitted private carrier exposes current Work progress',
    );
    assert.equal(
      names.some((name: string) =>
        /workflow|cross_post|search_evidence|list_threads|get_thread_context|profile|admin/.test(name),
      ),
      false,
    );
    assert.equal(
      probe.requests[0]?.tools.some((tool: { name: string }) => tool.name === 'view_image'),
      false,
    );
    const output = JSON.stringify(probe.requests.slice(1).map((request: { input: unknown }) => request.input));
    assert.match(output, /BOUNDED_SKILL_CANARY/);
    assert.doesNotMatch(output, /F290_PRIVATE_SECRET_CANARY/);
    assert.equal(output.includes(probe.callbackToken), false);
    assert.match(output, /Current private Work authority unavailable/);
  },
);
