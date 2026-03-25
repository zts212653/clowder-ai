import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const { resolveCmdShimScript, resolveWindowsShimSpawn, escapeCmdArg, escapeBashArg } = await import(
  '../dist/utils/cli-spawn-win.js'
);

test('resolveCmdShimScript supports %dp0 shims and keeps scanning where results until one resolves', () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'cli-spawn-win-'));
  const originalPath = process.env.PATH;
  const fakeBin = join(tempRoot, 'bin');
  const badShimDir = join(tempRoot, 'bad');
  const goodShimDir = join(tempRoot, 'good');
  const commandName = 'fake-cmd-scan';

  mkdirSync(fakeBin, { recursive: true });
  mkdirSync(badShimDir, { recursive: true });
  mkdirSync(join(goodShimDir, 'node_modules', 'pkg'), { recursive: true });

  const badCmd = join(badShimDir, `${commandName}.cmd`);
  const goodCmd = join(goodShimDir, `${commandName}.cmd`);
  const goodScript = join(goodShimDir, 'node_modules', 'pkg', 'cli.js');
  const whereScript = join(fakeBin, 'where');

  writeFileSync(badCmd, '@"%dp0\\missing\\cli.js" %*\n', 'utf8');
  writeFileSync(goodCmd, '@"%dp0\\node_modules\\pkg\\cli.js" %*\n', 'utf8');
  writeFileSync(goodScript, 'console.log("ok");\n', 'utf8');
  writeFileSync(whereScript, `#!/bin/sh\nprintf '%s\n%s\n' '${badCmd}' '${goodCmd}'\n`, 'utf8');
  chmodSync(whereScript, 0o755);

  try {
    process.env.PATH = `${fakeBin}:${originalPath ?? ''}`;
    const resolved = resolveCmdShimScript(commandName);
    assert.equal(resolved, goodScript);
  } finally {
    process.env.PATH = originalPath;
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('resolveCmdShimScript ignores the node.exe prelude and resolves the real script target', () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'cli-spawn-win-node-prelude-'));
  const originalPath = process.env.PATH;
  const fakeBin = join(tempRoot, 'bin');
  const shimDir = join(tempRoot, 'shim');
  const commandName = 'fake-cmd-node-prelude';

  mkdirSync(fakeBin, { recursive: true });
  mkdirSync(join(shimDir, 'node_modules', 'pkg'), { recursive: true });

  const cmdPath = join(shimDir, `${commandName}.cmd`);
  const scriptPath = join(shimDir, 'node_modules', 'pkg', 'cli.js');
  const whereScript = join(fakeBin, 'where');

  writeFileSync(
    cmdPath,
    '@IF EXIST "%~dp0\\node.exe" (\r\n  "%~dp0\\node.exe" "%~dp0\\node_modules\\pkg\\cli.js" %*\r\n)\r\n',
    'utf8',
  );
  writeFileSync(scriptPath, 'console.log("ok");\n', 'utf8');
  writeFileSync(whereScript, `#!/bin/sh\nprintf '%s\n' '${cmdPath}'\n`, 'utf8');
  chmodSync(whereScript, 0o755);

  try {
    process.env.PATH = `${fakeBin}:${originalPath ?? ''}`;
    const resolved = resolveCmdShimScript(commandName);
    assert.equal(resolved, scriptPath);
  } finally {
    process.env.PATH = originalPath;
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('resolveCmdShimScript prefers the shim selected by PATH over APPDATA fallback scripts', () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'cli-spawn-win-path-first-'));
  const originalPath = process.env.PATH;
  const originalAppData = process.env.APPDATA;
  const fakeBin = join(tempRoot, 'bin');
  const shimDir = join(tempRoot, 'custom-prefix');
  const appDataDir = join(tempRoot, 'appdata');

  mkdirSync(fakeBin, { recursive: true });
  mkdirSync(join(shimDir, 'node_modules', '@openai', 'codex', 'bin'), { recursive: true });
  mkdirSync(join(appDataDir, 'npm', 'node_modules', '@openai', 'codex', 'bin'), { recursive: true });

  const cmdPath = join(shimDir, 'codex.cmd');
  const pathSelectedScript = join(shimDir, 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
  const appDataFallbackScript = join(appDataDir, 'npm', 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
  const whereScript = join(fakeBin, 'where');

  writeFileSync(cmdPath, '@"%dp0\\node_modules\\@openai\\codex\\bin\\codex.js" %*\n', 'utf8');
  writeFileSync(pathSelectedScript, 'console.log("path-selected");\n', 'utf8');
  writeFileSync(appDataFallbackScript, 'console.log("appdata-fallback");\n', 'utf8');
  writeFileSync(whereScript, `#!/bin/sh\nprintf '%s\n' '${cmdPath}'\n`, 'utf8');
  chmodSync(whereScript, 0o755);

  try {
    process.env.APPDATA = appDataDir;
    process.env.PATH = `${fakeBin}:${originalPath ?? ''}`;

    const resolved = resolveCmdShimScript('codex');
    assert.equal(resolved, pathSelectedScript);
  } finally {
    process.env.PATH = originalPath;
    if (originalAppData === undefined) {
      delete process.env.APPDATA;
    } else {
      process.env.APPDATA = originalAppData;
    }
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('resolveCmdShimScript revalidates cached shim targets after upgrades move the entrypoint', () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'cli-spawn-win-cache-refresh-'));
  const originalPath = process.env.PATH;
  const fakeBin = join(tempRoot, 'bin');
  const v1Dir = join(tempRoot, 'v1');
  const v2Dir = join(tempRoot, 'v2');
  const commandName = 'fake-cmd-cache-refresh';

  mkdirSync(fakeBin, { recursive: true });
  mkdirSync(join(v1Dir, 'node_modules', 'pkg'), { recursive: true });
  mkdirSync(join(v2Dir, 'node_modules', 'pkg'), { recursive: true });

  const v1Cmd = join(v1Dir, `${commandName}.cmd`);
  const v2Cmd = join(v2Dir, `${commandName}.cmd`);
  const v1Script = join(v1Dir, 'node_modules', 'pkg', 'cli.js');
  const v2Script = join(v2Dir, 'node_modules', 'pkg', 'cli.js');
  const whereScript = join(fakeBin, 'where');

  writeFileSync(v1Cmd, '@"%dp0\\node_modules\\pkg\\cli.js" %*\n', 'utf8');
  writeFileSync(v2Cmd, '@"%dp0\\node_modules\\pkg\\cli.js" %*\n', 'utf8');
  writeFileSync(v1Script, 'console.log("v1");\n', 'utf8');
  writeFileSync(v2Script, 'console.log("v2");\n', 'utf8');
  writeFileSync(whereScript, `#!/bin/sh\nprintf '%s\n' '${v1Cmd}'\n`, 'utf8');
  chmodSync(whereScript, 0o755);

  try {
    process.env.PATH = `${fakeBin}:${originalPath ?? ''}`;

    const initialResolved = resolveCmdShimScript(commandName);
    assert.equal(initialResolved, v1Script);

    rmSync(v1Script, { force: true });
    writeFileSync(whereScript, `#!/bin/sh\nprintf '%s\n' '${v2Cmd}'\n`, 'utf8');
    chmodSync(whereScript, 0o755);

    const refreshedResolved = resolveCmdShimScript(commandName);
    assert.equal(refreshedResolved, v2Script);
  } finally {
    process.env.PATH = originalPath;
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('resolveWindowsShimSpawn uses the current Node executable for direct shim launches', () => {
  const shimScript = join(tmpdir(), 'codex-shim-target.js');

  const resolved = resolveWindowsShimSpawn('codex', ['--json'], shimScript);

  assert.deepEqual(resolved, {
    command: process.execPath,
    args: [shimScript, '--json'],
  });
});

test('resolveCmdShimScript skips sibling node.exe and resolves the actual script (#247)', () => {
  // Portable Node installs place node.exe alongside the .cmd shim.
  // The shim references both %~dp0\node.exe (launcher) and %~dp0\node_modules\...\bin\opencode (script).
  // The parser must skip .exe targets to avoid `node node.exe` (MZ SyntaxError).
  const tempRoot = mkdtempSync(join(tmpdir(), 'cli-spawn-win-exe-skip-'));
  const shimDir = join(tempRoot, 'npm');

  mkdirSync(join(shimDir, 'node_modules', 'opencode-ai', 'bin'), { recursive: true });

  const cmdPath = join(shimDir, 'opencode.cmd');
  const fakeNodeExe = join(shimDir, 'node.exe');
  const scriptPath = join(shimDir, 'node_modules', 'opencode-ai', 'bin', 'opencode');

  // Realistic portable-install shim content (node.exe prelude appears BEFORE the script target)
  writeFileSync(
    cmdPath,
    [
      '@ECHO off',
      'GOTO start',
      ':find_dp0',
      'SET dp0=%~dp0',
      'EXIT /b',
      ':start',
      'SETLOCAL',
      'CALL :find_dp0',
      '',
      'IF EXIST "%dp0%\\node.exe" (',
      '  SET "_prog=%dp0%\\node.exe"',
      ') ELSE (',
      '  SET "_prog=node"',
      ')',
      '',
      'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\opencode-ai\\bin\\opencode" %*',
    ].join('\r\n'),
    'utf8',
  );
  // Create BOTH node.exe and the script — the parser must pick the script, not node.exe
  writeFileSync(fakeNodeExe, 'MZ fake exe', 'utf8');
  writeFileSync(scriptPath, '#!/usr/bin/env node\nconsole.log("ok");\n', 'utf8');

  try {
    // Use Strategy 0 (full .cmd path) to bypass `where` — works on all platforms
    const resolved = resolveCmdShimScript(cmdPath);
    assert.equal(resolved, scriptPath, 'must resolve to the script, not node.exe');
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('escapeCmdArg passes through simple arguments unchanged', () => {
  assert.equal(escapeCmdArg('hello'), 'hello');
  assert.equal(escapeCmdArg('simple-arg'), 'simple-arg');
});

test('escapeCmdArg wraps arguments containing spaces in double quotes', () => {
  assert.equal(escapeCmdArg('hello world'), '"hello world"');
  assert.equal(escapeCmdArg('C:\\Program Files\\app'), '"C:\\Program Files\\app"');
});

test('escapeCmdArg escapes internal double quotes', () => {
  assert.equal(escapeCmdArg('say "hi"'), '"say \\"hi\\""');
});

test('escapeCmdArg doubles backslashes preceding internal quotes per MSVC CRT rules', () => {
  // foo\"bar → foo has 0 bs before ", but the literal string 'foo\\"bar' has 1 bs before "
  // Input JS string 'foo\\"bar' = foo\"bar (1 backslash then quote then bar)
  // CRT: 1 backslash before " → doubled to 2, then \" → foo\\\"bar
  assert.equal(escapeCmdArg('foo\\"bar'), '"foo\\\\\\"bar"');
  // Input: 'foo\\\\"bar' = foo\\"bar (2 backslashes then quote then bar)
  // CRT: 2 backslashes before " → doubled to 4, then \" → foo\\\\\"bar
  assert.equal(escapeCmdArg('foo\\\\"bar'), '"foo\\\\\\\\\\"bar"');
});

test('escapeCmdArg doubles trailing backslashes to prevent closing quote escape', () => {
  assert.equal(escapeCmdArg('arg\\'), '"arg\\\\"');
  assert.equal(escapeCmdArg('path with spaces\\'), '"path with spaces\\\\"');
  assert.equal(escapeCmdArg('trail\\\\'), '"trail\\\\\\\\"');
});

test('escapeCmdArg doubles percent signs to prevent env-var expansion', () => {
  assert.equal(escapeCmdArg('%PATH%'), '"%%PATH%%"');
});

test('escapeCmdArg caret-escapes cmd.exe metacharacters', () => {
  assert.equal(escapeCmdArg('a&b'), '"a^&b"');
  assert.equal(escapeCmdArg('a|b'), '"a^|b"');
  assert.equal(escapeCmdArg('a>b'), '"a^>b"');
  assert.equal(escapeCmdArg('a<b'), '"a^<b"');
  assert.equal(escapeCmdArg('a^b'), '"a^^b"');
  assert.equal(escapeCmdArg('a!b'), '"a^!b"');
  assert.equal(escapeCmdArg('a(b)c'), '"a^(b^)c"');
  assert.equal(escapeCmdArg('(group)'), '"^(group^)"');
});

// ── escapeBashArg ──

test('escapeBashArg wraps all arguments in single quotes', () => {
  assert.equal(escapeBashArg('hello'), "'hello'");
  assert.equal(escapeBashArg('simple-arg'), "'simple-arg'");
});

test('escapeBashArg preserves spaces without extra escaping', () => {
  assert.equal(escapeBashArg('hello world'), "'hello world'");
});

test('escapeBashArg escapes internal single quotes', () => {
  assert.equal(escapeBashArg("it's"), "'it'\\''s'");
  assert.equal(escapeBashArg("can't stop"), "'can'\\''t stop'");
});

test('escapeBashArg preserves CJK characters (UTF-8 safe)', () => {
  const prompt = '你是 claude-claude（claude-claude），由 Anthropic 提供的 AI 猫猫。';
  assert.equal(escapeBashArg(prompt), `'${prompt}'`);
});

test('escapeBashArg handles double quotes, backslashes and shell metacharacters without extra escaping', () => {
  assert.equal(escapeBashArg('say "hi"'), '\'say "hi"\'');
  assert.equal(escapeBashArg('a\\b'), "'a\\b'");
  assert.equal(escapeBashArg('$HOME'), "'$HOME'");
  assert.equal(escapeBashArg('a&b|c'), "'a&b|c'");
});
