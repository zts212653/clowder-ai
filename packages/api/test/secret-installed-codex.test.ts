import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { buildCodexNativeEffectGuardArgs } from '../src/domains/cats/services/agents/providers/CodexNativeEffectGuard.js';
// Existing fixture owns an isolated HOME, loopback Responses endpoint and cleanup.
// @ts-expect-error The integration fixture is an untyped local .mjs helper.
import { probeCodexNativePolicy } from './fixtures/codex-native-policy-probe.mjs';

const fake = () => ['ghp', '_', 'N'.repeat(36)].join('');
const available = spawnSync('codex', ['--version'], { timeout: 5000 }).status === 0;
for (const carrier of ['exec_json', 'app_server'])
  for (const contaminated of [false, true])
    test(
      `installed Codex ${carrier} native hook ${contaminated ? 'blocks secret content' : 'executes clean positive control'}`,
      { timeout: 55000, skip: !available },
      async () => {
        let offered = false;
        const result = await probeCodexNativePolicy({
          invokeTools: false,
          carrier,
          policyArgs: [
            '--ignore-user-config',
            '--config',
            'approval_policy="never"',
            '--config',
            'sandbox_mode="workspace-write"',
            '--enable',
            'shell_tool',
            '--enable',
            'unified_exec',
            '--disable',
            'code_mode',
            '--disable',
            'code_mode_only',
            ...buildCodexNativeEffectGuardArgs(),
          ],
          requestedCall: ({
            parsed,
            ordinal,
            marker,
          }: {
            parsed: { tools: Array<{ name: string; type: string; tools?: Array<{ name: string }> }> };
            ordinal: number;
            marker: string;
          }) => {
            if (ordinal !== 1) return undefined;
            const namespace = parsed.tools.find((tool) => tool.tools?.some((child) => child.name === 'exec_command'));
            offered = Boolean(namespace || parsed.tools.some((tool) => tool.name === 'exec_command'));
            return {
              type: 'function_call',
              id: 'fc_secret_probe',
              call_id: 'call_secret_probe',
              ...(namespace ? { namespace: namespace.name } : {}),
              name: 'exec_command',
              arguments: JSON.stringify({
                cmd: `printf '%s' '${contaminated ? fake() : 'safe output'}'; touch '${marker}'`,
              }),
            };
          },
        });
        assert.equal(result.timedOut, false, 'native process must complete');
        assert.equal(offered, true, 'positive tool selection must exist');
        assert.equal(result.exitCode, 0);
        assert.equal(result.forbiddenEffect, !contaminated);
        if (contaminated) assert.match(JSON.stringify(result.requests.slice(1)), /secret_content_blocked_before_send/);
      },
    );

for (const carrier of ['exec_json', 'app_server'])
  test(
    `installed Codex ${carrier} post hook records native result exposure through callback auth`,
    { timeout: 55000, skip: !available },
    async () => {
      let resultFile = '';
      const result = await probeCodexNativePolicy({
        invokeTools: false,
        carrier,
        prepare: async (root: string) => {
          resultFile = join(root, 'fixture-result.txt');
          await writeFile(resultFile, fake());
        },
        policyArgs: [
          '--ignore-user-config',
          '--config',
          'approval_policy="never"',
          '--config',
          'sandbox_mode="workspace-write"',
          '--enable',
          'shell_tool',
          '--enable',
          'unified_exec',
          '--disable',
          'code_mode',
          '--disable',
          'code_mode_only',
          ...buildCodexNativeEffectGuardArgs(),
        ],
        requestedCall: ({
          parsed,
          ordinal,
        }: {
          parsed: { tools: Array<{ name: string; tools?: Array<{ name: string }> }> };
          ordinal: number;
        }) => {
          if (ordinal !== 1) return undefined;
          const ns = parsed.tools.find((tool) => tool.tools?.some((child) => child.name === 'exec_command'));
          return {
            type: 'function_call',
            id: 'fc_result',
            call_id: 'call_result',
            ...(ns ? { namespace: ns.name } : {}),
            name: 'exec_command',
            arguments: JSON.stringify({ cmd: `cat '${resultFile}'` }),
          };
        },
      });
      assert.equal(result.timedOut, false);
      assert.equal(result.exitCode, 0);
      const notice = result.callbacks.find((entry: { path: string }) => entry.path === '/api/callbacks/post-message');
      assert.ok(notice, 'actual post hook must reach the notice sink');
      assert.equal(notice.headers['x-invocation-id'], 'probe-invocation');
      assert.ok(!JSON.stringify(notice.body).includes(fake()));
    },
  );
