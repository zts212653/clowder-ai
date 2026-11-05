import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { withClaudeSecretHooks } from '../src/domains/cats/services/agents/providers/claude-secret-hook-settings.js';

const fake = () => ['ghp', '_', 'C'.repeat(36)].join('');
const cliAvailable = spawnSync('claude', ['--version'], { timeout: 5000 }).status === 0;
// Claude's managed bypass mode is unavailable to a root process; do not substitute another mode.
const bypassAvailable = process.getuid?.() !== 0;
function respond(response: http.ServerResponse, input: Record<string, unknown>, ordinal: number, command: string) {
  const tool = ordinal === 1;
  const block = tool
    ? { type: 'tool_use', id: 'tool_secret_probe', name: 'Bash', input: {} }
    : { type: 'text', text: '' };
  const events = [
    {
      type: 'message_start',
      message: {
        id: `fixture-${ordinal}`,
        type: 'message',
        role: 'assistant',
        model: input.model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 0 },
      },
    },
    { type: 'content_block_start', index: 0, content_block: block },
    {
      type: 'content_block_delta',
      index: 0,
      delta: tool
        ? { type: 'input_json_delta', partial_json: JSON.stringify({ command }) }
        : { type: 'text_delta', text: 'Probe completed.' },
    },
    { type: 'content_block_stop', index: 0 },
    {
      type: 'message_delta',
      delta: { stop_reason: tool ? 'tool_use' : 'end_turn', stop_sequence: null },
      usage: { output_tokens: 1 },
    },
    { type: 'message_stop' },
  ];
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  response.end(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''));
}

for (const carrier of ['cli', 'sdk'] as const)
  for (const scenario of ['clean', 'blocked', 'exposed'] as const)
    test(
      `installed Claude ${carrier}: ${scenario}`,
      { timeout: 45000, skip: !bypassAvailable || (carrier === 'cli' && !cliAvailable) },
      async () => {
        const root = await mkdtemp(join(tmpdir(), 'secret-claude-'));
        const marker = join(root, 'effect-marker');
        const resultFile = join(root, 'result.txt');
        await writeFile(resultFile, fake());
        const command =
          scenario === 'exposed'
            ? `cat '${resultFile}'`
            : `printf '%s' '${scenario === 'blocked' ? fake() : 'safe output'}'; touch '${marker}'`;
        let modelCalls = 0;
        const notices: Array<{ body: string; invocation: unknown }> = [];
        const inputs: unknown[] = [];
        const server = http.createServer(async (request, response) => {
          let raw = '';
          for await (const chunk of request) raw += chunk;
          if (request.url === '/api/callbacks/post-message') {
            notices.push({ body: raw, invocation: request.headers['x-invocation-id'] });
            response.writeHead(200, { 'content-type': 'application/json' });
            response.end('{"messageId":"fixture-notice"}');
            return;
          }
          if (!request.url?.startsWith('/v1/messages') || request.method !== 'POST') {
            response.writeHead(200, { 'content-type': 'application/json' });
            response.end('{}');
            return;
          }
          const input = JSON.parse(raw);
          inputs.push(input);
          respond(response, input, ++modelCalls, command);
        });
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
        const port = (server.address() as { port: number }).port;
        const env: Record<string, string | undefined> = Object.fromEntries(
          Object.keys(process.env).map((key) => [key, undefined]),
        );
        Object.assign(env, {
          PATH: process.env.PATH,
          HOME: root,
          ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
          ANTHROPIC_API_KEY: 'fixture-test-only',
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
          DISABLE_TELEMETRY: '1',
          DISABLE_ERROR_REPORTING: '1',
          CAT_CAFE_API_URL: `http://127.0.0.1:${port}`,
          CAT_CAFE_INVOCATION_ID: 'claude-secret-probe',
          CAT_CAFE_CALLBACK_TOKEN: 'fixture-callback',
        });
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 35000);
        try {
          const settings = withClaudeSecretHooks(undefined, root);
          if (carrier === 'sdk') {
            for await (const _event of query({
              prompt: 'Perform the local fixture action.',
              options: {
                env,
                cwd: root,
                model: 'claude-fixture',
                settings,
                settingSources: [],
                strictMcpConfig: true,
                mcpServers: {},
                permissionMode: 'bypassPermissions',
                allowDangerouslySkipPermissions: true,
                abortController: controller,
                persistSession: false,
                tools: ['Bash'],
              },
            })) {
              /* Consume the real SDK process. */
            }
          } else {
            const child = spawn(
              'claude',
              [
                '-p',
                '--verbose',
                '--output-format',
                'stream-json',
                '--model',
                'claude-fixture',
                '--permission-mode',
                'bypassPermissions',
                '--dangerously-skip-permissions',
                '--no-session-persistence',
                '--setting-sources',
                '',
                '--strict-mcp-config',
                '--mcp-config',
                '{"mcpServers":{}}',
                '--tools',
                'Bash',
                '--settings',
                settings,
                'Perform the local fixture action.',
              ],
              { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'], signal: controller.signal },
            );
            let stderr = '';
            child.stderr.on('data', (chunk) => {
              stderr += String(chunk);
            });
            child.stdout.resume();
            const code = await new Promise<number | null>((resolve, reject) => {
              child.on('error', reject);
              child.on('close', resolve);
            });
            assert.equal(code, 0, stderr.replace(/[\r\n].*/s, ''));
          }
          assert.ok(modelCalls >= 2, 'the native tool cycle must reach its result');
          const exists = await import('node:fs').then((fs) => fs.existsSync(marker));
          assert.equal(exists, scenario === 'clean');
          if (scenario === 'blocked')
            assert.match(JSON.stringify(inputs.slice(1)), /secret_content_blocked_before_send/);
          if (scenario === 'exposed') {
            assert.ok(notices.length > 0, 'actual result hook must reach the persistent-message callback');
            assert.equal(notices[0].invocation, 'claude-secret-probe');
            assert.ok(!notices[0].body.includes(fake()));
          }
        } finally {
          clearTimeout(timer);
          controller.abort();
          server.closeAllConnections();
          await new Promise<void>((resolve) => server.close(() => resolve()));
          await rm(root, { recursive: true, force: true });
        }
      },
    );
