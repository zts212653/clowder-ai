// Local inventory/handler probe only: no model turn, microphone, or private source input.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCodexAppServerInitializedRpc } from '../../packages/api/src/domains/cats/services/agents/providers/CodexAppServerNativeRpc.js';
import { buildCodexNativeEffectGuardArgs } from '../../packages/api/src/domains/cats/services/agents/providers/CodexNativeEffectGuard.js';
import { createDirectAgentCarrierSession } from '../../packages/api/src/domains/cats/services/agents/providers/DirectAgentCarrierSession.js';
import { buildMemoryConfig } from './memory-config.cjs';
import { verifyMemoryTools } from './tool-availability.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const storage = await mkdtemp(resolve(tmpdir(), 'f317-tools-probe-'));
const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
await mkdir(resolve(storage, 'mcp-data'));
await writeFile(resolve(storage, 'mcp-data/challenge.txt'), 'synthetic permission probe');
const wire = await createDirectAgentCarrierSession({
  command: 'codex',
  args: [
    'app-server',
    '--stdio',
    '--config',
    'features.shell_tool=false',
    ...buildCodexNativeEffectGuardArgs({ repoRoot: root }),
  ],
  cwd: root,
  invocationId: `f317-tools-probe-${Date.now()}`,
  env: { OPENAI_API_KEY: null, CODEX_API_KEY: null, REDIS_URL: 'redis://localhost:6398' },
});
try {
  await runCodexAppServerInitializedRpc({
    wire,
    timeoutMs: 30_000,
    capabilities: { experimentalApi: true },
    run: async (rpc) => {
      const config = record(record(await rpc.request('config/read', { includeLayers: false })).config);
      const servers: Record<string, unknown> = Object.fromEntries(
        Object.keys(record(config.mcp_servers)).map((name) => [name, { enabled: false }]),
      );
      servers.cat_cafe_memory = buildMemoryConfig({
        synthetic: true,
        root,
        storage,
        memoryEntry: resolve(root, 'packages/mcp-server/dist/memory.js'),
        node: process.execPath,
      });
      const created = record(
        await rpc.request('thread/start', {
          cwd: root,
          ephemeral: true,
          sandbox: 'read-only',
          approvalPolicy: 'never',
          config: { mcp_servers: servers, 'features.shell_tool': false, 'features.apply_patch_freeform': false },
        }),
      );
      const threadId = String(record(created.thread).id);
      const inventory = await verifyMemoryTools(rpc, threadId, true);
      const result = record(
        await rpc.request('mcpServer/tool/call', {
          threadId,
          server: 'cat_cafe_memory',
          tool: 'cat_cafe_read_file_slice',
          arguments: { path: resolve(storage, 'mcp-data/challenge.txt'), startLine: 1 },
        }),
      );
      assert.match(JSON.stringify(result), /synthetic permission probe/);
      console.log(
        JSON.stringify({ inventory, syntheticRead: 'passed', modelTurnStarted: false, microphoneCaptured: false }),
      );
    },
  });
} finally {
  await rm(storage, { recursive: true, force: true });
}
