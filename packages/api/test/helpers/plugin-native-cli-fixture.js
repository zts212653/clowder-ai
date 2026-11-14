import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { catRegistry } from '@cat-cafe/shared';
import { prepareCodexNativeLaunch } from '../../dist/domains/cats/services/agents/providers/codex-plugin-native-launch.js';
import { captureInvocationL0Input } from '../../dist/domains/cats/services/agents/providers/l0-input-capture.js';
import { writeMcpProbe } from './mcp-probe.js';

function wireToolNames(tools, prefix = '') {
  return (tools ?? []).flatMap((tool) => {
    const name = prefix ? `${prefix}.${tool.name}` : tool.name;
    return tool.type === 'namespace' ? wireToolNames(tool.tools, name) : [name];
  });
}

function codeCall(id, input) {
  return { type: 'custom_tool_call', id, call_id: id, namespace: 'functions', name: 'exec', input };
}

const delegation = {
  task_name: 'forbidden_child',
  message: 'F329_FIXTURE_CHILD: return the fixed word DONE.',
  fork_turns: 'none',
};

/** Real CLI, real production launch fence, local Responses and a single admitted MCP; no real account IO. */
export async function pluginNativeCliFixture({ model, kind = 'scoped-member', cli, omitDelegationFence = false }) {
  const root = await mkdtemp(join(tmpdir(), 'f329-native-boundary-'));
  const workspace = join(root, 'workspace');
  await mkdir(workspace, { mode: 0o700 });
  const marker = join(root, 'mcp-called');
  const script = join(root, 'admitted.mjs');
  writeMcpProbe(
    script,
    `const {appendFileSync}=await import('node:fs');appendFileSync(${JSON.stringify(marker)},${JSON.stringify('positive\n')});return {admitted:'F329_MCP_POSITIVE'};`,
  );
  const requests = [];
  let parentRound = 0;
  const server = http.createServer(async (req, res) => {
    if (req.method !== 'POST' || req.url !== '/v1/responses') {
      res.writeHead(404);
      res.end('{}');
      return;
    }
    let bytes = '';
    for await (const chunk of req) bytes += chunk;
    const body = JSON.parse(bytes);
    const metadata = JSON.parse(body.client_metadata?.['x-codex-turn-metadata'] ?? '{}');
    const child = typeof metadata.agent_name === 'string' && metadata.agent_name !== '/root';
    requests.push({ child, agentName: metadata.agent_name, body });
    if (requests.length > 12) {
      res.writeHead(429);
      res.end(JSON.stringify({ error: 'fixture request ceiling' }));
      return;
    }
    const id = `fixture-${requests.length}`;
    let output;
    if (child) {
      output = {
        type: 'message',
        id,
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: 'DONE' }],
      };
    } else {
      const round = parentRound++;
      if (round === 0) {
        // These two builtin model modes advertise their tool definitions in prompt text,
        // not necessarily in Responses.tools. Exercise their actual code-mode dispatcher.
        output = codeCall(
          id,
          'text({toolNames:ALL_TOOLS.map(x=>x.name).sort()});const p=ALL_TOOLS.find(x=>x.name.endsWith("__probe"));if(!p)throw Error("admitted probe missing");text(await tools[p.name]({}));',
        );
      } else if (round === 1) {
        output = {
          type: 'function_call',
          id,
          call_id: id,
          namespace: 'collaboration',
          name: 'spawn_agent',
          arguments: JSON.stringify(delegation),
        };
      } else if (round === 2) {
        output = codeCall(
          id,
          [
            'text({toolNames:ALL_TOOLS.map(x=>x.name).sort()});',
            'const nested=ALL_TOOLS.filter(x=>/spawn_agent|collaboration|multi_agent/i.test(x.name));',
            'text({nestedDelegationNames:nested.map(x=>x.name)});',
            `for(const item of nested.filter(x=>/spawn_agent/.test(x.name)))try{text({nestedResult:await tools[item.name](${JSON.stringify(delegation)})})}catch(error){text({nestedError:String(error)})}`,
            `try{text({directNestedResult:await tools.spawn_agent(${JSON.stringify(delegation)})})}catch(error){text({directNestedError:String(error)})}`,
          ].join(''),
        );
      } else if (round === 3) {
        output = {
          type: 'function_call',
          id,
          call_id: id,
          namespace: 'multi_agent_v1',
          name: 'spawn_agent',
          arguments: JSON.stringify({ message: delegation.message, fork_context: false }),
        };
      } else {
        output = {
          type: 'message',
          id,
          role: 'assistant',
          status: 'completed',
          content: [{ type: 'output_text', text: 'F329_FIXTURE_ROOT_DONE' }],
        };
      }
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const [type, payload] of [
      ['response.created', { response: { id, status: 'in_progress', output: [] } }],
      ['response.output_item.added', { output_index: 0, item: output }],
      ['response.output_item.done', { output_index: 0, item: output }],
      [
        'response.completed',
        {
          response: {
            id,
            status: 'completed',
            model: body.model,
            output: [output],
            usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
          },
        },
      ],
    ])
      res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`);
    res.end();
  });
  let prepared, report;
  let stdout = '',
    stderr = '',
    timedOut = false;
  try {
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    const options = {
      signal: AbortSignal.timeout(40000),
      workingDirectory: workspace,
      toolExecutionPolicy: {
        mode: 'plugin_native',
        pluginInstanceId: 'fixture-instance',
        contributionId: 'fixture-member',
      },
      pluginNativeLaunch: {
        sandbox: { kind, workspaceRoot: workspace },
        server: {
          name: 'plugin_fixture',
          transport: 'stdio',
          command: process.execPath,
          args: [script],
          workingDirectory: root,
          env: { CLOWDER_PLUGIN_ACTION_TOKEN: 'fixture-activation' },
        },
        async assertCurrent() {},
      },
      callbackEnv: {
        CODEX_AUTH_MODE: 'api_key',
        CAT_CAFE_INVOCATION_ID: 'fixture-invocation',
        CAT_CAFE_CALLBACK_TOKEN: 'fixture-callback',
      },
      accountEnv: { OPENAI_API_KEY: 'fixture-not-a-real-key' },
    };
    if (kind === 'scoped-member')
      options.frozenL0Input = captureInvocationL0Input({
        catId: 'codex',
        catConfig: catRegistry.getOrThrow('codex').config,
        model,
        projection: kind,
      });
    prepared = await prepareCodexNativeLaunch(options, 'exec_json', true, 'codex', model);
    // Test-only ablation proves that a renamed or unavailable attack cannot make denial checks vacuous.
    const launchArgs = [];
    for (let i = 0; i < prepared.args.length; i++) {
      if (
        omitDelegationFence &&
        prepared.args[i] === '--config' &&
        /^(agents\.enabled|features\.multi_agent_v2)=/.test(prepared.args[i + 1])
      ) {
        i++;
        continue;
      }
      launchArgs.push(prepared.args[i]);
    }
    const args = [
      'exec',
      '--json',
      '--model',
      model,
      '--sandbox',
      'read-only',
      ...launchArgs,
      '--config',
      'model_provider="fixture"',
      '--config',
      'model_providers.fixture.name="Local fixed Responses"',
      '--config',
      `model_providers.fixture.base_url="http://127.0.0.1:${port}/v1"`,
      '--config',
      'model_providers.fixture.wire_api="responses"',
      '--config',
      'model_providers.fixture.env_key="OPENAI_API_KEY"',
      '--',
      '-',
    ];
    // Loopback fixture transport only; do not let the OS proxy route this to any remote service.
    const env = { ...prepared.env, NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost' };
    // No process.env inheritance: even proxies and real credential homes are absent.
    const child = spawn(cli, args, {
      cwd: workspace,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });
    const exit = new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => resolve({ code, signal }));
    });
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.stdin.end('F329 fixture root. Use only the admitted MCP. Do not create other agents.');
    const terminate = (signal) => {
      try {
        if (process.platform === 'win32') child.kill(signal);
        else process.kill(-child.pid, signal);
      } catch (error) {
        if (error.code !== 'ESRCH') throw error;
      }
    };
    let forceTimer;
    const timer = setTimeout(() => {
      timedOut = true;
      terminate('SIGTERM');
      forceTimer = setTimeout(() => terminate('SIGKILL'), 2000);
    }, 30000);
    let status;
    try {
      status = await exit;
    } finally {
      clearTimeout(timer);
      clearTimeout(forceTimer);
    }
    const parent = requests.filter((r) => !r.child);
    const outputs = [
      ...new Map(
        parent
          .flatMap((r) => r.body.input ?? [])
          .filter((r) => r.type === 'function_call_output' || r.type === 'custom_tool_call_output')
          .map((r) => [r.call_id, r]),
      ).values(),
    ];
    const mcpCalls = await readFile(marker, 'utf8').catch(() => '');
    report = {
      model,
      kind,
      omitDelegationFence,
      status,
      timedOut,
      mcpCalls: mcpCalls.split('\n').filter(Boolean).length,
      parentRequests: parent.length,
      childRequests: requests.filter((r) => r.child).length,
      wireTools: wireToolNames([
        ...(parent[0]?.body.tools ?? []),
        ...(parent[0]?.body.input ?? []).filter((i) => i.type === 'additional_tools').flatMap((i) => i.tools),
      ]),
      outputs,
      requests,
      stdout,
      stderr,
      launch: { args, envKeys: Object.keys(env).sort(), credentialValues: 'fixture-only', cwdPrivate: true },
    };
    return report;
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    prepared?.dispose();
    await rm(root, { recursive: true, force: true });
    if (report) {
      report.fixtureClosed = !server.listening && !existsSync(root) && !existsSync(prepared.env.CODEX_HOME);
      if (process.env.F329_NATIVE_EVIDENCE_DIR) {
        const target = join(
          process.env.F329_NATIVE_EVIDENCE_DIR,
          `${kind}-${model}${omitDelegationFence ? '-ablation' : ''}.json`,
        );
        await writeFile(target, `${JSON.stringify(report, null, 2)}\n`);
      }
    }
  }
}
