// Explicit acceptance: real installed OpenCode CLI + isolated native DB + local deterministic provider.
// Proves native history/ID transport, not upstream account health or model reasoning.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { OpenCodeAgentService } from '../src/domains/cats/services/agents/providers/OpenCodeAgentService.ts';
import { readOpenCodeLocalSessions } from '../src/domains/cats/services/session/import/OpenCodeLocalSessionIndex.ts';
import { inspectOpenCodeLocalSession } from '../src/domains/cats/services/session/import/OpenCodeLocalSessionInspection.ts';

const root = await mkdtemp(join(tmpdir(), 'f322-native-opencode-'));
const original = 'F322-ORIGINAL-NATIVE-HISTORY';
const requests = [];
const server = createServer(async (req, res) => {
  let body = '';
  for await (const part of req) body += part;
  const input = JSON.parse(body);
  requests.push(input);
  const text = input.messages?.some((m) => JSON.stringify(m.content).includes(original)) ? original : 'NO_HISTORY';
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const events = [
    [
      'message_start',
      {
        type: 'message_start',
        message: {
          id: 'msg_proof',
          type: 'message',
          role: 'assistant',
          model: input.model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 12, output_tokens: 0 },
        },
      },
    ],
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    [
      'message_delta',
      { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 6 } },
    ],
    ['message_stop', { type: 'message_stop' }],
  ];
  for (const [event, value] of events) res.write(`event: ${event}\ndata: ${JSON.stringify(value)}\n\n`);
  res.end();
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const port = server.address().port;
const env = {
  PATH: process.env.PATH,
  HOME: root,
  XDG_DATA_HOME: join(root, 'data'),
  XDG_CONFIG_HOME: join(root, 'config'),
  XDG_CACHE_HOME: join(root, 'cache'),
  OPENCODE_CONFIG_CONTENT: JSON.stringify({
    provider: { anthropic: { options: { baseURL: `http://127.0.0.1:${port}/v1`, apiKey: 'local-proof-only' } } },
  }),
  OPENCODE_DISABLE_DEFAULT_PLUGINS: 'true',
  OPENCODE_DISABLE_MODELS_FETCH: 'true',
};
delete env.OPENCODE_CONFIG;
delete env.OPENCODE_DB;
delete env.ANTHROPIC_BASE_URL;
delete env.ANTHROPIC_API_KEY;
let running;
async function native(args) {
  const child = spawn(
    'opencode',
    [
      'run',
      '--pure',
      '--print-logs',
      '--agent',
      'plan',
      '-m',
      'anthropic/claude-sonnet-4-5',
      '--format',
      'json',
      ...args,
    ],
    { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  running = child;
  let stdout = '',
    stderr = '';
  child.stdout.on('data', (part) => {
    stdout += part;
  });
  child.stderr.on('data', (part) => {
    stderr += part;
  });
  const timer = setTimeout(() => child.kill('SIGTERM'), 60_000);
  try {
    const [exitCode] = await once(child, 'close');
    if (exitCode !== 0 && process.env.F322_NATIVE_PROOF_OUT)
      await writeFile(
        process.env.F322_NATIVE_PROOF_OUT + '.failure.json',
        JSON.stringify({ exitCode, stdout, stderr, requestCount: requests.length }, null, 2),
      );
    assert.equal(exitCode, 0, stderr.slice(-1000));
    return stdout
      .split('\n')
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line));
  } finally {
    clearTimeout(timer);
    running = undefined;
  }
}
try {
  await mkdir(join(root, 'config'), { recursive: true });
  await mkdir(join(root, 'cache/opencode'), { recursive: true });
  await copyFile(join(homedir(), '.cache/opencode/models.json'), join(root, 'cache/opencode/models.json'));
  const created = await native(['--', `Remember ${original}. Do not use tools.`]);
  const id = created.find((event) => event.sessionID)?.sessionID;
  assert.match(id, /^ses_/);
  const path = join(root, 'data/opencode/opencode.db');
  const indexed = readOpenCodeLocalSessions(path, { limit: 20 });
  assert.equal(indexed.sessions[0].sessionId, id);
  assert.equal((await inspectOpenCodeLocalSession(path, id)).sessionId, id);
  const before = requests.length;
  const resumed = await native(['--session', id, '--', 'What was the original code word? Do not use tools.']);
  assert.ok(resumed.some((event) => event.type === 'text' && event.part.text === original));
  assert.ok(resumed.every((event) => !event.sessionID || event.sessionID === id));
  assert.ok(requests.slice(before).some((request) => JSON.stringify(request.messages).includes(original)));
  const l0 = 'F322_CURRENT_CAT_NATIVE_SYSTEM_SLOT';
  const instructions = join(root, 'current-cat.md');
  const runtimeConfig = join(root, 'runtime-opencode.json');
  await writeFile(instructions, l0);
  await writeFile(runtimeConfig, JSON.stringify({ instructions: [instructions] }));
  const service = new OpenCodeAgentService({ model: 'anthropic/claude-sonnet-4-5', opencodeDbPath: path });
  const adopted = [];
  const adoptionStart = requests.length;
  for await (const event of service.invoke('What was the original code word? Do not use tools.', {
    sessionId: id,
    requireExactResume: true,
    workingDirectory: root,
    cliConfigArgs: ['--pure', '--agent', 'plan'],
    callbackEnv: { OPENCODE_CONFIG: runtimeConfig },
    accountEnv: { ...env, OPENCODE_CONFIG: runtimeConfig },
    signal: AbortSignal.timeout(60_000),
  }))
    adopted.push(event);
  assert.ok(adopted.some((event) => event.type === 'session_init' && event.sessionId === id));
  assert.ok(adopted.some((event) => event.type === 'text' && event.content.includes(original)));
  assert.ok(!adopted.some((event) => event.type === 'error'));
  assert.ok(requests.slice(adoptionStart).some((request) => JSON.stringify(request.system).includes(l0)));
  const report = {
    provider: 'local deterministic Anthropic protocol fixture',
    realCli: true,
    sessionId: id,
    sameNativeId: true,
    originalHistoryReadFromNativeStore: true,
    nativeCurrentInstructions: true,
    catCafeProviderAdapter: true,
    preflight: 'passed',
    boundedLocalList: true,
    createdEvents: created.length,
    resumedEvents: resumed.length,
    upstreamAccountHealthVerified: false,
  };
  if (process.env.F322_NATIVE_PROOF_OUT)
    await writeFile(process.env.F322_NATIVE_PROOF_OUT, JSON.stringify(report, null, 2) + '\n');
  process.stdout.write(JSON.stringify(report) + '\n');
} finally {
  running?.kill('SIGTERM');
  await new Promise((resolve) => server.close(resolve));
  await rm(root, { recursive: true });
}
