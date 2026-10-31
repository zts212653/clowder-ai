// Explicit candidate only. This exercises the production AgentService/carriers,
// while the model endpoint and all effect targets belong to this test.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { test } from 'node:test';
import { CodexAgentService } from '../../dist/domains/cats/services/agents/providers/CodexAgentService.js';
import { CodexAppServerHostPool } from '../../dist/domains/cats/services/agents/providers/CodexAppServerHostPool.js';
import { fakeL0Compiler } from '../helpers/fake-l0-compiler.js';

const candidate = process.env.CARGO_BIN_EXE_codex;
assert.ok(candidate && isAbsolute(candidate), 'explicit isolated candidate required');
const binary = realpathSync(candidate);
const digest = createHash('sha256').update(readFileSync(binary)).digest('hex');
assert.equal(digest, '05d334f317ffcffd6da820c810822e56dfafa3537fbc4f642a1a297823592798');

const quote = (value) => `'${value.replaceAll("'", `'"'"'`)}'`;
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => [k, canonical(v)]),
  );
}
function event(type, response) {
  return { type, response };
}
function stream(events) {
  return events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');
}
function complete(id) {
  return event('response.completed', {
    id,
    usage: {
      input_tokens: 0,
      output_tokens: 0,
      total_tokens: 0,
      input_tokens_details: null,
      output_tokens_details: null,
    },
  });
}
function assistant(id) {
  return stream([
    event('response.created', { id }),
    {
      type: 'response.output_item.done',
      item: {
        type: 'message',
        role: 'assistant',
        id: `${id}-message`,
        content: [{ type: 'output_text', text: 'Owned observation complete.' }],
      },
    },
    complete(id),
  ]);
}

