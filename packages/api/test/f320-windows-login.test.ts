import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createCodexTerminalLoginDriver } from '../src/config/codex-login-driver.js';
import { readCodexNativeVersion } from '../src/infrastructure/codex-native-compat/native-version.js';
import { probePath } from '../src/infrastructure/codex-native-compat/probe-host.js';

const windows = { skip: process.platform !== 'win32', timeout: 20_000 };
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "f320 Windows 中文 '-"));
  const home = join(root, 'home');
  mkdirSync(home);
  const savedProgramData = process.env.ProgramData;
  process.env.ProgramData = join(root, 'program-data');
  mkdirSync(process.env.ProgramData);
  const command = join(root, 'codex.CMD');
  writeFileSync(command, '@echo off\r\nnode "%~dp0\\fake.js" %*\r\n');
  writeFileSync(
    join(root, 'fake.js'),
    `const fs=require('node:fs'),path=require('node:path');
const args=process.argv.slice(2);
if(args[0]==='--version'){console.log('codex-cli 9.9.1810');process.exit(0);}
fs.appendFileSync(path.join(process.env.CODEX_HOME,'calls.jsonl'),JSON.stringify({args,home:process.env.CODEX_HOME,key:!!process.env.OPENAI_API_KEY})+'\\n');
if(args.at(-1)==='status')process.exit(0);
if(fs.existsSync(path.join(process.env.CODEX_HOME,'hang'))){
 const child=require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',windowsHide:true});
 fs.writeFileSync(path.join(process.env.CODEX_HOME,'pids.json'),JSON.stringify([process.pid,child.pid]));
 setInterval(()=>{},1000);
}else{
const claims={'https://api.openai.com/auth':{chatgpt_user_id:'fixture-user',chatgpt_account_id:'fixture-workspace'}};
fs.writeFileSync(path.join(process.env.CODEX_HOME,'auth.json'),JSON.stringify({tokens:{id_token:'x.'+Buffer.from(JSON.stringify(claims)).toString('base64url')+'.x',account_id:'fixture-workspace'}}));
}
`,
  );
  return {
    root,
    home,
    command,
    close: () => {
      if (savedProgramData === undefined) delete process.env.ProgramData;
      else process.env.ProgramData = savedProgramData;
      rmSync(root, { recursive: true, force: true, maxRetries: 5 });
    },
  };
}

test('Windows version admission executes the selected npm CMD carrier', windows, async () => {
  const f = fixture();
  try {
    assert.equal(
      await readCodexNativeVersion(f.command, { ...process.env, HOME: f.home, CODEX_HOME: f.home }),
      'codex-cli 9.9.1810',
    );
  } finally {
    f.close();
  }
});

