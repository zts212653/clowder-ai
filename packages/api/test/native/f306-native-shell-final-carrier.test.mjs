// Explicit isolated probe: CARGO_BIN_EXE_codex must name the reviewed candidate.
// Run separately from the API suite; never fall back to the installed CLI.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const candidate = process.env.CARGO_BIN_EXE_codex;
assert.ok(candidate && isAbsolute(candidate), 'explicit absolute candidate CLI prerequisite is required');
assert.ok(existsSync(candidate), 'candidate CLI prerequisite must exist');
const binary = realpathSync(candidate);
const guard = fileURLToPath(new URL('../../../../scripts/native-effect-target-guard.mjs', import.meta.url));
const quote = (value) => `'${value.replaceAll("'", `'"'"'`)}'`;
const sha = (value) => createHash('sha256').update(value).digest('hex');
const version = spawnSync(binary, ['--version'], { encoding: 'utf8', timeout: 5000 });
assert.equal(version.status, 0, version.stderr);
console.log(JSON.stringify({ candidate: binary, version: version.stdout.trim(), sha256: sha(readFileSync(binary)) }));

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => [k, canonical(v)]),
  );
}

function hooksConfig(entries) {
  const groups = new Map();
  const states = [];
  for (const { event, key, matcher, command } of entries) {
    const handlers = groups.get(event) ?? [];
    const hook = { type: 'command', command, timeout: 5, async: false, statusMessage: 'Checking isolated effects…' };
    const identity = { event_name: key, hooks: [hook], matcher };
    const hash = `sha256:${sha(JSON.stringify(canonical(identity)))}`;
    states.push(
      `${JSON.stringify(`/<session-flags>/config.toml:${key}:${handlers.length}:0`)}={enabled=true,trusted_hash=${JSON.stringify(hash)}}`,
    );
    handlers.push(
      `{matcher=${JSON.stringify(matcher)},hooks=[{type="command",command=${JSON.stringify(command)},timeout=5,async=false,statusMessage=${JSON.stringify(hook.statusMessage)}}]}`,
    );
    groups.set(event, handlers);
  }
  return `hooks={${[...groups].map(([event, handlers]) => `${event}=[${handlers.join(',')}]`).join(',')},state={${states.join(',')}}}`;
}

function sse(events) {
  return events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('');
}

function completed(id) {
  return {
    type: 'response.completed',
    response: {
      id,
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        total_tokens: 0,
        input_tokens_details: null,
        output_tokens_details: null,
      },
    },
  };
}

