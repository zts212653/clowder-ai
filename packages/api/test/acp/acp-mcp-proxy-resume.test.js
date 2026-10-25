import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import {
  bindSessionCredentialFile,
  prepareSessionCredentialFile,
} from '../../dist/domains/cats/services/agents/providers/acp/acp-credential-file.js';
import { materializeSessionMcpServers } from '../../dist/domains/cats/services/agents/providers/acp/acp-session-env.js';
import { writeMcpProbe } from '../helpers/mcp-probe.js';
import { secretMcpContract } from '../helpers/secret-mcp-contract.js';

for (const nativePlugin of [false, true]) {
  test(
    `live ACP ${nativePlugin ? 'plugin' : 'host'} MCP child rereads the same credential file across two resumes`,
    { timeout: 15000 },
    async (t) => {
      const root = mkdtempSync(join(tmpdir(), 'acp-proxy-resume-'));
      const previous = process.env.CAT_CAFE_MCP_CREDS_DIR;
      process.env.CAT_CAFE_MCP_CREDS_DIR = root;
      t.after(() => {
        if (previous === undefined) delete process.env.CAT_CAFE_MCP_CREDS_DIR;
        else process.env.CAT_CAFE_MCP_CREDS_DIR = previous;
        rmSync(root, { recursive: true, force: true });
      });
      const script = join(root, 'probe.mjs');
      writeMcpProbe(
        script,
        `
      const auth = JSON.parse(readFileSync(process.env.CAT_CAFE_CREDENTIAL_FILE, 'utf8'));
      return {
        turn: auth.invocationId,
        currentAuth: auth.callbackToken === 'synthetic-' + auth.invocationId,
        fileOnly: !process.env.CAT_CAFE_INVOCATION_ID && !process.env.CAT_CAFE_CALLBACK_TOKEN,
        actionPresent: process.env.CLOWDER_PLUGIN_ACTION_TOKEN === 'synthetic-action',
        actionPath: process.env.CLOWDER_PLUGIN_ACTION_PATH ?? null,
        setting: process.env.KEEP,
      };
    `,
      );
      const registeredEnv = {
        KEEP: 'registered-setting',
        ...(nativePlugin
          ? {
              CLOWDER_PLUGIN_ACTION_TOKEN: 'synthetic-action',
              CLOWDER_PLUGIN_ACTION_PATH: '/api/plugin-runtime/action',
            }
          : {}),
      };
      const registration = {
        name: nativePlugin ? 'plugin-fixture' : 'cat-cafe-probe',
        command: process.execPath,
        args: [script],
        env: Object.entries(registeredEnv).map(([name, value]) => ({ name, value })),
      };
      const before = structuredClone(registration);
      const callbackFor = (turn) => ({
        CAT_CAFE_API_URL: 'http://127.0.0.1:1',
        CAT_CAFE_THREAD_ID: 'thread-probe',
        CAT_CAFE_CAT_ID: 'gemini-argon',
        CAT_CAFE_INVOCATION_ID: turn,
        CAT_CAFE_CALLBACK_TOKEN: `synthetic-${turn}`,
      });
      const first = prepareSessionCredentialFile(callbackFor('first'));
      bindSessionCredentialFile(root, first.path);
      const launch = materializeSessionMcpServers([registration], first.env, true)[0];
      const { proxyEnv, upstream } = secretMcpContract(launch);
      assert.equal(upstream.command, registration.command);
      assert.deepEqual(upstream.args, registration.args);
      assert.equal(upstream.source, registration.name);
      assert.equal(proxyEnv.KEEP, undefined);
      assert.equal(proxyEnv.CLOWDER_PLUGIN_ACTION_TOKEN, undefined);
      const client = new Client({ name: 'acp-resume-consumer', version: '1' });
      const transport = new StdioClientTransport({
        command: launch.command,
        args: launch.args,
        env: Object.fromEntries(launch.env.map(({ name, value }) => [name, value])),
        stderr: 'pipe',
      });
      transport.stderr?.on('data', () => {});
      try {
        await client.connect(transport);
        for (const turn of ['first', 'second', 'third']) {
          if (turn !== 'first') {
            const refreshed = prepareSessionCredentialFile(callbackFor(turn), root);
            assert.equal(refreshed.path, first.path);
            const resumed = secretMcpContract(materializeSessionMcpServers([registration], refreshed.env, true)[0]);
            for (const env of [resumed.proxyEnv, resumed.upstream.env]) {
              assert.equal(env.CAT_CAFE_CREDENTIAL_FILE, first.path);
              assert.equal(env.CAT_CAFE_INVOCATION_ID, undefined);
              assert.equal(env.CAT_CAFE_CALLBACK_TOKEN, undefined);
            }
          }
          const result = await client.callTool({ name: 'probe', arguments: {} });
          assert.ok(!result.isError, JSON.stringify(result));
          assert.deepEqual(JSON.parse(result.content[0].text), {
            turn,
            currentAuth: true,
            fileOnly: true,
            actionPresent: nativePlugin,
            actionPath: nativePlugin ? '/api/plugin-runtime/action' : null,
            setting: 'registered-setting',
          });
        }
        assert.deepEqual(registration, before, 'launch and resume must not rewrite the registration');
      } finally {
        await client.close();
      }
    },
  );
}
