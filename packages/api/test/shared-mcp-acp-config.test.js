import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { buildAuthHeaders } from '@cat-cafe/mcp-server/dist/tools/callback-tools.js';
import { catRegistry } from '@cat-cafe/shared';
import Fastify from 'fastify';
import { readInvocationMcpConfig } from '../dist/config/capabilities/invoke-mcp-config.js';
import { resolveConfiguredMemberMcpFamilies } from '../dist/config/capabilities/member-mcp-families.js';
import { reconcileCatRegistry } from '../dist/config/cat-registry-reconciliation.js';
import { InvocationRegistry } from '../dist/domains/cats/services/agents/invocation/InvocationRegistry.js';
import { prepareSharedMcpLaunch } from '../dist/domains/cats/services/agents/invocation/shared-mcp-launch.js';
import {
  resolveAcpMcpServers,
  resolveDisabledServerIds,
} from '../dist/domains/cats/services/agents/providers/acp/acp-mcp-resolver.js';
import { registerMemberMcpRoutes } from '../dist/routes/member-mcp.js';
import './helpers/setup-cat-registry.js';

for (const whitelist of [[], ['cat-cafe-memory']]) {
  test(`ACP workspace config agrees with shared admission and current revocation (${whitelist.length ? 'explicit' : 'auto'} whitelist)`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'f333-acp-project-config-'));
    const workspace = join(root, 'workspace');
    const saved = process.env.CAT_CAFE_CONFIG_ROOT;
    const savedMembers = catRegistry.getAllConfigs();
    process.env.CAT_CAFE_CONFIG_ROOT = root;
    const app = Fastify();
    try {
      mkdirSync(join(root, '.cat-cafe'));
      mkdirSync(join(workspace, '.cat-cafe'), { recursive: true });
      copyFileSync(resolve('../../cat-template.json'), join(root, 'cat-template.json'));
      const catalog = JSON.parse(readFileSync(join(root, 'cat-template.json'), 'utf8'));
      const variant = catalog.breeds.find((breed) => breed.catId === 'codex').variants[0];
      variant.clientId = 'acp';
      variant.carrier = 'acp';
      variant.acp = { command: 'fixture-acp', mcpWhitelist: whitelist };
      writeFileSync(join(root, '.cat-cafe/cat-catalog.json'), JSON.stringify(catalog));
      reconcileCatRegistry(root, new Set(catRegistry.getAllIds()));
      const config = (enabled) => ({
        version: 1,
        capabilities: ['memory', 'collab'].map((family) => ({
          id: `cat-cafe-${family}`,
          type: 'mcp',
          source: 'cat-cafe',
          enabled: enabled.includes(family),
          mcpServer: { command: process.execPath, args: [resolve(`../mcp-server/dist/${family}.js`)] },
        })),
      });
      writeFileSync(join(root, '.cat-cafe/capabilities.json'), JSON.stringify(config([])));
      const workspaceConfig = join(workspace, '.cat-cafe/capabilities.json');
      writeFileSync(workspaceConfig, JSON.stringify(config(['memory'])));

      // These are the invoke-time ACP config and resolver used by AcpAgentService.
      const { config: invocationConfig, configSourceRoot } = readInvocationMcpConfig(root, workspace);
      const injected = await resolveAcpMcpServers(root, whitelist, undefined, {
        mcpSupport: true,
        catId: 'codex',
        capabilitiesConfig: invocationConfig,
        configSourceRoot,
        disabledServerIds: resolveDisabledServerIds(root, 'codex', invocationConfig),
      });
      assert.equal(configSourceRoot, workspace);
      assert.deepEqual(
        injected.map((server) => server.name),
        ['cat-cafe-memory'],
      );
      assert.deepEqual(await resolveConfiguredMemberMcpFamilies(root, 'codex'), [], 'global remains disabled');
      assert.deepEqual(
        await resolveConfiguredMemberMcpFamilies(root, 'codex', workspace),
        ['memory'],
        'shared projection must admit the family actually injected by ACP',
      );
      const context = await prepareSharedMcpLaunch({
        catId: 'codex',
        apiUrl: 'http://127.0.0.1:3102',
        workingDirectory: workspace,
        transport: 'shared',
      });
      assert.deepEqual(context.families, ['memory']);
      const rollback = await prepareSharedMcpLaunch({
        catId: 'codex',
        apiUrl: 'http://127.0.0.1:3102',
        workingDirectory: workspace,
        transport: 'stdio',
      });
      assert.deepEqual(rollback.families, context.families);

      const registry = new InvocationRegistry();
      const credentials = await registry.create(
        'fixture-user',
        'codex',
        'fixture-thread',
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        context,
      );
      registerMemberMcpRoutes(app, {
        registry,
        resolveMemberToolFamilies: ({ catId, sharedContext }) =>
          resolveConfiguredMemberMcpFamilies(sharedContext.capabilityRoot, catId, sharedContext.workspaceRoot),
        apiBaseUrl: 'http://127.0.0.1:3102',
        log: { warn() {} },
      });
      const initialize = (family) =>
        app.inject({
          method: 'POST',
          url: `/api/member-mcp/mcp?shared=1&family=${family}`,
          headers: {
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
            'x-mcp-connection-id': 'fixture-acp-project',
            ...buildAuthHeaders(credentials),
          },
          payload: {
            jsonrpc: '2.0',
            id: 1,
            method: 'initialize',
            params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'fixture', version: '1' } },
          },
        });
      assert.equal((await initialize('memory')).statusCode, 200, 'actual gateway must accept the workspace family');
      writeFileSync(workspaceConfig, JSON.stringify(config(['collab'])));
      assert.equal((await initialize('memory')).statusCode, 403, 'workspace disable must revoke the original family');
      assert.equal(
        (await initialize('collab')).statusCode,
        403,
        'newly enabled families cannot enlarge the launch bound',
      );
    } finally {
      await app.close();
      if (saved === undefined) delete process.env.CAT_CAFE_CONFIG_ROOT;
      else process.env.CAT_CAFE_CONFIG_ROOT = saved;
      catRegistry.reset();
      for (const [id, config] of Object.entries(savedMembers)) catRegistry.register(id, config);
      rmSync(root, { recursive: true, force: true });
    }
  });
}