async function observe(t, name, select) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'f306-final-carrier-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, 'home');
  const ordinary = join(root, 'ordinary');
  const runtime = join(root, 'cat-cafe-runtime');
  for (const path of [home, ordinary, runtime]) mkdirSync(path);
  const chosen = select({ home, ordinary, runtime });
  const record = join(home, 'checks.jsonl');
  const wrapper = join(home, 'record-hook.mjs');
  writeFileSync(
    wrapper,
    `import { appendFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
let raw=''; for await (const chunk of process.stdin) raw+=chunk;
const input=JSON.parse(raw); const mode=process.argv[2];
let output='';
if(mode==='generic') {
 const rewritten=${JSON.stringify(chosen.rewrite ?? null)};
 if(rewritten) output=JSON.stringify({hookSpecificOutput:{hookEventName:'PreToolUse',permissionDecision:'allow',updatedInput:{command:rewritten}}});
} else {
 const result=spawnSync(process.execPath,[${JSON.stringify(guard)}],{input:raw,encoding:'utf8',timeout:4000});
 if(result.status!==0) throw new Error(result.stderr||'guard failed');
 output=result.stdout;
}
appendFileSync(${JSON.stringify(record)},JSON.stringify({input,output})+'\\n');
process.stdout.write(output);
`,
  );
  const entries = [
    {
      event: 'PreToolUse',
      key: 'pre_tool_use',
      matcher: 'Edit|Write',
      command: `${quote(process.execPath)} ${quote(guard)}`,
    },
    {
      event: 'PreToolUse',
      key: 'pre_tool_use',
      matcher: '^Bash$',
      command: `${quote(process.execPath)} ${quote(wrapper)} generic`,
    },
    {
      event: 'NativeShellSafetyCheck',
      key: 'native_shell_safety_check',
      matcher: '^Bash$',
      command: `${quote(process.execPath)} ${quote(wrapper)} native`,
    },
  ];
  const requests = [];
  const callId = `owned-${name}`;
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    if (req.method !== 'POST' || !req.url.endsWith('/responses')) {
      res.writeHead(404).end();
      return;
    }
    requests.push(JSON.parse(raw));
    res.setHeader('content-type', 'text/event-stream');
    if (requests.length === 1) {
      res.end(
        sse([
          { type: 'response.created', response: { id: 'owned-1' } },
          {
            type: 'response.output_item.done',
            item: {
              type: 'function_call',
              call_id: callId,
              name: 'exec_command',
              arguments: JSON.stringify({ cmd: chosen.command, workdir: chosen.workdir, login: false }),
            },
          },
          completed('owned-1'),
        ]),
      );
    } else if (requests.length === 2) {
      res.end(
        sse([
          { type: 'response.created', response: { id: 'owned-2' } },
          {
            type: 'response.output_item.done',
            item: {
              type: 'message',
              role: 'assistant',
              id: 'owned-result',
              content: [{ type: 'output_text', text: 'Observed the owned tool result.' }],
            },
          },
          completed('owned-2'),
        ]),
      );
    } else {
      res.writeHead(400).end('unexpected additional model request');
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const provider = `model_providers.owned={name="owned",base_url=${JSON.stringify(`http://127.0.0.1:${server.address().port}/v1`)},wire_api="responses",requires_openai_auth=false,supports_websockets=false}`;
  const args = [
    'exec',
    '--skip-git-repo-check',
    '--sandbox',
    chosen.sandbox ?? 'workspace-write',
    '--add-dir',
    ordinary,
    '--add-dir',
    runtime,
    '--json',
  ];
  for (const config of [
    'model_provider="owned"',
    provider,
    'approval_policy="never"',
    'features.hooks=true',
    'features.unified_exec=true',
    'analytics.enabled=false',
    hooksConfig(entries),
  ])
    args.push('--config', config);
  args.push('Observe one owned effect; the local mock defines the tool call.');
  const child = spawn(binary, args, {
    cwd: chosen.hookCwd ?? ordinary,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      PATH: '/opt/homebrew/opt/node@24/bin:/usr/bin:/bin',
      HOME: home,
      LANG: 'en_US.UTF-8',
      CODEX_HOME: home,
      CODEX_SQLITE_HOME: home,
      // Keep the owned loopback model fixture out of OS proxy autodiscovery.
      NO_PROXY: '127.0.0.1,localhost',
    },
    signal: AbortSignal.timeout(45000),
  });
  let stdout = '',
    stderr = '';
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  const exit = await new Promise((resolve, reject) => {
    child.once('error', (error) => {
      console.error(
        JSON.stringify({
          name,
          requestCount: requests.length,
          stdout,
          stderr,
          hookLog: existsSync(record) ? readFileSync(record, 'utf8') : null,
        }),
      );
      reject(error);
    });
    child.once('close', resolve);
  });
  assert.equal(exit, 0, stderr);
  assert.equal(requests.length, 2, `${stdout}\n${stderr}`);
  const output = requests[1].input.find((item) => item.type === 'function_call_output' && item.call_id === callId);
  assert.ok(output, JSON.stringify(requests[1].input));
  assert.ok(existsSync(record), `trusted hook must execute; ${stderr}`);
  const records = readFileSync(record, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  console.log(
    JSON.stringify({
      name,
      records,
      output: output.output,
      sentinelExists: chosen.sentinel ? existsSync(chosen.sentinel) : null,
    }),
  );
  const generic = records.filter(({ input }) => input.hook_event_name === 'PreToolUse');
  const final = records.filter(({ input }) => input.hook_event_name === 'NativeShellSafetyCheck');
  assert.equal(generic.length, 1, 'generic Bash hook executes exactly once');
  assert.ok(final.length > 0, 'actual Native final handler must execute');
  for (const { input, output } of final) {
    const decision = JSON.parse(output);
    assert.equal(input.tool_use_id, callId);
    assert.equal(input.native_execution.call_id, callId);
    assert.equal(input.native_execution.cwd_uri, pathToFileURL(chosen.workdir).href);
    assert.equal(input.native_execution.command, chosen.rewrite ?? chosen.command);
    assert.equal(decision.fingerprint, input.native_execution.fingerprint);
  }
  return { final, output: output.output, chosen, ordinary };
}

