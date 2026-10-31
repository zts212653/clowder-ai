/** Optional pinned local CLI proof: loopback provider, fake tokens, empty config, no external model calls. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { composeClaudeTokenSettingsDocument } from '../src/config/claude-token-settings.ts';

const root = mkdtempSync(join(tmpdir(), 'f320-claude-native-'));
const tokens = ['sk-ant-oat01-fixture-account-A', 'sk-ant-oat01-fixture-account-B'];
if (process.env.F320_POISON_AUTH === '1') {
  mkdirSync(join(root, 'config'), { recursive: true });
  writeFileSync(
    join(root, 'config/settings.json'),
    JSON.stringify({
      env: { ANTHROPIC_API_KEY: 'fixture-default-api-key' },
      apiKeyHelper: 'echo fixture-helper-api-key',
    }),
  );
}
const seen = [];
const external = [];
const server = createServer(async (req, res) => {
  if (!req.url.startsWith('/')) {
    external.push('proxy-request');
    res.writeHead(403).end();
    return;
  }
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = Buffer.concat(chunks).toString();
  if (req.url.includes('count_tokens')) {
    res.setHeader('Content-Type', 'application/json');
    res.end('{"input_tokens":10}');
    return;
  }
  if (!req.url.includes('/messages')) {
    res.setHeader('Content-Type', 'application/json');
    res.end('{}');
    return;
  }
  const data = JSON.parse(body);
  const account = tokens.indexOf(String(req.headers.authorization ?? '').replace(/^Bearer /, ''));
  seen.push({
    account,
    history: JSON.stringify(data.messages).includes('F320_COFFEE_MEMORY'),
    messages: data.messages.length,
    apiKeyPresent: !!req.headers['x-api-key'],
  });
  const msg = {
    id: 'msg_fixture',
    type: 'message',
    role: 'assistant',
    model: data.model,
    content: [{ type: 'text', text: 'F320_FIXTURE_OK' }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 3 },
  };
  res.setHeader('Content-Type', data.stream ? 'text/event-stream' : 'application/json');
  if (!data.stream) {
    res.end(JSON.stringify(msg));
    return;
  }
  const events = [
    [
      'message_start',
      {
        type: 'message_start',
        message: { ...msg, content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 0 } },
      },
    ],
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
    [
      'content_block_delta',
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'F320_FIXTURE_OK' } },
    ],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    [
      'message_delta',
      { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 3 } },
    ],
    ['message_stop', { type: 'message_stop' }],
  ];
  for (const [event, value] of events) res.write(`event: ${event}\ndata: ${JSON.stringify(value)}\n\n`);
  res.end();
});
server.on('connect', (_req, socket) => {
  external.push('blocked-connect');
  socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}`;
const env = Object.fromEntries(
  Object.entries(process.env).filter(
    ([key]) => !key.startsWith('ANTHROPIC') && !key.startsWith('CLAUDE') && !key.startsWith('CAT_CAFE'),
  ),
);
Object.assign(env, {
  HOME: root,
  CLAUDE_CONFIG_DIR: join(root, 'config'),
  ANTHROPIC_BASE_URL: url,
  HTTP_PROXY: url,
  HTTPS_PROXY: url,
  ALL_PROXY: url,
  NO_PROXY: '127.0.0.1,localhost',
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  DISABLE_AUTOUPDATER: '1',
});
const priorConfig = process.env.CLAUDE_CONFIG_DIR;
process.env.CLAUDE_CONFIG_DIR = join(root, 'config');
let launchSettings = JSON.parse(
  await composeClaudeTokenSettingsDocument(undefined, root, process.env.F320_POISON_AUTH === '1' ? ['user'] : []),
);
// The only fake substitution is the loopback destination; all auth precedence is production code.
launchSettings.env.ANTHROPIC_BASE_URL = url;
if (priorConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR;
else process.env.CLAUDE_CONFIG_DIR = priorConfig;
function run(token, prompt, session, sources = process.env.F320_POISON_AUTH === '1' ? 'user' : '') {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.env.F320_CLAUDE_BINARY ?? 'claude',
      [
        '-p',
        '--output-format',
        'json',
        '--model',
        'claude-sonnet-4-6',
        '--setting-sources',
        sources,
        '--settings',
        JSON.stringify(launchSettings),
        '--strict-mcp-config',
        '--tools',
        '',
        '--max-turns',
        '1',
        '--permission-mode',
        'plan',
        ...(session ? ['--resume', session] : []),
      ],
      { cwd: root, env: { ...env, CLAUDE_CODE_OAUTH_TOKEN: token }, stdio: ['pipe', 'pipe', 'pipe'] },
    );
    const output = [];
    const errors = [];
    child.stdout.on('data', (c) => output.push(c));
    child.stderr.on('data', (c) => errors.push(c));
    const timeout = setTimeout(() => child.kill('SIGTERM'), 25000);
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timeout);
      const text = Buffer.concat(output).toString();
      try {
        const result = JSON.parse(text);
        assert.equal(code, 0);
        assert.equal(result.is_error, false);
        resolve(result);
      } catch {
        reject(
          new Error(
            `native_fixture_failed:exit=${code};output=${text.slice(0, 400)};stderr=${Buffer.concat(errors).toString().slice(0, 400)}`,
          ),
        );
      }
    });
    child.stdin.end(prompt);
  });
}
try {
  const a = await run(tokens[0], 'Remember F320_COFFEE_MEMORY');
  const b = await run(tokens[1], 'Continue using the previous memory', a.session_id);
  const c = await run(tokens[0], 'Continue once more', b.session_id);
  assert.equal(a.session_id, b.session_id);
  assert.equal(b.session_id, c.session_id);
  assert.deepEqual(
    seen.map((x) => x.account),
    [0, 1, 0],
  );
  assert.ok(seen.every((x) => x.history));
  assert.ok(seen.every((x) => !x.apiKeyPresent));
  const switchedAccounts = seen.map((x) => x.account);
  mkdirSync(join(root, 'config'), { recursive: true });
  writeFileSync(
    join(root, 'config/settings.json'),
    JSON.stringify({
      env: { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-fixture-settings-X' },
    }),
  );
  process.env.CLAUDE_CONFIG_DIR = join(root, 'config');
  try {
    await assert.rejects(
      composeClaudeTokenSettingsDocument(undefined, root, ['user', 'project', 'local']),
      /claude_token_settings_conflict/,
    );
    // SDK read_only passes an explicit empty source list; prove the native CLI honors it.
    launchSettings = JSON.parse(await composeClaudeTokenSettingsDocument(undefined, root, []));
    launchSettings.env.ANTHROPIC_BASE_URL = url;
  } finally {
    if (priorConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = priorConfig;
  }
  await run(tokens[0], 'Empty settings source read-only probe', c.session_id, '');
  assert.equal(seen.at(-1).account, 0);
  assert.ok(seen.every((x) => !x.apiKeyPresent));
  assert.equal(external.length, 0);
  console.log(
    JSON.stringify({
      nativeVersion: '2.1.296',
      transport: 'loopback-fake-provider',
      accounts: switchedAccounts,
      readOnlyCompetingSettingsRejected: true,
      sdkEmptySourcesSelectedAccount: seen.at(-1).account,
      sameSession: true,
      history: true,
      externalRequestsBlocked: external.length,
      remoteIdentityVerified: false,
    }),
  );
} finally {
  await new Promise((r) => server.close(r));
  rmSync(root, { recursive: true, force: true });
}
