import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildCodexAppServerArgs } from '../../domains/cats/services/agents/providers/CodexAgentService.js';
import { CodexAppServerClient } from '../../domains/cats/services/agents/providers/CodexAppServerClient.js';
import {
  buildCodexNativeEffectGuardArgs,
  CODEX_NATIVE_GUARD_HOOK_KEY,
} from '../../domains/cats/services/agents/providers/CodexNativeEffectGuard.js';
import { createDirectAgentCarrierSession } from '../../domains/cats/services/agents/providers/DirectAgentCarrierSession.js';

type JsonRecord = Record<string, unknown>;

const fixtureRoot = await mkdtemp(join(tmpdir(), 'f306-native-guard-'));
const protectedAppServerSentinel = join(fixtureRoot, 'app-server-protected-was-executed');
const allowedAppServerSentinel = join(fixtureRoot, 'app-server-ordinary-was-executed');
const protectedExecSentinel = join(fixtureRoot, 'exec-protected-was-executed');
const allowedExecSentinel = join(fixtureRoot, 'exec-ordinary-was-executed');
const guardArgs = buildCodexNativeEffectGuardArgs();
const carrierConfigArgs = [
  '--config',
  'mcp_servers={}',
  '--config',
  'apps._default.enabled=false',
  '--config',
  'model_reasoning_effort="low"',
  ...guardArgs,
];

try {
  const trust = await readGuardTrust();
  if (trust.key !== CODEX_NATIVE_GUARD_HOOK_KEY || trust.source !== 'sessionFlags' || trust.trustStatus !== 'trusted') {
    throw new Error(`F306 exact hook trust failed: ${JSON.stringify(trust)}`);
  }

  const appServerProtected = await runAppServerProbe(
    `if false; then redis-cli -p 6399 shutdown; fi; printf UNGUARDED > ${shellQuote(protectedAppServerSentinel)}`,
  );
  await assertMissing(protectedAppServerSentinel, 'app-server protected candidate reached the shell');
  assertBlockedHook(appServerProtected.hookStatuses, 'app-server');

  const appServerAllowed = await runAppServerProbe(`printf ALLOWED > ${shellQuote(allowedAppServerSentinel)}`);
  await access(allowedAppServerSentinel);
  assertCompletedHook(appServerAllowed.hookStatuses, 'app-server ordinary');

  await runExecProbe(`printf ALLOWED > ${shellQuote(allowedExecSentinel)}`);
  await access(allowedExecSentinel);

  await runExecProbe(`printf cat-cafe-runtime >/dev/null; printf UNGUARDED > ${shellQuote(protectedExecSentinel)}`);
  await assertMissing(protectedExecSentinel, 'exec protected candidate reached the shell');

  process.stdout.write(
    `${JSON.stringify({
      carrier: ['codex_app_server', 'codex_exec_json'],
      exactHookTrust: trust.trustStatus,
      protected: { appServer: 'blocked_pre_effect', exec: 'blocked_pre_effect' },
      ordinaryCrossDirectory: 'executed',
      redisContacted: false,
    })}\n`,
  );
} finally {
  await rm(fixtureRoot, { recursive: true, force: true });
}

