import { spawn } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCatId } from '@cat-cafe/shared';
import Fastify from 'fastify';
import { InvocationRegistry } from '../../src/domains/cats/services/agents/invocation/InvocationRegistry.ts';
import { COLLECTIVE_WORK_TOOL_NAMES } from '../../src/domains/cats/services/agents/invocation/tool-execution-policy.ts';
import { COLLECTIVE_MCP_ENV_KEYS } from '../../src/domains/cats/services/agents/providers/collective-cli-policy.ts';
import {
  buildCollectiveWorkAuthorityGuardArgs,
  buildCollectiveWorkCodexPolicyArgs,
  buildCollectiveWorkMcpEnv,
  prepareCollectiveWorkDirectory,
} from '../../src/domains/cats/services/agents/providers/collective-work-cli-policy.ts';
import { registerCallbackAuthHook } from '../../src/routes/callback-auth-prehandler.ts';
import { registerNativeTurnAdmissionRoute } from '../../src/routes/callback-native-turn-admission.ts';

/** Installed CLI + scripted local Responses transport; this is sandbox evidence, not a true-model run. */
export async function probePrivateNative() {
  const root = await mkdtemp(join(tmpdir(), 'f290-private-native-'));
  const oldAttempt = await prepareCollectiveWorkDirectory(
    root,
    'probe-owner',
    'private-A',
    'A',
    1,
    'message:admission-A',
  );
  const successor = await prepareCollectiveWorkDirectory(
    root,
    'probe-owner',
    'private-A',
    'A',
    2,
    'message:admission-2',
  );
  const replacement = await prepareCollectiveWorkDirectory(
    root,
    'probe-owner',
    'private-A',
    'A',
    1,
    'message:admission-A',
  );
  const workspace = oldAttempt.workspaceRoot;
  const readOnly = join(root, 'skills');
  await mkdir(readOnly);
  await writeFile(join(successor.workspaceRoot, 'current-result'), 'CURRENT_EXECUTION_2');
  await writeFile(join(replacement.workspaceRoot, 'current-result'), 'REPLACEMENT_ATTEMPT');
  await mkdir(join(root, 'home', '.codex'), { recursive: true });
  const secret = 'F290_PRIVATE_SECRET_CANARY';
  const ownerSecret = join(root, 'owner-secret');
  const allowedFile = join(workspace, 'task-output');
  const revokedFile = join(workspace, 'revoked-output');
  await writeFile(ownerSecret, secret);
  await writeFile(join(readOnly, 'SKILL.md'), 'BOUNDED_SKILL_CANARY');
  const requests = [];
  const callbacks = [];
  let forbiddenNetwork = 0;
  let commands = 0;
  let authorityActive = true;
  const callbackApp = Fastify();
  const registry = new InvocationRegistry();
  registry.setCollectiveWorkAuthorityValidator(async () => {
    if (!authorityActive) throw new Error('revoked');
  });
  const auth = await registry.create(
    'probe-owner',
    createCatId('codex-sol'),
    'private-A',
    undefined,
    undefined,
    {
      mode: 'collective_work',
      taskId: 'A',
      threadId: 'private-A',
      executionRevision: 1,
      executionRef: 'message:admission-A',
      workspaceRoot: workspace,
      readOnlyRoots: [readOnly],
    },
    'probe-source',
    'unknown',
    undefined,
    undefined,
    { v: 1, taskId: 'A', observedRevision: 1, sourceRef: 'message:A', authorityRef: 'message:admission-A' },
  );
  registerCallbackAuthHook(callbackApp, registry);
  registerNativeTurnAdmissionRoute(callbackApp);
  const server = http.createServer(async (req, res) => {
    if (req.url === '/forbidden-network') {
      forbiddenNetwork++;
      res.writeHead(200);
      res.end(secret);
      return;
    }
    if (req.url === '/api/callbacks/native-turn-admission') {
      callbacks.push(req.headers);
      const response = await callbackApp.inject({ url: req.url, headers: req.headers });
      res.writeHead(response.statusCode);
      res.end(response.body);
      authorityActive = false;
      return;
    }
    let body = '';
    for await (const chunk of req) body += chunk;
    const parsed = JSON.parse(body);
    requests.push(parsed);
    const command =
      commands === 0
        ? `env; /bin/cat ${JSON.stringify(ownerSecret)}; /bin/cat ${JSON.stringify(join(readOnly, 'SKILL.md'))}; echo allowed > ${JSON.stringify(allowedFile)}; echo forbidden > ${JSON.stringify(join(root, 'forbidden-output'))}; echo stale > ${JSON.stringify(join(successor.workspaceRoot, 'current-result'))}; echo stale > ${JSON.stringify(join(replacement.workspaceRoot, 'current-result'))}; /bin/ps eww -p $PPID; /usr/bin/curl --max-time 1 --noproxy '*' http://127.0.0.1:${server.address().port}/forbidden-network`
        : commands === 1
          ? `echo revoked > ${JSON.stringify(revokedFile)}`
          : undefined;
    commands++;
    const call = command
      ? {
          type: 'function_call',
          id: `fc_${commands}`,
          call_id: `call_${commands}`,
          name: 'exec_command',
          arguments: JSON.stringify({ cmd: command, login: false, max_output_tokens: 4000 }),
        }
      : undefined;
    const events = [
      { type: 'response.created', response: { id: `response_${commands}`, status: 'in_progress', output: [] } },
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
        id: `response_${commands}`,
        status: 'completed',
        output: call ? [call] : [],
        usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
      },
    });
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
  const args = [
    'exec',
    '--json',
    ...buildCollectiveWorkCodexPolicyArgs({
      mode: 'collective_work',
      taskId: 'A',
      threadId: 'private-A',
      executionRevision: 1,
      executionRef: 'message:admission-A',
      workspaceRoot: workspace,
      readOnlyRoots: [readOnly],
    }),
    ...(await buildCollectiveWorkAuthorityGuardArgs(root)),
    '--config',
    `mcp_servers.cat-cafe-collab.command=${JSON.stringify(process.execPath)}`,
    '--config',
    `mcp_servers.cat-cafe-collab.args=[${JSON.stringify(join(repo, 'packages/mcp-server/dist/collab.js'))}]`,
    '--config',
    `mcp_servers.cat-cafe-collab.env_vars=${JSON.stringify(COLLECTIVE_MCP_ENV_KEYS)}`,
    '--config',
    'mcp_servers.cat-cafe-collab.env={CAT_CAFE_MCP_PROFILE="collective-work"}',
    '--config',
    `mcp_servers.cat-cafe-collab.enabled_tools=${JSON.stringify(COLLECTIVE_WORK_TOOL_NAMES.filter((name) => !['cat_cafe_thread_context', 'cat_cafe_native_turn_admission', 'cat_cafe_refresh_token'].includes(name)))}`,
    '--config',
    'mcp_servers.cat-cafe-collab.required=true',
    '--config',
    'mcp_servers.cat-cafe-collab.default_tools_approval_mode="approve"',
    '--config',
    'model="gpt-5"',
    '--config',
    'model_provider="probe"',
    '--config',
    'model_providers.probe.name="probe"',
    '--config',
    'model_providers.probe.wire_api="responses"',
    '--config',
    `model_providers.probe.base_url="http://127.0.0.1:${port}/v1"`,
    '--config',
    'model_providers.probe.env_key="OPENAI_API_KEY"',
    '--',
    '-',
  ];
  let stdout = '';
  let stderr = '';
  let timedOut = false;
  try {
    const child = spawn('codex', args, {
      cwd: workspace,
      env: {
        PATH: process.env.PATH,
        HOME: join(root, 'home'),
        CODEX_HOME: join(root, 'home', '.codex'),
        OPENAI_API_KEY: secret,
        ...buildCollectiveWorkMcpEnv({}),
        CAT_CAFE_CALLBACK_TOKEN: auth.callbackToken,
        CAT_CAFE_INVOCATION_ID: auth.invocationId,
        CAT_CAFE_USER_ID: 'probe-owner',
        CAT_CAFE_CAT_ID: 'codex-sol',
        CAT_CAFE_THREAD_ID: 'private-A',
        NO_PROXY: '127.0.0.1,localhost',
        no_proxy: '127.0.0.1,localhost',
        PRIVATE_ACCOUNT_SECRET: secret,
        CAT_CAFE_API_URL: `http://127.0.0.1:${port}`,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    child.stdin.end('Execute only the admitted Task.');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, 45000);
    const exitCode = await new Promise((resolve, reject) => {
      child.on('error', reject);
      child.on('close', resolve);
    });
    clearTimeout(timer);
    const exists = (path) =>
      access(path).then(
        () => true,
        () => false,
      );
    return {
      exitCode,
      stdout,
      stderr,
      requests,
      callbacks,
      timedOut,
      secret,
      allowed: await readFile(allowedFile, 'utf8').catch(() => ''),
      forbidden: await exists(join(root, 'forbidden-output')),
      revoked: await exists(revokedFile),
      forbiddenNetwork,
      callbackToken: auth.callbackToken,
      successorResult: await readFile(join(successor.workspaceRoot, 'current-result'), 'utf8'),
      replacementResult: await readFile(join(replacement.workspaceRoot, 'current-result'), 'utf8'),
    };
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await callbackApp.close();
    await rm(root, { recursive: true, force: true });
  }
}
