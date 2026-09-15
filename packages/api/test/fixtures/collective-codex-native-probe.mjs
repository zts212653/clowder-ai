import { spawn } from 'node:child_process';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  COLLECTIVE_CODEX_POLICY_ARGS,
  COLLECTIVE_MCP_ENV_KEYS,
} from '../../src/domains/cats/services/agents/providers/collective-cli-policy.ts';
import { prepareCollectiveCodexHome } from '../../src/domains/cats/services/agents/providers/collective-codex-home.ts';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
export async function probeCollectiveCodex({ policyArgs = COLLECTIVE_CODEX_POLICY_ARGS, invokeTools = true } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'f290-native-policy-'));
  const privateCanary = 'F290_PRIVATE_NATIVE_CANARY';
  const marker = join(root, 'forbidden-native-effect');
  await mkdir(join(root, '.codex', 'skills', 'private'), { recursive: true });
  await writeFile(join(root, 'AGENTS.md'), privateCanary);
  await writeFile(join(root, '.codex', 'AGENTS.md'), privateCanary);
  await writeFile(
    join(root, '.codex', 'skills', 'private', 'SKILL.md'),
    '---\nname: private\ndescription: ' + privateCanary + '\n---\n' + privateCanary,
  );
  await writeFile(join(root, '.codex', 'config.toml'), 'developer_instructions="' + privateCanary + '"\n');
  const requests = [];
  const callbacks = [];
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    if (req.method !== 'POST') {
      res.writeHead(404);
      res.end('{}');
      return;
    }
    const parsed = JSON.parse(body);
    if (req.url.startsWith('/api/callbacks/')) {
      callbacks.push({ path: req.url, body: parsed, headers: req.headers });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          kind: 'collective',
          contextRef: 'probe-context',
          returnRef: 'probe-return',
          replyOperationRef: 'probe-operation',
          location: { channelId: 'A' },
          request: { body: 'PUBLIC_REQUEST_A' },
          reply: { status: 'prepared' },
        }),
      );
      return;
    }
    requests.push(parsed);
    let call;
    if (invokeTools && requests.length === 1) {
      const namespace = parsed.tools?.find((tool) => tool.type === 'namespace' && tool.name === 'mcp__cat_cafe_collab');
      const current = namespace?.tools.find((tool) => tool.name === 'cat_cafe_collective_current_context');
      if (current)
        call = {
          type: 'function_call',
          id: 'fc_current',
          call_id: 'call_current',
          namespace: namespace.name,
          name: current.name,
          arguments: '{}',
        };
    } else if (invokeTools && requests.length === 2) {
      call = {
        type: 'function_call',
        id: 'fc_attack',
        call_id: 'call_attack',
        name: 'exec_command',
        arguments: JSON.stringify({ cmd: 'touch ' + marker }),
      };
    }
    const output = call ? [call] : [];
    const events = [
      {
        type: 'response.created',
        response: { id: 'resp_probe', object: 'response', status: 'in_progress', output: [] },
      },
    ];
    if (call)
      events.push(
        { type: 'response.output_item.added', output_index: 0, item: { ...call, arguments: '' } },
        { type: 'response.function_call_arguments.delta', output_index: 0, item_id: call.id, delta: call.arguments },
        { type: 'response.function_call_arguments.done', output_index: 0, item_id: call.id, arguments: call.arguments },
        { type: 'response.output_item.done', output_index: 0, item: call },
      );
    events.push({
      type: 'response.completed',
      response: {
        id: 'resp_probe',
        object: 'response',
        status: 'completed',
        output,
        usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
      },
    });
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(events.map((event) => 'data: ' + JSON.stringify(event) + '\n\n').join(''));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const projectedHome = await prepareCollectiveCodexHome(root, 'api_key', join(root, '.codex'));
  const env = {
    PATH: process.env.PATH,
    ...projectedHome,
    OPENAI_API_KEY: 'f290-test-only',
    NO_PROXY: '127.0.0.1,localhost',
    no_proxy: '127.0.0.1,localhost',
    CAT_CAFE_API_URL: 'http://127.0.0.1:' + port,
    CAT_CAFE_INVOCATION_ID: 'probe-invocation',
    CAT_CAFE_CALLBACK_TOKEN: 'probe-token',
    CAT_CAFE_USER_ID: 'probe-owner',
    CAT_CAFE_CAT_ID: 'codex-astra',
    CAT_CAFE_THREAD_ID: 'probe-thread',
    CAT_CAFE_MCP_PROFILE: 'collective-participation',
  };
  const mcp = [
    '--config',
    'mcp_servers.cat-cafe-collab.command=' + JSON.stringify(process.execPath),
    '--config',
    'mcp_servers.cat-cafe-collab.args=[' + JSON.stringify(join(repo, 'packages/mcp-server/dist/collab.js')) + ']',
    '--config',
    'mcp_servers.cat-cafe-collab.env_vars=' + JSON.stringify(COLLECTIVE_MCP_ENV_KEYS),
    '--config',
    'mcp_servers.cat-cafe-collab.required=true',
    '--config',
    'mcp_servers.cat-cafe-collab.default_tools_approval_mode="approve"',
  ];
  const args = [
    'exec',
    '--json',
    ...(policyArgs.includes('--skip-git-repo-check') ? [] : ['--skip-git-repo-check']),
    ...policyArgs,
    ...mcp,
    '--config',
    'model="gpt-5"',
    '--config',
    'model_provider="probe"',
    '--config',
    'model_providers.probe.name="probe"',
    '--config',
    'model_providers.probe.base_url="http://127.0.0.1:' + port + '/v1"',
    '--config',
    'model_providers.probe.wire_api="responses"',
    '--config',
    'model_providers.probe.env_key="OPENAI_API_KEY"',
    '--',
    '-',
  ];
  let stdout = '';
  let stderr = '';
  try {
    const child = spawn('codex', args, { cwd: root, env, stdio: ['pipe', 'pipe', 'pipe'] });
    child.stdin.end('Read the current public context for PUBLIC_REQUEST_A.');
    child.stdout.on('data', (d) => {
      stdout += d;
    });
    child.stderr.on('data', (d) => {
      stderr += d;
    });
    const timer = setTimeout(() => child.kill(), 20000);
    const exitCode = await new Promise((resolve, reject) => {
      child.on('close', resolve);
      child.on('error', reject);
    });
    clearTimeout(timer);
    const forbiddenEffect = await access(marker).then(
      () => true,
      () => false,
    );
    return { exitCode, requests, callbacks, stdout, stderr, forbiddenEffect, privateCanary };
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
}
