import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { RedisClient } from '@cat-cafe/shared/utils';
import Fastify from 'fastify';
import { stringify } from 'yaml';
import { z } from 'zod';
import { AcpClient } from '../src/domains/cats/services/agents/providers/acp/AcpClient.js';
import { applySessionConfiguration } from '../src/domains/cats/services/agents/providers/acp/session-configuration.js';
import { RedisDshMemberConnectionCheckStore } from '../src/domains/cats/services/stores/redis/RedisDshMemberConnectionCheckStore.js';
import { createDshCheckLaunch, readDshCheckBinding } from '../src/routes/dsh-check-launch.js';
import { prepareDshDesktopSetup, readDshDesktopSetup } from '../src/routes/dsh-desktop-setup.js';
import { dshDefinitionOnlyServers } from '../src/routes/dsh-tool-manifest.js';
import { registerDshMemberConnectionChecks } from '../src/routes/member-connection-check.js';

// Opt in with the installed launcher. All credentials, HTTP and data in this
// test belong to this temporary fixture; it never calls a real model service.
test(
  'real Desktop preserves tool definitions but denies file, command, MCP and nested workflow execution before the first prompt',
  { skip: !process.env.DSH_DESKTOP_TEST_COMMAND, timeout: 120_000 },
  async (t) => {
    const root = mkdtempSync(join(tmpdir(), 'desktop-check-execution-'));
    const nativeHome = join(root, 'native');
    const nativeCwd = join(nativeHome, 'profiles/desktop');
    const cwd = join(root, 'host');
    mkdirSync(nativeCwd, { recursive: true });
    mkdirSync(cwd);
    const marker = join(root, 'forbidden.txt');
    const previous = process.env.DEEPSEEK_API_KEY;
    delete process.env.DEEPSEEK_API_KEY;
    t.after(() => {
      if (previous === undefined) delete process.env.DEEPSEEK_API_KEY;
      else process.env.DEEPSEEK_API_KEY = previous;
      rmSync(root, { recursive: true, force: true });
    });
    const wire = z.object({
      model: z.string(),
      tools: z.array(z.object({ function: z.object({ name: z.string() }) })),
      messages: z.array(z.unknown()),
    });
    let forced = '';
    let requests: z.infer<typeof wire>[] = [];
    let businessCalls = 0;
    const server = createServer(async (request, response) => {
      if (request.method !== 'POST') {
        response.writeHead(405).end();
        return;
      }
      let text = '';
      for await (const part of request) text += part;
      if (request.url === '/mcp') {
        const rpc = JSON.parse(text) as { id?: number; method: string };
        if (rpc.method === 'tools/call') businessCalls += 1;
        if (rpc.id === undefined) {
          response.writeHead(202).end();
          return;
        }
        const result =
          rpc.method === 'initialize'
            ? {
                protocolVersion: '2024-11-05',
                capabilities: { tools: {} },
                serverInfo: { name: 'guard-fixture', version: '1' },
              }
            : {
                tools: [
                  {
                    name: 'guard_mcp_tool',
                    description: 'Must not execute',
                    inputSchema: { type: 'object', properties: {} },
                  },
                ],
              };
        response
          .writeHead(200, { 'Content-Type': 'application/json' })
          .end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result }));
        return;
      }
      const body = wire.parse(JSON.parse(text));
      requests.push(body);
      const tool = body.tools.find(({ function: fn }) =>
        forced === 'mcp' ? fn.name.startsWith('mcp__') : fn.name === forced,
      );
      const args =
        forced === 'write'
          ? { file_path: marker, content: 'forbidden' }
          : forced === 'pwsh'
            ? {
                description: 'Fixture marker must never be written',
                command: `Set-Content -LiteralPath '${marker.replaceAll("'", "''")}' -Value forbidden`,
                workdir: cwd,
              }
            : forced === 'workflow'
              ? {
                  meta: { name: 'nested-denied', description: 'Never execute' },
                  script: 'return await agent({task:"Never execute this fixture"});',
                }
              : {};
      const delta =
        requests.length === 1
          ? {
              tool_calls: [
                {
                  index: 0,
                  id: 'forced',
                  type: 'function',
                  function: { name: tool?.function.name ?? 'missing', arguments: JSON.stringify(args) },
                },
              ],
            }
          : { role: 'assistant', content: 'DSH_CONNECTION_OK' };
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
      response.write(
        `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' in delta ? 'tool_calls' : 'stop' }] })}\n\n`,
      );
      response.end('data: [DONE]\n\n');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    writeFileSync(
      join(nativeCwd, 'package.json'),
      JSON.stringify({
        private: true,
        dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } },
      }),
    );
    writeFileSync(
      join(nativeCwd, 'cordis.patch.yml'),
      stringify([
        {
          id: 'llm-pi-ai',
          config: {
            providers: {
              fixture: {
                api: 'openai-completions',
                baseURL: `http://127.0.0.1:${address.port}/v1`,
                apiKeyEnv: 'CONNECTION_GUARD_FIXTURE',
                models: ['selected-model', 'alternate-model'].map((id) => ({
                  id,
                  contextWindow: 131072,
                  maxTokens: 2048,
                })),
              },
            },
          },
        },
      ]),
    );
    writeFileSync(join(nativeHome, '.credentials.yaml'), 'CONNECTION_GUARD_FIXTURE: fake-key\n');
    const source = { command: process.env.DSH_DESKTOP_TEST_COMMAND!, cwd, nativeHome, nativeCwd };
    const inspection = await readDshDesktopSetup(source);
    const prepared = await prepareDshDesktopSetup(source, inspection.view.revision, 'fixture', 'selected-model');
    for (const name of ['write', 'pwsh', 'mcp', 'workflow'])
      await t.test(name, async () => {
        forced = name;
        requests = [];
        const isolated = createDshCheckLaunch(readDshCheckBinding(prepared.launch));
        const definitions = dshDefinitionOnlyServers(
          {
            hash: 'fixture',
            servers: [
              {
                name: 'guard-fixture',
                tools: [
                  {
                    name: 'guard_mcp_tool',
                    description: 'Action must be blocked',
                    inputSchema: { type: 'object', properties: {} },
                  },
                ],
              },
            ],
          },
          isolated.directory,
        );
        const client = new AcpClient({
          command: source.command,
          args: isolated.launch.args,
          cwd: isolated.launch.cwd,
          env: isolated.launch.env,
          permissionHandler: (_request, respond) => respond({ cancelled: true }),
        });
        try {
          await client.initialize(); // ACP injects guard-ready: no handshake is possible before registration.
          const session = await client.newSession(isolated.launch.cwd, definitions);
          await applySessionConfiguration(client, session, { model: JSON.stringify(['fixture', 'selected-model']) });
          const result = await client.promptCollect(session.sessionId, 'Reply as text.', { timeoutMs: 20_000 });
          assert.equal(result.stopReason, 'end_turn');
          assert.equal(requests[0]?.model, 'selected-model');
          assert.ok(
            requests[0]?.tools.some(({ function: fn }) =>
              name === 'mcp' ? fn.name.startsWith('mcp__') : fn.name === name,
            ),
            'original tool definition retained',
          );
          assert.ok(
            requests.some((body) => JSON.stringify(body.messages).includes('clowder_connection_check_tools_disabled')),
            'forced call denied by execution guard',
          );
          assert.equal(existsSync(marker), false, 'no file or command side effect');
        } finally {
          await client.close();
          isolated.close();
        }
      });
    await t.test('saved member check uses admitted MCP and the saved model rather than the patch default', async () => {
      const previousRoots = Object.fromEntries(
        ['CAT_CAFE_CONFIG_ROOT', 'CAT_CAFE_GLOBAL_CONFIG_ROOT', 'CAT_TEMPLATE_PATH'].map((key) => [
          key,
          process.env[key],
        ]),
      );
      Object.assign(process.env, {
        CAT_CAFE_CONFIG_ROOT: cwd,
        CAT_CAFE_GLOBAL_CONFIG_ROOT: cwd,
        CAT_TEMPLATE_PATH: join(cwd, 'cat-template.json'),
      });
      const catalog = {
        version: 1,
        breeds: [
          {
            id: 'fixture',
            catId: 'check-member',
            name: 'Whale',
            displayName: 'Whale',
            avatar: '/avatars/fixture.svg',
            color: { primary: '#123456', secondary: '#abcdef' },
            mentionPatterns: ['@check-member'],
            roleDescription: 'Fixture',
            defaultVariantId: 'default',
            variants: [
              {
                id: 'default',
                clientId: 'acp',
                carrier: 'acp',
                configurationSource: 'native_tool',
                defaultModel: '["fixture","alternate-model"]',
                mcpSupport: true,
                env: prepared.launch.env,
                acp: {
                  command: source.command,
                  startupArgs: prepared.launch.args,
                  transport: 'stdio',
                  mcpWhitelist: ['guard-fixture'],
                },
              },
            ],
          },
        ],
      };
      mkdirSync(join(cwd, '.cat-cafe'), { recursive: true });
      writeFileSync(join(cwd, 'cat-template.json'), JSON.stringify(catalog));
      writeFileSync(join(cwd, '.cat-cafe/cat-catalog.json'), JSON.stringify(catalog));
      writeFileSync(
        join(cwd, '.cat-cafe/capabilities.json'),
        JSON.stringify({
          version: 2,
          capabilities: [
            {
              id: 'guard-fixture',
              name: 'Guard fixture',
              type: 'mcp',
              enabled: true,
              globalEnabled: true,
              mcpServer: { url: `http://127.0.0.1:${address.port}/mcp`, transport: 'streamableHttp' },
            },
          ],
        }),
      );
      const data = new Map<string, string>();
      const store = new RedisDshMemberConnectionCheckStore({
        get: async (key: string) => data.get(key) ?? null,
        set: async (key: string, value: string, mode?: string) => {
          if (mode === 'NX' && data.has(key)) return null;
          data.set(key, value);
          return 'OK';
        },
      } as unknown as RedisClient);
      const app = Fastify();
      app.decorateRequest('sessionUserId', 'fixture-owner');
      registerDshMemberConnectionChecks(app, { store });
      const { loadResolvedCatConfig, getRegisteredAcpConfig } = await import('../src/config/cat-config-loader.js');
      loadResolvedCatConfig(join(cwd, 'cat-template.json'));
      assert.ok(getRegisteredAcpConfig('check-member', cwd), 'saved member exposes its actual launch');
      forced = 'mcp';
      requests = [];
      try {
        const url = '/api/cats/check-member/connection-check';
        const before = (await app.inject({ method: 'GET', url })).json();
        assert.equal(before.state, 'unchecked', JSON.stringify(before));
        assert.equal(requests.length, 0, 'opening connection status is free');
        const payload = { attemptId: randomUUID() };
        const result = (await app.inject({ method: 'POST', url, payload })).json();
        assert.equal(result.state, 'passed', JSON.stringify(result));
        assert.equal(requests[0]?.model, 'alternate-model');
        assert.ok(requests[0]?.tools.some(({ function: fn }) => fn.name.startsWith('mcp__')));
        const count = requests.length;
        assert.equal((await app.inject({ method: 'POST', url, payload })).json().state, 'passed');
        assert.equal(requests.length, count, 'replaying the saved attempt sends no prompt');
        assert.equal(businessCalls, 0);
      } finally {
        await app.close();
        Object.entries(previousRoots).forEach(([key, value]) => {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        });
      }
    });
  },
);
