import { spawn } from 'node:child_process';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CODEX_LIVE_POLICY_ARGS } from '../../src/domains/cats/services/agents/providers/codex-live-policy.ts';

const MCP_ENV_KEYS = [
  'CAT_CAFE_API_URL',
  'CAT_CAFE_INVOCATION_ID',
  'CAT_CAFE_CALLBACK_TOKEN',
  'CAT_CAFE_USER_ID',
  'CAT_CAFE_CAT_ID',
  'CAT_CAFE_THREAD_ID',
];

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
export async function probeCodexNativePolicy({
  policyArgs = CODEX_LIVE_POLICY_ARGS,
  invokeTools = true,
  codeMode = false,
  nativeSubtask = false,
} = {}) {
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
  const startedAt = Date.now();
  let firstRequestAt = null;
  let firstCallbackAt = null;
  let spawnIssued = false;
  let waitIssued = false;
  let childRequestCount = 0;
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    if (req.method === 'GET' && req.url.startsWith('/api/callbacks/thread-context')) {
      firstCallbackAt ??= Date.now();
      callbacks.push({ path: req.url, headers: req.headers });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ threadId: 'probe-thread', contextScope: 'history', messages: [], hasMore: false }));
      return;
    }
    if (req.method !== 'POST') {
      res.writeHead(404);
      res.end('{}');
      return;
    }
    const parsed = JSON.parse(body);
    firstRequestAt ??= Date.now();
    requests.push(parsed);
    let call;
    let finalText;
    if (nativeSubtask) {
      const user = [...(parsed.input ?? [])].reverse().find((row) => row.role === 'user');
      const child = JSON.stringify(user?.content ?? '').includes('F317_CHILD_FIXED_INPUT');
      if (child) {
        childRequestCount++;
        finalText = 'F317_CHILD_SUMMARY';
      } else if (!spawnIssued) {
        spawnIssued = true;
        call = {
          type: 'function_call',
          id: 'fc_spawn',
          call_id: 'call_spawn',
          namespace: 'multi_agent_v1',
          name: 'spawn_agent',
          arguments: JSON.stringify({
            message:
              'F317_CHILD_FIXED_INPUT: summarize only this supplied sentence; return F317_CHILD_SUMMARY. No tools or data reads.',
            fork_context: false,
          }),
        };
      } else if (!waitIssued) {
        const output = parsed.input?.find((row) => row.type === 'function_call_output' && row.call_id === 'call_spawn');
        let agent;
        try {
          agent = JSON.parse(output?.output ?? '{}').agent_id;
        } catch {
          /* recorded below as unavailable */
        }
        if (typeof agent === 'string') {
          waitIssued = true;
          call = {
            type: 'function_call',
            id: 'fc_wait',
            call_id: 'call_wait',
            namespace: 'multi_agent_v1',
            name: 'wait_agent',
            arguments: JSON.stringify({ targets: [agent], timeout_ms: 10000 }),
          };
        } else finalText = 'F317_SPAWN_RESULT_UNAVAILABLE';
      } else finalText = 'F317_ROOT_ACK';
    } else if (invokeTools && requests.length === 1 && codeMode) {
      call = {
        type: 'custom_tool_call',
        id: 'fc_current',
        call_id: 'call_current',
        namespace: 'functions',
        name: 'exec',
        input: [
          'text({shell:typeof tools.exec_command,patch:typeof tools.apply_patch,process:typeof process,require:typeof require,fetch:typeof fetch,WebSocket:typeof WebSocket,XMLHttpRequest:typeof XMLHttpRequest});',
          'text({toolNames:Object.keys(tools).sort()});',
          "let importResult;try{await import('node:fs');importResult='allowed'}catch(error){importResult=String(error)}text({importResult});",
          'text({resourceResult:await tools.list_mcp_resources({})});',
          'text(await tools.mcp__cat_cafe_collab__cat_cafe_get_thread_context({}));',
        ].join(''),
      };
    } else if (invokeTools && requests.length === 1) {
      const namespace = parsed.tools?.find((tool) => tool.type === 'namespace' && tool.name === 'mcp__cat_cafe_collab');
      const current = namespace?.tools.find((tool) => tool.name === 'cat_cafe_get_thread_context');
      if (current)
        call = {
          type: 'function_call',
          id: 'fc_current',
          call_id: 'call_current',
          namespace: namespace.name,
          name: current.name,
          arguments: '{}',
        };
    } else if (invokeTools && requests.length === 2 && !codeMode) {
      call = {
        type: 'function_call',
        id: 'fc_attack',
        call_id: 'call_attack',
        name: 'exec_command',
        arguments: JSON.stringify({ cmd: 'touch ' + marker }),
      };
    }
    const final = finalText
      ? {
          type: 'message',
          id: `msg_probe_${requests.length}`,
          role: 'assistant',
          phase: 'final_answer',
          content: [{ type: 'output_text', text: finalText, annotations: [] }],
        }
      : undefined;
    const output = call ? [call] : final ? [final] : [];
    const events = [
      {
        type: 'response.created',
        response: { id: 'resp_probe', object: 'response', status: 'in_progress', output: [] },
      },
    ];
    if (call)
      events.push(
        { type: 'response.output_item.added', output_index: 0, item: { ...call, arguments: '' } },
        ...(call.type === 'custom_tool_call'
          ? [{ type: 'response.custom_tool_call_input.delta', output_index: 0, item_id: call.id, delta: call.input }]
          : [
              {
                type: 'response.function_call_arguments.delta',
                output_index: 0,
                item_id: call.id,
                delta: call.arguments,
              },
              {
                type: 'response.function_call_arguments.done',
                output_index: 0,
                item_id: call.id,
                arguments: call.arguments,
              },
            ]),
        { type: 'response.output_item.done', output_index: 0, item: call },
      );
    if (final)
      events.push(
        { type: 'response.output_item.added', output_index: 0, item: { ...final, content: [] } },
        {
          type: 'response.content_part.added',
          output_index: 0,
          item_id: final.id,
          content_index: 0,
          part: { type: 'output_text', text: '', annotations: [] },
        },
        { type: 'response.output_text.delta', output_index: 0, item_id: final.id, content_index: 0, delta: finalText },
        { type: 'response.output_text.done', output_index: 0, item_id: final.id, content_index: 0, text: finalText },
        {
          type: 'response.content_part.done',
          output_index: 0,
          item_id: final.id,
          content_index: 0,
          part: final.content[0],
        },
        { type: 'response.output_item.done', output_index: 0, item: final },
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
  const isolatedHome = join(root, 'isolated-home');
  await mkdir(join(isolatedHome, '.codex'), { recursive: true });
  const projectedHome = { HOME: isolatedHome, CODEX_HOME: join(isolatedHome, '.codex') };
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
  };
  const mcp = [
    '--config',
    'mcp_servers.cat-cafe-collab.command=' + JSON.stringify(process.execPath),
    '--config',
    'mcp_servers.cat-cafe-collab.args=[' + JSON.stringify(join(repo, 'packages/mcp-server/dist/collab.js')) + ']',
    '--config',
    'mcp_servers.cat-cafe-collab.env_vars=' + JSON.stringify(MCP_ENV_KEYS),
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
    ...(codeMode ? ['--enable', 'code_mode', '--enable', 'code_mode_only'] : []),
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
  let timedOut = false;
  let killSent = false;
  let childExitAt = null;
  try {
    const child = spawn('codex', args, { cwd: root, env, stdio: ['pipe', 'pipe', 'pipe'] });
    child.on('exit', () => {
      childExitAt = Date.now();
    });
    child.stdin.end('Read the current public context for PUBLIC_REQUEST_A.');
    child.stdout.on('data', (d) => {
      stdout += d;
    });
    child.stderr.on('data', (d) => {
      stderr += d;
    });
    // The fixture runs a real native CLI and local MCP child inside a parallel full gate.
    // A cold process under load must finish its positive control before this guard fires.
    const timer = setTimeout(() => {
      timedOut = true;
      killSent = child.kill();
    }, 45000);
    const closed = await new Promise((resolve, reject) => {
      child.on('close', (code, signal) => resolve({ code, signal }));
      child.on('error', reject);
    });
    clearTimeout(timer);
    const forbiddenEffect = await access(marker).then(
      () => true,
      () => false,
    );
    return {
      exitCode: closed.code,
      exitSignal: closed.signal,
      requests,
      childRequestCount,
      callbacks,
      stdout,
      stderr,
      forbiddenEffect,
      privateCanary,
      timedOut,
      timing: {
        firstRequestMs: firstRequestAt === null ? null : firstRequestAt - startedAt,
        firstCallbackMs: firstCallbackAt === null ? null : firstCallbackAt - startedAt,
        childExitMs: childExitAt === null ? null : childExitAt - startedAt,
        childCloseMs: Date.now() - startedAt,
        killSent,
      },
    };
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
}
