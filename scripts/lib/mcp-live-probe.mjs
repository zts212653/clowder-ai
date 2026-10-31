import { spawn } from 'node:child_process';
import process from 'node:process';

import { resolvePencilCommand } from './mcp-health.mjs';

const DEFAULT_PROBE_TIMEOUT_MS = 2500;
const SLOW_START_PROBE_TIMEOUT_MS = 7000;
const STDERR_LIMIT = 500;

function clip(value, limit = STDERR_LIMIT) {
  const text = String(value ?? '').trim();
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}...`;
}

function normalizeEnv(env) {
  const result = { ...process.env };
  if (!env || typeof env !== 'object') return result;
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === 'string') result[key] = value;
  }
  return result;
}

function normalizeTools(tools) {
  if (!Array.isArray(tools)) return [];
  const seen = new Set();
  const names = [];
  for (const tool of tools) {
    const name = typeof tool?.name === 'string' ? tool.name.trim() : '';
    if (!name || seen.has(name)) continue;
    seen.add(name);
    names.push(name);
  }
  return names;
}

export function resolveLiveProbeTimeoutMs(capability, overrideTimeoutMs) {
  if (typeof overrideTimeoutMs === 'number' && Number.isFinite(overrideTimeoutMs) && overrideTimeoutMs > 0) {
    return overrideTimeoutMs;
  }

  const command = capability?.mcpServer?.command?.toLowerCase() ?? '';
  const args = Array.isArray(capability?.mcpServer?.args) ? capability.mcpServer.args : [];
  const argsLower = args.map((arg) => String(arg).toLowerCase());
  const argsJoined = argsLower.join(' ');

  const isNpxLike = command === 'npx' || command === 'pnpm' || command === 'pnpmx';
  const looksLikePlaywright = argsJoined.includes('playwright');
  const isDlx = argsJoined.includes('dlx') || argsJoined.includes('-y');
  if (isNpxLike && (isDlx || looksLikePlaywright)) return SLOW_START_PROBE_TIMEOUT_MS;

  const isDockerGatewayRun =
    command === 'docker' && argsLower[0] === 'mcp' && argsLower[1] === 'gateway' && argsLower[2] === 'run';
  if (isDockerGatewayRun) return SLOW_START_PROBE_TIMEOUT_MS;

  return DEFAULT_PROBE_TIMEOUT_MS;
}

export async function probeMcpCapabilityLive(capability, options = {}) {
  if (capability?.type !== 'mcp' || !capability.mcpServer) {
    return { connectionStatus: 'unknown', reason: 'not an MCP capability' };
  }

  if (capability.mcpServer.transport === 'streamableHttp') {
    return { connectionStatus: 'unknown', reason: 'live probe currently supports stdio transports only' };
  }

  let command = capability.mcpServer.command;
  let args = Array.isArray(capability.mcpServer.args) ? capability.mcpServer.args : [];
  if ((!command || command.trim().length === 0) && capability.mcpServer.resolver === 'pencil') {
    const resolved = await resolvePencilCommand({ env: options.env ?? process.env, repoRoot: options.projectRoot });
    if (!resolved) return { connectionStatus: 'unknown', reason: 'resolver did not return a command' };
    command = resolved.command;
    args = resolved.args;
  }

  if (!command || command.trim().length === 0) {
    return { connectionStatus: 'unknown', reason: 'missing stdio command' };
  }

  return probeStdioServer({
    command,
    args,
    cwd: capability.mcpServer.workingDir ?? options.projectRoot ?? process.cwd(),
    env: normalizeEnv(capability.mcpServer.env),
    timeoutMs: resolveLiveProbeTimeoutMs(capability, options.timeoutMs),
  });
}

function probeStdioServer({ command, args, cwd, env, timeoutMs }) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let finished = false;
    let stdoutBuffer = '';
    let stderrBuffer = '';
    let initialized = false;

    const finish = (result) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (child.stdin && !child.stdin.destroyed) child.stdin.destroy();
      if (!child.killed && child.exitCode == null) child.kill('SIGTERM');
      resolve({
        durationMs: Date.now() - startedAt,
        ...result,
      });
    };

    const timer = setTimeout(() => {
      finish({
        connectionStatus: 'disconnected',
        reason: `probe timeout after ${timeoutMs}ms${stderrBuffer ? `; stderr: ${clip(stderrBuffer)}` : ''}`,
      });
    }, timeoutMs);

    const send = (message) => {
      if (child.stdin.destroyed) return;
      child.stdin.write(`${JSON.stringify(message)}\n`);
    };

    const handleMessage = (message) => {
      if (message?.id === 1) {
        if (message.error) {
          finish({
            connectionStatus: 'disconnected',
            reason: `initialize error: ${clip(message.error.message ?? JSON.stringify(message.error))}`,
          });
          return;
        }
        initialized = true;
        send({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} });
        send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
        return;
      }

      if (message?.id === 2) {
        if (message.error) {
          finish({
            connectionStatus: 'disconnected',
            reason: `tools/list error: ${clip(message.error.message ?? JSON.stringify(message.error))}`,
          });
          return;
        }
        finish({
          connectionStatus: 'connected',
          tools: normalizeTools(message.result?.tools),
        });
      }
    };

    const parseLine = (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      try {
        handleMessage(JSON.parse(trimmed));
      } catch {
        finish({
          connectionStatus: 'disconnected',
          reason: `invalid JSON on stdout: ${clip(trimmed)}`,
        });
      }
    };

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdoutBuffer += chunk;
      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop() ?? '';
      for (const line of lines) parseLine(line);
    });

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      stderrBuffer = clip(`${stderrBuffer}${chunk}`);
    });

    child.on('error', (error) => {
      finish({
        connectionStatus: 'disconnected',
        reason: `spawn error: ${clip(error.message)}`,
      });
    });

    child.on('exit', (code, signal) => {
      if (stdoutBuffer.trim()) parseLine(stdoutBuffer);
      if (finished) return;
      finish({
        connectionStatus: 'disconnected',
        reason: `process exited before ${initialized ? 'tools/list' : 'initialize'}: code=${code ?? 'null'} signal=${
          signal ?? 'null'
        }${stderrBuffer ? `; stderr: ${clip(stderrBuffer)}` : ''}`,
      });
    });

    send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'cat-cafe-mcp-doctor', version: '0.1.0' },
      },
    });
  });
}
