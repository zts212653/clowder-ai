import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { auditSpawn } from './bridge-extension.ts';
import { baselineSdk, matchingSdk, nativePath, upstream } from './environment.mjs';

class InputQueue {
  values = [];
  waiters = [];
  closed = false;
  push(value) {
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value, done: false });
    else this.values.push(value);
  }
  close() {
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) waiter({ done: true });
  }
  [Symbol.asyncIterator]() {
    return {
      next: () =>
        this.values.length
          ? Promise.resolve({ value: this.values.shift(), done: false })
          : this.closed
            ? Promise.resolve({ done: true })
            : new Promise((done) => this.waiters.push(done)),
    };
  }
}
function options(state, hookFunctions) {
  return {
    cwd: join(state.dir, 'fixture'),
    env: state.env,
    model: state.model,
    effort: 'low',
    pathToClaudeCodeExecutable: nativePath,
    includePartialMessages: true,
    promptSuggestions: false,
    tools: [],
    allowedTools: [],
    settingSources: [],
    strictMcpConfig: true,
    settings: { disableAllHooks: false, claudeMdExcludes: ['**'] },
    systemPrompt:
      'Only the controlled fixture MCP tool is authorized. Follow the synthetic test prompts. Keep replies brief.',
    maxTurns: 12,
    maxBudgetUsd: 2,
    hooks: hookFunctions,
    extraArgs: { 'debug-file': join(state.dir, 'native-debug.log') },
    mcpServers: {
      fixture: {
        command: process.execPath,
        args: [resolve('scripts/claude-acp-parity-spike/fixture.mjs'), join(state.dir, 'tools.jsonl')],
        env: { CLOWDER_SPIKE_TOOL_TRACE: join(state.dir, 'tools.jsonl') },
      },
    },
  };
}
export async function directTransport(state, variant, record, handleHook) {
  const queue = new InputQueue();
  const { query } = await import(pathToFileURL(variant === 'sdk-original' ? baselineSdk : matchingSdk));
  const { sdkCompactionHooks } = await import(
    pathToFileURL(resolve('packages/api/src/domains/cats/services/agents/providers/claude-sdk-compaction-hooks.ts'))
  );
  const hooks = sdkCompactionHooks(
    {
      preCompact: (input) => handleHook({ input: { hook_event_name: 'PreCompact', ...input } }),
      postCompactContext: async (input) =>
        (await handleHook({ input: { hook_event_name: 'SessionStart', source: 'compact', ...input } }))
          .additionalContext,
    },
    { warn: (params, message) => record({ kind: 'hookFailure', params: String(params?.err), message }) },
  );
  process.env.CLOWDER_SPIKE_PROCESS_TRACE = state.env.CLOWDER_SPIKE_PROCESS_TRACE;
  const controller = new AbortController();
  const q = query({
    prompt: queue,
    options: {
      ...options(state, hooks),
      abortController: controller,
      spawnClaudeCodeProcess: auditSpawn,
      stderr: (data) => record({ kind: 'stderr', data }),
      canUseTool: async (name, input) =>
        name.includes('fixture') &&
        name.endsWith('wait') &&
        ['append', 'steer'].includes(input.phase) &&
        input.delayMs === 8000
          ? { behavior: 'allow', updatedInput: input }
          : { behavior: 'deny', message: 'Outside controlled fixture' },
    },
  });
  let closing = false;
  const pump = (async () => {
    try {
      for await (const raw of q) record({ kind: 'native', raw });
    } catch (error) {
      if (!closing) record({ kind: 'transportError', error: String(error) });
    }
  })();
  return {
    probe: () => q.mcpServerStatus(),
    async input(text, mode = 'append', id = randomUUID()) {
      if (mode === 'steer') {
        record({ kind: 'interruptSent' });
        await q.interrupt();
        record({ kind: 'interruptAcknowledged' });
      }
      queue.push({
        type: 'user',
        uuid: id,
        session_id: '',
        parent_tool_use_id: null,
        message: { role: 'user', content: [{ type: 'text', text }] },
      });
      record({ kind: 'accepted', id, mode });
      return id;
    },
    async close() {
      closing = true;
      queue.close();
      controller.abort();
      q.close();
      await Promise.race([pump, new Promise((done) => setTimeout(done, 6000))]);
    },
    sdk: variant === 'sdk-original' ? '0.3.285' : '0.3.310',
  };
}
export async function acpTransport(state, record, handleHook) {
  const child = spawn(process.execPath, [join(upstream, 'dist/index.js')], {
    env: state.env,
    cwd: join(state.dir, 'fixture'),
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  record({ kind: 'bridgeSpawn', pid: child.pid });
  let buffer = '',
    sequence = 0;
  const pending = new Map();
  const write = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
  const request = (method, params, timeoutMs = 120000) =>
    new Promise((done, reject) => {
      const id = ++sequence;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`ACP timeout ${method}`));
      }, timeoutMs);
      pending.set(id, (message) => {
        clearTimeout(timer);
        pending.delete(id);
        if (message.error) reject(new Error(JSON.stringify(message.error)));
        else done(message.result);
      });
      record({ kind: 'wireOut', message: { id, method, params } });
      write({ jsonrpc: '2.0', id, method, params });
    });
  const incoming = async (message) => {
    record({ kind: 'wireIn', message });
    if (!message.method) return pending.get(message.id)?.(message);
    if (message.method === '_claude/sdkMessage') return record({ kind: 'native', raw: message.params.message });
    if (message.method === '_clowder/spike/v1/hook') {
      try {
        write({ jsonrpc: '2.0', id: message.id, result: await handleHook(message.params) });
      } catch (error) {
        write({ jsonrpc: '2.0', id: message.id, error: { code: -32603, message: String(error) } });
      }
    } else if (message.method === 'session/request_permission') {
      const call = message.params.toolCall;
      const input = call.rawInput;
      const valid =
        String(call.title).includes('wait') && ['append', 'steer'].includes(input?.phase) && input?.delayMs === 8000;
      const option = valid && message.params.options.find((entry) => entry.kind === 'allow_once');
      write({
        jsonrpc: '2.0',
        id: message.id,
        result: { outcome: option ? { outcome: 'selected', optionId: option.optionId } : { outcome: 'cancelled' } },
      });
    } else if (message.id !== undefined)
      write({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Not enabled in proof' } });
  };
  child.stdout.on('data', (chunk) => {
    buffer += chunk.toString();
    while (buffer.includes('\n')) {
      const end = buffer.indexOf('\n');
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      if (line)
        void incoming(JSON.parse(line)).catch((error) => record({ kind: 'transportError', error: String(error) }));
    }
  });
  child.stderr.on('data', (data) => record({ kind: 'stderr', data: data.toString() }));
  child.on('exit', (code, signal) => record({ kind: 'bridgeExit', pid: child.pid, code, signal }));
  const init = await request('initialize', {
    protocolVersion: 1,
    clientCapabilities: { session: { compaction: {} } },
    clientInfo: { name: 'clowder-parity-spike', version: '1' },
  });
  record({ kind: 'initialize', result: init });
  const runKey = randomUUID();
  const baseOptions = options(state, undefined);
  const session = await request('session/new', {
    cwd: baseOptions.cwd,
    mcpServers: [
      {
        name: 'fixture',
        command: process.execPath,
        args: [resolve('scripts/claude-acp-parity-spike/fixture.mjs'), join(state.dir, 'tools.jsonl')],
        env: [{ name: 'CLOWDER_SPIKE_TOOL_TRACE', value: join(state.dir, 'tools.jsonl') }],
      },
    ],
    _meta: {
      clowderParity: { runKey },
      claudeCode: {
        emitRawSDKMessages: true,
        options: {
          tools: [],
          allowedTools: [],
          settingSources: [],
          strictMcpConfig: true,
          settings: baseOptions.settings,
          systemPrompt: baseOptions.systemPrompt,
          model: state.model,
          effort: 'low',
          maxTurns: 12,
          maxBudgetUsd: 2,
          promptSuggestions: false,
        },
      },
    },
  });
  return {
    sdk: '0.3.310',
    async input(text, mode = 'append', id = randomUUID()) {
      const result = await request('_clowder/spike/v1/input', {
        sessionId: session.sessionId,
        runKey,
        mode,
        inputId: id,
        prompt: [{ type: 'text', text }],
      });
      record({ kind: 'accepted', id, mode, result });
      return id;
    },
    async close() {
      if (child.exitCode !== null) return;
      const exited = new Promise((done) => child.once('exit', done));
      child.stdin.end();
      const timer = setTimeout(() => child.kill(), 8000);
      await exited;
      clearTimeout(timer);
    },
  };
}
