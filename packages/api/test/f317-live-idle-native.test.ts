import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { runCodexAppServerInitializedRpc } from '../dist/domains/cats/services/agents/providers/CodexAppServerNativeRpc.js';
import { createDirectAgentCarrierSession } from '../dist/domains/cats/services/agents/providers/DirectAgentCarrierSession.js';
import { CODEX_LIVE_POLICY_ARGS } from '../src/domains/cats/services/agents/providers/codex-live-policy.js';

test(
  'installed native accepts idle application context and rejects empty input on an active turn',
  {
    skip: spawnSync('codex', ['--version']).status !== 0,
    timeout: 30_000,
  },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'f317-idle-native-'));
    const requests: Array<Record<string, unknown>> = [];
    let releaseFirst!: () => void;
    let receivedFirst!: () => void;
    const firstRequest = new Promise<void>((resolve) => {
      receivedFirst = resolve;
    });
    const server = http.createServer(async (req, res) => {
      if (req.method !== 'POST') {
        res.writeHead(404);
        res.end();
        return;
      }
      let body = '';
      for await (const chunk of req) body += chunk;
      requests.push(JSON.parse(body));
      const finish = () => {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end(
          [
            {
              type: 'response.created',
              response: { id: 'local', object: 'response', status: 'in_progress', output: [] },
            },
            {
              type: 'response.completed',
              response: {
                id: 'local',
                object: 'response',
                status: 'completed',
                output: [],
                usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
              },
            },
          ]
            .map((event) => `data: ${JSON.stringify(event)}\n\n`)
            .join(''),
        );
      };
      if (requests.length === 1) {
        releaseFirst = finish;
        receivedFirst();
      } else finish();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    const completed = new Set<string>();
    const waiters = new Map<string, () => void>();
    const terminal = (id: string) =>
      completed.has(id) ? Promise.resolve() : new Promise<void>((resolve) => waiters.set(id, resolve));
    try {
      const wire = await createDirectAgentCarrierSession({
        command: 'codex',
        cwd: root,
        invocationId: 'f317-local-native-fixture',
        args: [
          'app-server',
          ...CODEX_LIVE_POLICY_ARGS,
          '--config',
          'model_provider="fixture"',
          '--config',
          'model_providers.fixture.name="fixture"',
          '--config',
          `model_providers.fixture.base_url="http://127.0.0.1:${port}/v1"`,
          '--config',
          'model_providers.fixture.wire_api="responses"',
          '--config',
          'model_providers.fixture.env_key="OPENAI_API_KEY"',
        ],
        env: {
          PATH: process.env.PATH,
          HOME: root,
          CODEX_HOME: root,
          OPENAI_API_KEY: 'synthetic-only',
          NO_PROXY: '127.0.0.1,localhost',
        },
      });
      await runCodexAppServerInitializedRpc({
        wire,
        timeoutMs: 20_000,
        capabilities: { experimentalApi: true },
        onNotification: async (event) => {
          const params = event.params as { turn?: { id: string } };
          if (event.method === 'turn/completed' && params.turn) {
            completed.add(params.turn.id);
            waiters.get(params.turn.id)?.();
          }
        },
        run: async (client) => {
          const thread = (await client.request('thread/start', {
            model: 'gpt-5',
            modelProvider: 'fixture',
            cwd: root,
            approvalPolicy: 'never',
            sandbox: 'read-only',
          })) as { thread: { id: string } };
          const threadId = thread.thread.id;
          const first = (await client.request('turn/start', {
            threadId,
            input: [{ type: 'text', text: 'synthetic bootstrap' }],
          })) as { turn: { id: string } };
          await firstRequest;
          let rejection: unknown;
          try {
            await client.request('turn/start', {
              threadId,
              input: [],
              additionalContext: { test: { kind: 'application', value: 'F317_IDLE_NOTICE' } },
            });
          } catch (error) {
            rejection = error;
          }
          assert.ok(rejection instanceof Error, 'busy empty input must not steer or accept a new turn');
          t.diagnostic(`native busy-input rejection: ${rejection.message}`);
          assert.match(rejection.message, /empty.*input|input.*empty/i);
          releaseFirst();
          await terminal(first.turn.id);
          const idle = (await client.request('turn/start', {
            threadId,
            input: [],
            turnTrigger: 'live_freshness',
            additionalContext: { 'cat-cafe.live-freshness': { kind: 'application', value: 'F317_IDLE_NOTICE' } },
          })) as { turn: { id: string } };
          assert.notEqual(idle.turn.id, first.turn.id);
          await terminal(idle.turn.id);
          assert.equal(requests.length, 2);
          const items = requests[1].input as Array<{ role?: string }>;
          assert.ok(
            items.some((item) => item.role === 'developer' && JSON.stringify(item).includes('F317_IDLE_NOTICE')),
          );
          assert.equal(
            items.some((item) => item.role === 'user' && JSON.stringify(item).includes('F317_IDLE_NOTICE')),
            false,
          );
        },
      });
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    }
  },
);