async function fixture(
  t,
  carrier,
  { final = true, pooled = false, cli = binary, rewrite, nativeFailure, git = false } = {},
) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'f306-agent-launcher-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, 'home'),
    ordinary = join(root, 'ordinary'),
    runtime = join(root, 'cat-cafe-runtime');
  for (const dir of [home, ordinary, runtime]) mkdirSync(dir);
  if (git) execFileSync('/usr/bin/git', ['init', '--quiet', runtime], { env: { PATH: '/usr/bin:/bin', HOME: home } });
  const log = join(home, 'generic.jsonl'),
    script = join(home, 'generic.mjs');
  writeFileSync(
    script,
    `import {appendFileSync} from 'node:fs'; let raw=''; for await(const chunk of process.stdin) raw+=chunk; const input=JSON.parse(raw); appendFileSync(${JSON.stringify(log)},JSON.stringify(input)+'\\n'); const cmd=${JSON.stringify(rewrite ?? null)}; if(cmd) process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:'PreToolUse',permissionDecision:'allow',updatedInput:{command:cmd.replace('RUNTIME',${JSON.stringify(runtime)})}}}));`,
  );
  const command = `${quote(process.execPath)} ${quote(script)}`;
  const hook = { type: 'command', command, timeout: 5, async: false };
  const identity = { event_name: 'pre_tool_use', matcher: '^Bash$', hooks: [hook] };
  const hash = `sha256:${createHash('sha256')
    .update(JSON.stringify(canonical(identity)))
    .digest('hex')}`;
  // Separate user hook source: system inline flags must preserve this handler.
  const hooks = { PreToolUse: [{ matcher: '^Bash$', hooks: [hook] }] };
  let nativeState = '';
  if (nativeFailure) {
    const failingHook = {
      type: 'command',
      command:
        nativeFailure === 'missing'
          ? `${quote(process.execPath)} ${quote(join(home, 'missing-hook.mjs'))}`
          : '/usr/bin/false',
      timeout: 5,
      async: false,
    };
    const failureIdentity = { event_name: 'native_shell_safety_check', matcher: '^Bash$', hooks: [failingHook] };
    const failureHash = `sha256:${createHash('sha256')
      .update(JSON.stringify(canonical(failureIdentity)))
      .digest('hex')}`;
    hooks.NativeShellSafetyCheck = [{ matcher: '^Bash$', hooks: [failingHook] }];
    nativeState = `[hooks.state.${JSON.stringify(`${home}/hooks.json:native_shell_safety_check:0:0`)}]\nenabled=true\ntrusted_hash=${JSON.stringify(failureHash)}\n`;
  }
  writeFileSync(join(home, 'hooks.json'), JSON.stringify({ hooks }));
  // Discovery reads trust state from user/session TOML, not hooks.json.
  writeFileSync(
    join(home, 'config.toml'),
    `[hooks.state.${JSON.stringify(`${home}/hooks.json:pre_tool_use:0:0`)}]\nenabled=true\ntrusted_hash=${JSON.stringify(hash)}\n${nativeState}`,
  );
  let selected = null,
    pendingResult = false;
  const requests = [];
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    if (req.method !== 'POST' || !req.url.endsWith('/responses')) return res.writeHead(404).end();
    const body = JSON.parse(raw);
    requests.push(body);
    res.setHeader('content-type', 'text/event-stream');
    const id = `owned-${requests.length}`;
    if (selected && !pendingResult) {
      pendingResult = true;
      res.end(
        stream([
          event('response.created', { id }),
          {
            type: 'response.output_item.done',
            item: {
              type: 'function_call',
              name: 'exec_command',
              call_id: `call-${requests.length}`,
              arguments: JSON.stringify({ cmd: selected.cmd, workdir: selected.cwd, login: false }),
            },
          },
          complete(id),
        ]),
      );
    } else {
      pendingResult = false;
      res.end(assistant(id));
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const pool = pooled ? new CodexAppServerHostPool({ idleTtlMs: 10000, maxWarmHosts: 1 }) : undefined;
  const poolLaunches = [];
  if (pool) {
    const createSession = pool.createSession.bind(pool);
    pool.createSession = (options) => {
      poolLaunches.push(options);
      return createSession(options);
    };
  }
  if (pool) t.after(() => pool.closeAll());
  const service = new CodexAgentService({
    catId: 'codex61-sol',
    cliCommand: cli,
    model: 'gpt-6.1-sol',
    carrierMode: carrier,
    nativeShellSafetyCheck: final,
    l0CompilerFn: fakeL0Compiler,
    ...(pool ? { appServerHostPool: pool } : {}),
  });
  const base = {
    workingDirectory: runtime,
    // A pooled host requires stable launch identity. All three values derive
    // from HOME; preserve the guarded ZDOTDIR and use only this owned home.
    ...(pooled
      ? { accountEnv: { HOME: home, CAT_CAFE_ORIGINAL_ZDOTDIR: home, HISTFILE: join(home, '.zsh_history') } }
      : {}),
    callbackEnv: {
      CODEX_AUTH_MODE: 'api_key',
      OPENAI_BASE_URL: `http://127.0.0.1:${server.address().port}/v1`,
      OPENAI_API_KEY: 'owned-fixture-key',
      CODEX_HOME: home,
      CODEX_SQLITE_HOME: home,
      NO_PROXY: '127.0.0.1,localhost',
    },
    cliConfigArgs: [
      '--config model_providers.custom.supports_websockets=false',
      '--config analytics.enabled=false',
      `--config sandbox_workspace_write.writable_roots=["${ordinary}"]`,
    ],
    signal: AbortSignal.timeout(45000),
  };
  return {
    root,
    home,
    ordinary,
    runtime,
    requests,
    pool,
    poolLaunches,
    generic: () =>
      existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [],
    run: async (cmd, cwd = ordinary, extra = {}) => {
      selected = cmd === null ? null : { cmd, cwd };
      pendingResult = false;
      const messages = [];
      for await (const msg of service.invoke('Observe one owned effect.', { ...base, ...extra })) messages.push(msg);
      console.log(
        JSON.stringify({
          carrier,
          final,
          pooled,
          cmd,
          messages,
          requestCount: requests.length,
          generic: existsSync(log) ? readFileSync(log, 'utf8') : null,
        }),
      );
      return messages;
    },
  };
}

