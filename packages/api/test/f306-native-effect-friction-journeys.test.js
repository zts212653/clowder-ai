import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { decideNativeHookPayload } from '../../../scripts/native-effect-target-guard.mjs';
import { nativeHookPrograms, nativeHookTestEnv } from './helpers/native-hook-programs.js';

function admitted(command, cwd) {
  for (const [program, script, tool_name] of nativeHookPrograms()) {
    const result = spawnSync(program, [script], {
      env: nativeHookTestEnv(),
      input: JSON.stringify({ tool_name, cwd, tool_input: { cmd: command, command } }),
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    assert.ok(!result.stdout.includes('"deny"'), result.stdout);
  }
}
function command(argv, cwd) {
  const result = spawnSync(argv[0], argv.slice(1), { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}
function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'f306-journey-')));
  const runtime = join(root, 'cat-cafe-runtime');
  mkdirSync(runtime);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, runtime };
}

// R5 source 4160016839 and Astra 0001790988824801-001038-8f2a9153.
// This is an execution-contract probe, not proof that the protected GET journey recovered.
test('curl startup and proxy environment alter actual effects; pure argv stays unproved', async (t) => {
  const { root, runtime } = fixture(t);
  const outputFile = join(root, 'curl-output');
  const requests = [];
  const listen = async (via) => {
    const server = createServer((req, res) => {
      requests.push({ via, method: req.method, url: req.url });
      res.end(via);
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(() => server.close());
    return `http://127.0.0.1:${server.address().port}`;
  };
  const origin = await listen('origin'),
    proxy = await listen('proxy');
  const endpoint = `${origin}/api/recall/metrics?days=30`;
  writeFileSync(join(root, '.curlrc'), `request = "POST"\noutput = "${outputFile}"\n`);
  const rows = [
    { args: ['-sS', endpoint], method: 'POST', file: true },
    { args: ['-sS', '-q', endpoint], method: 'POST', file: true },
    { args: ['-q', '-sS', endpoint], method: 'GET', file: false },
    { args: ['-q', '-sS', endpoint], method: 'GET', file: false, proxy: true },
    { args: ['--request', 'GET', '--header', 'X-Cat-Cafe-User: default-user', endpoint], method: 'GET', file: true },
  ];
  const { spawn } = await import('node:child_process');
  for (const row of rows) {
    rmSync(outputFile, { force: true });
    requests.length = 0;
    const shell = `curl ${row.args.map((value) => JSON.stringify(value)).join(' ')}`;
    for (const [program, script, tool_name] of nativeHookPrograms()) {
      const judged = spawnSync(program, [script], {
        env: nativeHookTestEnv(),
        input: JSON.stringify({ tool_name, cwd: runtime, tool_input: { cmd: shell, command: shell } }),
        encoding: 'utf8',
      });
      assert.equal(judged.status, 0, judged.stderr);
      assert.equal(
        decideNativeHookPayload({ tool_name, cwd: runtime, tool_input: { command: shell, cmd: shell } }).effect,
        'unknown',
      );
      assert.ok(!judged.stdout.includes('read_only'), judged.stdout);
    }
    // Actual probe runs only in its own ordinary fixture, after its ordinary policy admission.
    admitted(shell, root);
    const child = spawn('/usr/bin/curl', row.args, {
      cwd: root,
      env: {
        PATH: '/usr/bin:/bin',
        CURL_HOME: root,
        XDG_CONFIG_HOME: root,
        ...(row.proxy ? { http_proxy: proxy, NO_PROXY: '' } : { NO_PROXY: '*' }),
      },
    });
    let stdout = '',
      stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    const [code] = await once(child, 'exit');
    assert.equal(code, 0, stderr);
    assert.deepEqual(requests, [
      {
        via: row.proxy ? 'proxy' : 'origin',
        method: row.method,
        url: row.proxy ? endpoint : '/api/recall/metrics?days=30',
      },
    ]);
    if (row.file) assert.equal(readFileSync(outputFile, 'utf8'), 'origin');
    else {
      assert.equal(stdout, row.proxy ? 'proxy' : 'origin');
      assert.throws(() => readFileSync(outputFile), { code: 'ENOENT' });
    }
  }
});

test('readonly SQL terminator returns actual statistics and leaves the database bytes unchanged', (t) => {
  const sqlite = spawnSync('sqlite3', ['--version'], { encoding: 'utf8' });
  if (sqlite.error?.code === 'ENOENT') {
    t.skip('sqlite3 executable is not installed');
    return;
  }
  assert.equal(sqlite.status, 0, sqlite.stderr || sqlite.error?.message);
  const { root, runtime } = fixture(t);
  const database = join(root, 'evidence.sqlite');
  command(
    ['sqlite3', database, 'CREATE TABLE recall_events(id INTEGER); INSERT INTO recall_events VALUES(1),(2),(3);'],
    root,
  );
  const before = readFileSync(database);
  const sql = 'SELECT count(*) FROM recall_events;';
  admitted(`sqlite3 -readonly ${database} '${sql}'`, runtime);
  assert.equal(command(['sqlite3', '-readonly', database, sql], runtime).trim(), '3');
  assert.deepEqual(readFileSync(database), before);
});

test('source inspection and multiple relative hashes complete in a temporary protected checkout', (t) => {
  const { runtime } = fixture(t);
  mkdirSync(join(runtime, 'docs'));
  writeFileSync(join(runtime, 'docs', 'source.md'), 'kill is a search term\n');
  writeFileSync(join(runtime, 'docs', 'other.md'), 'second file\n');
  command(['git', 'init', '-q'], runtime);
  command(['git', 'add', 'docs'], runtime);
  command(
    [
      'git',
      '-c',
      'user.name=F306 fixture',
      '-c',
      'user.email=fixture@example.invalid',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '-qm',
      'fixture',
    ],
    runtime,
  );
  admitted("git grep -n 'kill' HEAD -- docs", runtime);
  assert.match(command(['git', 'grep', '-n', 'kill', 'HEAD', '--', 'docs'], runtime), /kill is a search term/);
  admitted('git cat-file -p HEAD:docs/source.md', runtime);
  assert.equal(command(['git', 'cat-file', '-p', 'HEAD:docs/source.md'], runtime), 'kill is a search term\n');
  admitted('shasum -a 256 docs/source.md docs/other.md', runtime);
  assert.equal(
    command(['shasum', '-a', '256', 'docs/source.md', 'docs/other.md'], runtime).trim().split('\n').length,
    2,
  );
});