test('real final hook permits an ordinary per-call write from a protected hook cwd', async (t) => {
  const result = await observe(t, 'cross-cwd-write', ({ ordinary, runtime }) => ({
    hookCwd: runtime,
    workdir: ordinary,
    command: 'printf owned > effect.txt',
    sentinel: join(ordinary, 'effect.txt'),
  }));
  assert.equal(readFileSync(result.chosen.sentinel, 'utf8'), 'owned');
  assert.deepEqual(
    result.final.map(({ input }) => input.native_execution.phase),
    ['before_first_effect', 'launch'],
  );
  assert.ok(result.final.every(({ output }) => JSON.parse(output).decision === 'accept'));
});

test('real final hook denies a protected per-call cwd before writing', async (t) => {
  const result = await observe(t, 'protected-cwd', ({ ordinary, runtime }) => ({
    hookCwd: ordinary,
    workdir: runtime,
    command: 'printf forbidden > effect.txt',
    sentinel: join(runtime, 'effect.txt'),
  }));
  assert.equal(existsSync(result.chosen.sentinel), false);
  assert.equal(result.final.length, 1);
  assert.equal(JSON.parse(result.final[0].output).decision, 'deny');
  assert.match(result.output, /NativeShellSafetyCheck/);
});

test('real final hook denies an absolute protected operand from ordinary cwd', async (t) => {
  const result = await observe(t, 'protected-operand', ({ ordinary, runtime }) => ({
    workdir: ordinary,
    command: `printf forbidden > ${quote(join(runtime, 'effect.txt'))}`,
    sentinel: join(runtime, 'effect.txt'),
  }));
  assert.equal(existsSync(result.chosen.sentinel), false);
  assert.equal(JSON.parse(result.final[0].output).decision, 'deny');
});

test('real final hook vetoes the apply_patch shortcut before its first effect', async (t) => {
  const result = await observe(t, 'patch-effect', ({ ordinary, runtime }) => ({
    workdir: ordinary,
    command: `apply_patch <<'PATCH'\n*** Begin Patch\n*** Add File: ${join(runtime, 'effect.txt')}\n+forbidden\n*** End Patch\nPATCH`,
    sentinel: join(runtime, 'effect.txt'),
  }));
  assert.equal(existsSync(result.chosen.sentinel), false);
  assert.equal(result.final.length, 1);
  assert.equal(JSON.parse(result.final[0].output).decision, 'deny');
});

test('real final hook consumes the once-rewritten command', async (t) => {
  const result = await observe(t, 'rewritten-effect', ({ ordinary, runtime }) => ({
    workdir: ordinary,
    command: 'echo original',
    rewrite: `printf rewritten > ${quote(join(runtime, 'effect.txt'))}`,
    sentinel: join(runtime, 'effect.txt'),
  }));
  assert.equal(existsSync(result.chosen.sentinel), false);
  assert.equal(JSON.parse(result.final[0].output).decision, 'deny');
});

test('Native accept leaves the existing read-only sandbox in charge', async (t) => {
  const result = await observe(t, 'permission-negative', ({ ordinary }) => ({
    workdir: ordinary,
    command: 'printf forbidden > effect.txt',
    sentinel: join(ordinary, 'effect.txt'),
    sandbox: 'read-only',
  }));
  assert.equal(existsSync(result.chosen.sentinel), false);
  assert.ok(result.final.every(({ output }) => JSON.parse(output).decision === 'accept'));
  assert.doesNotMatch(result.output, /Process exited with code 0/);
});