for (const carrier of ['exec_json', 'app_server']) {
  test(`${carrier}: finalized per-call cwd permits ordinary writes from a protected thread cwd`, async (t) => {
    const f = await fixture(t, carrier);
    const messages = await f.run('printf owned > effect.txt');
    assert.equal(messages.filter((m) => m.type === 'error').length, 0);
    assert.equal(f.requests.length, 2, 'model must receive the actual tool result');
    assert.equal(f.generic().length, 1, 'unrelated generic hook must run exactly once');
    assert.ok(existsSync(join(f.ordinary, 'effect.txt')), 'final facts must use per-call ordinary cwd');
    assert.equal(readFileSync(join(f.ordinary, 'effect.txt'), 'utf8'), 'owned');
  });
  test(`${carrier}: protected final operand is denied before the first write`, async (t) => {
    const f = await fixture(t, carrier);
    await f.run(`printf forbidden > ${quote(join(f.runtime, 'effect.txt'))}`);
    assert.equal(f.requests.length, 2);
    assert.equal(f.generic().length, 1);
    const result = f.requests[1].input.find((item) => item.type === 'function_call_output');
    assert.match(result.output, /NativeShellSafetyCheck/);
    assert.equal(existsSync(join(f.runtime, 'effect.txt')), false);
  });
  test(`${carrier}: resume retains final guard and generic-hook identity`, async (t) => {
    const f = await fixture(t, carrier, { pooled: carrier === 'app_server' });
    const seed = await f.run(null);
    const session = seed.find((m) => m.type === 'session_init')?.sessionId;
    assert.ok(session, 'real provider session must be created');
    await f.run('printf resumed > resumed.txt', f.ordinary, { sessionId: session });
    assert.equal(f.requests.length, 3);
    assert.equal(f.generic().length, 1);
    assert.equal(readFileSync(join(f.ordinary, 'resumed.txt'), 'utf8'), 'resumed');
    if (f.pool) {
      t.diagnostic(JSON.stringify(f.pool.getMetrics()));
      const [first, next] = f.poolLaunches;
      t.diagnostic(
        JSON.stringify({
          changedArgs: JSON.stringify(first.args) !== JSON.stringify(next.args),
          changedEnvKeys: [...new Set([...Object.keys(first.env), ...Object.keys(next.env)])].filter(
            (key) => first.env[key] !== next.env[key],
          ),
        }),
      );
      assert.ok(first.env.ZDOTDIR.endsWith('/scripts/guarded-zsh'));
      assert.equal(next.env.ZDOTDIR, first.env.ZDOTDIR);
      assert.equal(f.pool.getMetrics().coldStartCount, 1, 'resume must reuse the already guarded host');
      assert.equal(f.pool.getMetrics().warmHitCount, 1);
    }
  });
}

test('default launcher keeps the existing PreToolUse protection', async (t) => {
  const f = await fixture(t, 'exec_json', { final: false });
  await f.run('printf owned > effect.txt');
  assert.equal(f.requests.length, 2);
  assert.equal(existsSync(join(f.ordinary, 'effect.txt')), false);
});

test('selected final guard rejects an unreviewed executable before provider launch', async (t) => {
  const f = await fixture(t, 'exec_json', { cli: process.execPath });
  const messages = await f.run('printf forbidden > effect.txt');
  assert.equal(f.requests.length, 0);
  assert.match(messages.find((m) => m.type === 'error')?.error ?? '', /native_shell_guard_unapproved_cli/);
  assert.equal(existsSync(join(f.ordinary, 'effect.txt')), false);
});

for (const nativeFailure of ['missing', 'exit']) {
  test(`selected final hook ${nativeFailure} fails closed before an ordinary effect`, async (t) => {
    const f = await fixture(t, 'exec_json', { nativeFailure });
    await f.run('printf forbidden > effect.txt');
    assert.equal(f.requests.length, 2);
    assert.equal(f.generic().length, 1);
    const result = f.requests[1].input.find((item) => item.type === 'function_call_output');
    assert.match(result.output, /NativeShellSafetyCheck/);
    assert.equal(existsSync(join(f.ordinary, 'effect.txt')), false);
  });
}

test('generic rewrite is consumed once and final protected facts veto the effect', async (t) => {
  const f = await fixture(t, 'exec_json', { rewrite: "printf rewritten > 'RUNTIME/effect.txt'" });
  await f.run('echo original');
  assert.equal(f.requests.length, 2);
  assert.equal(f.generic().length, 1);
  const result = f.requests[1].input.find((item) => item.type === 'function_call_output');
  assert.match(result.output, /NativeShellSafetyCheck/);
  assert.equal(existsSync(join(f.runtime, 'effect.txt')), false);
});

test('final accept preserves read-only sandbox denial', async (t) => {
  const f = await fixture(t, 'exec_json', { git: true });
  await f.run('printf forbidden > effect.txt', f.ordinary, { toolExecutionPolicy: { mode: 'read_only' } });
  assert.equal(f.requests.length, 2);
  const result = f.requests[1].input.find((item) => item.type === 'function_call_output');
  assert.match(result.output, /operation not permitted|Permission denied/);
  assert.doesNotMatch(result.output, /Command blocked/);
  assert.equal(existsSync(join(f.ordinary, 'effect.txt')), false);
});