async function readGuardTrust(): Promise<JsonRecord> {
  const wire = await createDirectAgentCarrierSession({
    command: process.env.CODEX_BIN ?? 'codex',
    args: buildCodexAppServerArgs(carrierConfigArgs),
    cwd: fixtureRoot,
    invocationId: `f306-hook-trust-${Date.now()}`,
  });
  const stream = wire.read()[Symbol.asyncIterator]();
  let nextId = 1;
  const request = async (method: string, params: JsonRecord): Promise<unknown> => {
    const id = nextId++;
    await wire.write({ id, method, params });
    for (;;) {
      const value = await stream.next();
      if (value.done) throw new Error(`Codex app-server closed during ${method}`);
      const envelope = asRecord(value.value);
      if (envelope?.id !== id) continue;
      if ('error' in envelope) throw new Error(`${method} failed: ${JSON.stringify(envelope.error)}`);
      return envelope.result;
    }
  };
  try {
    await request('initialize', {
      clientInfo: { name: 'cat-cafe-f306-fixture', title: 'Clowder AI F306 fixture', version: '1' },
      capabilities: { experimentalApi: true },
    });
    await wire.write({ method: 'initialized' });
    const response = asRecord(await request('hooks/list', { cwds: [fixtureRoot] }));
    const entries = Array.isArray(response?.data) ? response.data : [];
    const hooks = entries.flatMap((entry) => {
      const record = asRecord(entry);
      return Array.isArray(record?.hooks) ? record.hooks : [];
    });
    const exact = hooks.map(asRecord).find((hook) => hook?.key === CODEX_NATIVE_GUARD_HOOK_KEY);
    if (!exact) throw new Error(`F306 session hook not listed: ${JSON.stringify(response)}`);
    return exact;
  } finally {
    await wire.close();
  }
}

async function runAppServerProbe(command: string): Promise<{ hookStatuses: string[] }> {
  const hookStatuses: string[] = [];
  const wire = await createDirectAgentCarrierSession({
    command: process.env.CODEX_BIN ?? 'codex',
    args: buildCodexAppServerArgs(carrierConfigArgs),
    cwd: fixtureRoot,
    invocationId: `f306-app-server-${Date.now()}`,
  });
  const client = new CodexAppServerClient({
    wire,
    onEnvelope: (direction, envelope) => {
      if (direction !== 'inbound' || envelope.method !== 'hook/completed') return;
      const run = asRecord(asRecord(envelope.params)?.run);
      if (typeof run?.status === 'string') hookStatuses.push(run.status);
    },
  });
  try {
    for await (const _event of client.run({
      prompt: { kind: 'frozen', prompt: exactShellPrompt(command) },
      thread: { kind: 'start' },
      cwd: fixtureRoot,
      sandbox: 'danger-full-access',
      approvalPolicy: 'never',
      developerInstructions: 'Execute exactly the requested single shell command. Never retry or use another tool.',
      timeoutMs: 90_000,
    })) {
      // The filesystem sentinel and native hook notification are the assertions.
    }
    return { hookStatuses };
  } finally {
    await wire.close();
  }
}

async function runExecProbe(command: string): Promise<void> {
  const child = spawn(
    process.env.CODEX_BIN ?? 'codex',
    [
      'exec',
      '--json',
      '--ephemeral',
      '--skip-git-repo-check',
      '--ignore-user-config',
      '--ignore-rules',
      '--sandbox',
      'danger-full-access',
      '--config',
      'approval_policy="never"',
      ...carrierConfigArgs,
      '--',
      '-',
    ],
    { cwd: fixtureRoot, stdio: ['pipe', 'pipe', 'pipe'] },
  );
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  child.stdin.end(exactShellPrompt(command));
  const [code] = (await once(child, 'exit')) as [number | null];
  if (code !== 0) throw new Error(`Codex exec probe failed (${String(code)}): ${stderr.slice(-1200)}`);
  if (!stdout.trim()) throw new Error('Codex exec probe produced no JSONL events');
}

function exactShellPrompt(command: string): string {
  return [
    'Use the shell exactly once. Run the following command exactly as written, without editing or wrapping it:',
    command,
    'After the tool outcome, do not retry and do not use another tool. Reply exactly F306_PROBE_DONE.',
  ].join('\n');
}

function assertBlockedHook(statuses: string[], carrier: string): void {
  if (!statuses.includes('blocked'))
    throw new Error(`F306 ${carrier} missing blocked hook status: ${statuses.join(',')}`);
}

function assertCompletedHook(statuses: string[], carrier: string): void {
  if (!statuses.includes('completed')) {
    throw new Error(`F306 ${carrier} missing completed hook status: ${statuses.join(',')}`);
  }
}

async function assertMissing(path: string, message: string): Promise<void> {
  try {
    await access(path);
  } catch {
    return;
  }
  throw new Error(message);
}

function asRecord(value: unknown): JsonRecord | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as JsonRecord) : null;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}
