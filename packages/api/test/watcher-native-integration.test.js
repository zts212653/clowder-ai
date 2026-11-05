import assert from 'node:assert/strict';
import { once } from 'node:events';
import { access, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { resolveCodexAccountLaunch, resolveCodexApiExecutionHome } from '../dist/config/codex-account-launch.js';
import { CodexAgentService } from '../dist/domains/cats/services/agents/providers/CodexAgentService.js';
import { watcherSystemPrompt } from '../dist/domains/concierge/watcher/watcher-prompt.js';
import { watcherToolSurface } from '../dist/domains/concierge/watcher/watcher-surface.js';
import { estimateTokens } from '../dist/utils/token-counter.js';
import { nativeWatcherAvailable } from './helpers/watcher-native-fixture.js';

test(
  'actual Codex native process resumes a bounded watcher with exact MCP schemas and excludes inherited commands',
  { timeout: 90_000, skip: nativeWatcherAvailable ? false : 'Local Codex CLI not installed' },
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'f335-watcher-native-surface-'));
    const requests = [];
    const server = createServer(async (request, response) => {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      if (request.method !== 'POST') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end('{"data":[]}');
        return;
      }
      const raw = Buffer.concat(chunks).toString();
      const body = JSON.parse(raw);
      requests.push({ raw, body });
      const id = `fixture-${requests.length}`;
      const output = [
        {
          type: 'message',
          id: `message-${requests.length}`,
          role: 'assistant',
          status: 'completed',
          content: [
            {
              type: 'output_text',
              text: JSON.stringify({
                v: 1,
                notes: `note-${requests.length}`,
                consumedThrough: 'frontier:0',
                outcome: 'quiet',
              }),
            },
          ],
        },
      ];
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const [type, payload] of [
        ['response.created', { response: { id, status: 'in_progress', output: [] } }],
        ['response.output_item.added', { output_index: 0, item: output[0] }],
        ['response.output_item.done', { output_index: 0, item: output[0] }],
        [
          'response.completed',
          {
            response: {
              id,
              status: 'completed',
              model: body.model,
              output,
              usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
            },
          },
        ],
      ])
        response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`);
      response.end();
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const apiUrl = `http://127.0.0.1:${server.address().port}`;
    const poison = join(root, 'poison-ran');
    const cliHome = join(root, '.codex');
    await mkdir(cliHome);
    await writeFile(
      join(cliHome, 'config.toml'),
      `[mcp_servers.unrelated_poison]\ncommand="${process.execPath}"\nargs=${JSON.stringify(['-e', "require('node:fs').writeFileSync(process.argv[1],'ran')", poison])}\n`,
    );
    const env = {
      CAT_CAFE_API_URL: apiUrl,
      CAT_CAFE_USER_ID: 'watcher-test',
      CAT_CAFE_CAT_ID: 'codex',
      CAT_CAFE_THREAD_ID: 'native-fixture',
      CAT_CAFE_INVOCATION_ID: 'fixture-watcher-id',
      CAT_CAFE_CALLBACK_TOKEN: 'fixture-token',
      CAT_CAFE_MCP_TRANSPORT: 'stdio',
      ALLOWED_WORKSPACE_DIRS: resolve('../..'),
    };
    const surface = watcherToolSurface(env);
    const service = new CodexAgentService({ catId: 'codex', carrierMode: 'app_server' });
    const originalHome = process.env.CODEX_HOME;
    const originalData = process.env.CAT_CAFE_DATA_DIR;
    process.env.CAT_CAFE_DATA_DIR = join(root, 'data');
    process.env.CODEX_HOME = cliHome;
    let sessionId;
    let turnId;
    let completed = 0;
    try {
      const launch = resolveCodexAccountLaunch(
        { id: 'codex', authType: 'api_key' },
        { cwd: root, authMode: 'api_key' },
      );
      const executionHome = resolveCodexApiExecutionHome(launch, `${apiUrl}/v1`, root, process.env);
      assert.ok(executionHome.startsWith(await realpath(root)));
      await mkdir(executionHome, { recursive: true });
      await writeFile(
        join(executionHome, 'config.toml'),
        await (await import('node:fs/promises')).readFile(join(cliHome, 'config.toml')),
      );
      for (let round = 1; round <= 3; round++) {
        const messages = [];
        for await (const message of service.invoke(`OWN_NOTE_${round - 1}\nRAW_INCREMENT_${round}`, {
          invocationId: `watcher-native-${round}`,
          hostSessionId: 'watcher-logical',
          sessionId,
          requireExactResume: Boolean(sessionId),
          workingDirectory: root,
          callbackEnv: {
            ...env,
            CODEX_AUTH_MODE: 'api_key',
            OPENAI_API_KEY: 'fixture-key',
            OPENAI_BASE_URL: `${apiUrl}/v1`,
          },
          signal: AbortSignal.timeout(25_000),
          toolExecutionPolicy: surface.policy,
          requiredTools: surface.requiredTools,
          boundedWatcher: {
            async configureProvider() {
              return {};
            },
            instructions: watcherSystemPrompt('codex'),
            config: surface.config,
            tools: surface.tools.map((tool) => ({
              name: tool.name,
              description: tool.description,
              inputSchema: tool.inputSchema,
            })),
            async callTool() {
              throw new Error('Fixture does not call tools');
            },
            outputSchema: {
              type: 'object',
              properties: {
                v: { type: 'integer' },
                notes: { type: 'string' },
                consumedThrough: { type: 'string' },
                outcome: { type: 'string' },
              },
              required: ['v', 'notes', 'consumedThrough', 'outcome'],
              additionalProperties: false,
            },
            async beforeTurn({ client }) {
              const loaded = await client.request('config/read', { cwd: root, includeLayers: false });
              assert.ok(
                loaded.config?.mcp_servers?.unrelated_poison,
                'poison server must exist in the actual inherited native config',
              );
              return true;
            },
            async accepted(input) {
              turnId = input.turnId;
            },
            async completed({ threadId, client }) {
              const read = await client.request('thread/read', { threadId, includeTurns: true });
              assert.equal(read.thread.id, sessionId);
              assert.equal(read.thread.turns.length, 1);
              await client.request('thread/revert', { threadId, beforeTurnId: turnId });
              completed++;
            },
          },
        })) {
          messages.push(message);
          if (message.type === 'session_init') {
            if (sessionId) assert.equal(message.sessionId, sessionId);
            else sessionId = message.sessionId;
          }
        }
        const errors = messages.filter((message) => message.type === 'error');
        assert.deepEqual(
          errors.map((message) => message.error),
          [],
          JSON.stringify(errors),
        );
      }
      await writeFile(
        '/tmp/f335-watcher-surface-wire.json',
        JSON.stringify(
          requests.map((entry) => entry.body),
          null,
          2,
        ),
      );
      assert.equal(completed, 3);
      assert.equal(requests.length, 3);
      for (const [index, request] of requests.entries()) {
        assert.ok(estimateTokens(request.raw) < 30_000);
        if (index > 0) assert.equal(request.raw.includes('RAW_INCREMENT_1'), false);
        const names =
          request.body.tools?.flatMap((tool) =>
            tool.type === 'namespace' ? tool.tools.map((item) => item.name) : [tool.name],
          ) ?? [];
        assert.deepEqual(names.sort(), surface.tools.map((tool) => tool.name).sort());
        assert.equal(
          names.some((name) => /shell|exec_command|apply_patch|spawn_agent|unrelated_poison/.test(name ?? '')),
          false,
          JSON.stringify(names),
        );
      }
      await assert.rejects(access(poison));
    } finally {
      if (originalData === undefined) delete process.env.CAT_CAFE_DATA_DIR;
      else process.env.CAT_CAFE_DATA_DIR = originalData;
      if (originalHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = originalHome;
      await new Promise((resolveClose) => server.close(resolveClose));
      await rm(root, { recursive: true, force: true });
    }
  },
);
