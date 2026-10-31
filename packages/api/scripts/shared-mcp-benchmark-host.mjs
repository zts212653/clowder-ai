/** Isolated F333 workload host, using the production route and principal. */
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import Fastify from 'fastify';
import { SHARED_MCP_FAMILIES } from '../../mcp-server/dist/shared-invocation-context.js';
import { resolveConfiguredMemberMcpFamilies } from '../dist/config/capabilities/member-mcp-families.js';
import { InvocationRegistry } from '../dist/domains/cats/services/agents/invocation/InvocationRegistry.js';
import {
  prepareSessionCredentialFile,
  releaseInvocationCredentialFile,
} from '../dist/domains/cats/services/agents/providers/session-credential-file.js';
import { registerMemberMcpRoutes } from '../dist/routes/member-mcp.js';

const root = process.env.F333_BENCH_ROOT;
if (!root) throw new Error('benchmark root is required');
const config = join(root, 'config');
mkdirSync(join(config, '.cat-cafe'), { recursive: true });
copyFileSync(resolve('cat-template.json'), join(config, 'cat-template.json'));
copyFileSync(resolve('cat-template.json'), join(config, '.cat-cafe/cat-catalog.json'));
writeFileSync(
  join(config, '.cat-cafe/capabilities.json'),
  JSON.stringify({
    version: 1,
    capabilities: SHARED_MCP_FAMILIES.map((family) => ({
      id: `cat-cafe-${family}`,
      type: 'mcp',
      enabled: true,
      source: 'cat-cafe',
      mcpServer: { command: process.execPath, args: [resolve(`packages/mcp-server/dist/${family}.js`)] },
    })),
  }),
);
const registry = new InvocationRegistry();
const app = Fastify({ logger: false });
app.get('/api/config', () => ({ config: { coCreator: { name: 'Fixture', mentionPatterns: ['@fixture'] } } }));
let apiUrl;
registerMemberMcpRoutes(app, {
  registry,
  resolveMemberToolFamilies: ({ catId, sharedContext }) =>
    resolveConfiguredMemberMcpFamilies(config, catId, sharedContext?.workspaceRoot),
  get apiBaseUrl() {
    return apiUrl;
  },
  log: { warn() {} },
});
apiUrl = await app.listen({ host: '127.0.0.1', port: 0 });
const scopes = new Map();
process.on('message', async (message) => {
  try {
    if (message.action === 'admit') {
      const workspaceRoot = join(root, `workspace-${message.index}`);
      mkdirSync(workspaceRoot, { recursive: true });
      writeFileSync(join(workspaceRoot, 'document.txt'), `fixture owner ${message.index}\n`);
      const credentials = await registry.create(
        'fixture-user',
        'codex',
        `fixture-thread-${message.index}`,
        undefined,
        undefined,
        undefined,
        undefined,
        'strict',
        undefined,
        {
          v: 1,
          deploymentId: 'fixture',
          workspaceRoot,
          dataDir: join(root, 'data'),
          allowedWorkspaceDirs: [workspaceRoot],
          capabilityRoot: config,
          families: SHARED_MCP_FAMILIES,
        },
      );
      const { invocationId, callbackToken } = credentials;
      const env = {
        CAT_CAFE_API_URL: apiUrl,
        CAT_CAFE_INVOCATION_ID: invocationId,
        CAT_CAFE_CALLBACK_TOKEN: callbackToken,
        CAT_CAFE_CAT_ID: 'codex',
        CAT_CAFE_USER_ID: 'fixture-user',
        CAT_CAFE_THREAD_ID: `fixture-thread-${message.index}`,
      };
      const prepared = prepareSessionCredentialFile('f333-benchmark', env);
      if (!prepared) throw new Error('fixture credential projection failed');
      scopes.set(message.index, { ...credentials, path: prepared.path });
      process.send({ id: message.id, ok: true, value: { apiUrl, workspaceRoot, credentialFile: prepared.path } });
    } else if (message.action === 'resources') {
      process.send({
        id: message.id,
        ok: true,
        value: {
          memory: process.memoryUsage(),
          resources: process.getActiveResourcesInfo(),
          connections: await new Promise((done) => app.server.getConnections((_error, count) => done(count))),
        },
      });
    } else if (message.action === 'diagnostic-gc') {
      const before = process.memoryUsage();
      global.gc?.();
      process.send({ id: message.id, ok: true, value: { before, after: process.memoryUsage() } });
    } else if (message.action === 'probe') {
      const { invocationId, callbackToken } = scopes.get(message.index);
      const families = await resolveConfiguredMemberMcpFamilies(config, 'codex');
      const response = await app.inject({
        method: 'POST',
        url: '/api/member-mcp/mcp?shared=1&family=memory',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          'x-invocation-id': invocationId,
          'x-callback-token': callbackToken,
          'x-mcp-connection-id': 'fixture-probe',
        },
        payload: {
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'probe', version: '1' } },
        },
      });
      process.send({
        id: message.id,
        ok: true,
        value: { families, status: response.statusCode, error: response.json().error ?? null },
      });
    } else if (message.action === 'revoke') {
      const scope = scopes.get(message.index);
      await registry.commitTerminal({
        invocationId: scope.invocationId,
        disposition: 'revoked',
        endedAt: Date.now(),
        endReason: 'fixture-revoke',
      });
      process.send({ id: message.id, ok: true, value: {} });
    } else if (message.action === 'close') {
      await app.close();
      for (const scope of scopes.values()) releaseInvocationCredentialFile(scope.path);
      process.send({ id: message.id, ok: true, value: {} }, () => process.exit(0));
    }
  } catch {
    process.send({ id: message.id, ok: false, error: 'benchmark_host_operation_failed' });
  }
});
process.send({ ready: true });