test('Windows cancellation stops the owned login shim and its descendants', windows, async () => {
  const f = fixture();
  let worker: ReturnType<typeof spawn> | undefined;
  try {
    writeFileSync(join(f.home, 'hang'), '');
    const request = join(f.root, 'terminal-request.json');
    writeFileSync(
      request,
      JSON.stringify({
        command: f.command,
        cwd: f.root,
        home: f.home,
        env: { HOME: f.root, CODEX_HOME: f.home },
        ownerPid: process.pid,
      }),
    );
    worker = spawn(
      process.execPath,
      [
        '--import',
        'tsx',
        fileURLToPath(new URL('../src/config/codex-login-terminal-worker.ts', import.meta.url)),
        request,
      ],
      { windowsHide: true, stdio: 'ignore' },
    );
    const deadline = Date.now() + 10_000;
    while (!existsSync(join(f.home, 'pids.json')) && worker.exitCode === null && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 30));
    assert.ok(existsSync(join(f.home, 'pids.json')), 'fake CLI must start its child before cancellation');
    const pids: number[] = JSON.parse(readFileSync(join(f.home, 'pids.json'), 'utf8'));
    const ended = once(worker, 'exit');
    writeFileSync(join(f.root, 'terminal-cancel'), '');
    assert.equal((await ended)[0], 1);
    assert.equal(JSON.parse(readFileSync(join(f.root, 'terminal-result.json'), 'utf8')).exitCode, 1);
    pids.forEach((pid) => {
      assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
    });
    assert.equal(existsSync(join(f.home, 'auth.json')), false);
  } finally {
    if (worker?.pid && worker.exitCode === null)
      spawnSync('taskkill.exe', ['/PID', String(worker.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    f.close();
  }
});

test('Windows probe PATH retains native path entries', windows, () => {
  assert.equal(probePath().split(delimiter)[0], dirname(process.execPath));
});

test(
  'Windows default hidden PowerShell completes official login and status with the fixture CLI',
  windows,
  async () => {
    const f = fixture();
    try {
      const driver = createCodexTerminalLoginDriver({ command: f.command, assertSupport: () => {} });
      const identity = await driver.run({
        home: f.home,
        cwd: f.root,
        signal: new AbortController().signal,
        onReady: () => {},
      });
      assert.equal(identity.userId, 'fixture-user');
      assert.equal(JSON.parse(readFileSync(join(f.root, 'terminal-result.json'), 'utf8')).exitCode, 0);
    } finally {
      f.close();
    }
  },
);

test('Windows terminal worker runs login and status through the same CMD shim in a private home', windows, async () => {
  const f = fixture();
  try {
    const request = join(f.root, 'terminal-request.json');
    writeFileSync(
      request,
      JSON.stringify({
        command: f.command,
        cwd: f.root,
        home: f.home,
        env: { HOME: f.root, CODEX_HOME: f.home },
        ownerPid: process.pid,
      }),
    );
    const worker = fileURLToPath(new URL('../src/config/codex-login-terminal-worker.ts', import.meta.url));
    const child = spawn(process.execPath, ['--import', 'tsx', worker, request], {
      env: { ...process.env, OPENAI_API_KEY: 'fixture-key' },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    const [code] = await once(child, 'exit');
    assert.equal(code, 0, stderr);
    assert.equal(existsSync(join(f.root, 'terminal-result.json')), true);
    assert.equal(JSON.parse(readFileSync(join(f.root, 'terminal-result.json'), 'utf8')).exitCode, 0);
    const calls = readFileSync(join(f.home, 'calls.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    assert.deepEqual(
      calls.map((call) => call.args),
      [
        ['-c', 'cli_auth_credentials_store="file"', 'login'],
        ['-c', 'cli_auth_credentials_store="file"', 'login', 'status'],
      ],
    );
    assert.ok(calls.every((call) => call.home === f.home && call.key === false));
  } finally {
    f.close();
  }
});

for (const mode of ['source', 'compiled'] as const) {
  test(
    `Windows ${mode} driver passes quoted worker paths through PowerShell without opening a window`,
    {
      ...windows,
      skip:
        windows.skip ||
        (mode === 'compiled' && !existsSync(new URL('../dist/config/codex-login-driver.js', import.meta.url))),
    },
    async () => {
      const f = fixture();
      let terminal: ReturnType<typeof spawn> | undefined;
      try {
        const create =
          mode === 'compiled'
            ? (await import('../dist/config/codex-login-driver.js')).createCodexTerminalLoginDriver
            : createCodexTerminalLoginDriver;
        const driver = create({
          command: f.command,
          assertSupport: () => {},
          openTerminal: async (script) => {
            assert.match(script, /^& '/);
            terminal = spawn(
              join(process.env.SystemRoot ?? 'C:/Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe'),
              [
                '-NoLogo',
                '-NoProfile',
                '-NonInteractive',
                '-EncodedCommand',
                Buffer.from(script, 'utf16le').toString('base64'),
              ],
              { windowsHide: true, stdio: 'ignore' },
            );
          },
        });
        let ready = false;
        const identity = await driver.run({
          home: f.home,
          cwd: f.root,
          signal: new AbortController().signal,
          onReady: () => {
            ready = true;
          },
        });
        assert.equal(ready, true);
        assert.equal(identity.userId, 'fixture-user');
        assert.equal(identity.workspaceId, 'fixture-workspace');
        assert.equal(existsSync(join(f.root, 'terminal-ready')), true);
      } finally {
        if (terminal && terminal.exitCode === null) await once(terminal, 'exit');
        f.close();
      }
    },
  );
}
