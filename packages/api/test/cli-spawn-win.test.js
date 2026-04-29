import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const { resolveCmdShimScript, resolveWindowsShimSpawn, escapeCmdArg, extractBareName, parseShimFile } = await import(
  '../dist/utils/cli-spawn-win.js'
);

test(
  'resolveCmdShimScript supports %dp0 shims and keeps scanning where results until one resolves',
  { skip: process.platform === 'win32' && 'uses fake where shell script (Unix only)' },
  () => {
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
  },
);

test(
  'resolveCmdShimScript ignores the node.exe prelude and resolves the real script target',
  { skip: process.platform === 'win32' && 'uses fake where shell script (Unix only)' },
  () => {
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
  },
);

test(
  'resolveCmdShimScript prefers the shim selected by PATH over APPDATA fallback scripts',
  { skip: process.platform === 'win32' && 'uses fake where shell script (Unix only)' },
  () => {
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
  },
);

test(
  'resolveCmdShimScript revalidates cached shim targets after upgrades move the entrypoint',
  { skip: process.platform === 'win32' && 'uses fake where shell script (Unix only)' },
  () => {
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
  },
);

test('resolveWindowsShimSpawn uses the current Node executable for direct shim launches', () => {
  const shimScript = join(tmpdir(), 'codex-shim-target.js');

  const resolved = resolveWindowsShimSpawn('codex', ['--json'], shimScript);

  assert.deepEqual(resolved, {
    command: process.execPath,
    args: [shimScript, '--json'],
  });
});

test('resolveWindowsShimSpawn directly launches native exe shim targets', () => {
  const shimExe = join(tmpdir(), 'claude.exe');

  const resolved = resolveWindowsShimSpawn('claude', ['--print'], shimExe);

  assert.deepEqual(resolved, {
    command: shimExe,
    args: ['--print'],
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

// --- extractBareName tests ---

test('extractBareName strips .cmd extension from full path', () => {
  assert.equal(extractBareName('C:\\Users\\Admin\\bin\\claude.cmd'), 'claude');
});

test('extractBareName strips .exe and .bat extensions case-insensitively', () => {
  assert.equal(extractBareName('C:\\tools\\node.EXE'), 'node');
  assert.equal(extractBareName('/usr/local/bin/script.BAT'), 'script');
});

test('extractBareName returns bare name unchanged', () => {
  assert.equal(extractBareName('claude'), 'claude');
  assert.equal(extractBareName('codex'), 'codex');
});

test('extractBareName handles forward-slash paths', () => {
  assert.equal(extractBareName('C:/home/user/claude.cmd'), 'claude');
});

// --- parseShimFile tests ---

test('parseShimFile extracts script path from %dp0 shim', () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'cli-spawn-win-parse-'));
  mkdirSync(join(tempRoot, 'node_modules', 'pkg'), { recursive: true });

  const cmdPath = join(tempRoot, 'test.cmd');
  const scriptPath = join(tempRoot, 'node_modules', 'pkg', 'cli.js');

  writeFileSync(cmdPath, '@"%dp0\\node_modules\\pkg\\cli.js" %*\n', 'utf8');
  writeFileSync(scriptPath, 'console.log("ok");\n', 'utf8');

  try {
    assert.equal(parseShimFile(cmdPath), scriptPath);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('parseShimFile extracts script path from %~dp0 shim', () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'cli-spawn-win-parse-tilde-'));
  mkdirSync(join(tempRoot, 'node_modules', 'pkg'), { recursive: true });

  const cmdPath = join(tempRoot, 'test.cmd');
  const scriptPath = join(tempRoot, 'node_modules', 'pkg', 'cli.js');

  writeFileSync(
    cmdPath,
    '@IF EXIST "%~dp0\\node.exe" (\r\n  "%~dp0\\node.exe" "%~dp0\\node_modules\\pkg\\cli.js" %*\r\n)\r\n',
    'utf8',
  );
  writeFileSync(scriptPath, 'console.log("ok");\n', 'utf8');

  try {
    assert.equal(parseShimFile(cmdPath), scriptPath);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('parseShimFile returns null for non-existent file', () => {
  assert.equal(parseShimFile(join(tmpdir(), 'nonexistent-1234.cmd')), null);
});

test('parseShimFile returns null when referenced script does not exist', () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'cli-spawn-win-parse-missing-'));
  const cmdPath = join(tempRoot, 'test.cmd');

  writeFileSync(cmdPath, '@"%dp0\\node_modules\\pkg\\missing.js" %*\n', 'utf8');

  try {
    assert.equal(parseShimFile(cmdPath), null);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('parseShimFile extracts script path from %dp0% shim (modern npm 10+ format)', () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'cli-spawn-win-parse-dp0pct-'));
  mkdirSync(join(tempRoot, 'node_modules', 'pkg'), { recursive: true });

  const cmdPath = join(tempRoot, 'test.cmd');
  const scriptPath = join(tempRoot, 'node_modules', 'pkg', 'cli.js');

  writeFileSync(cmdPath, 'SET dp0=%~dp0\r\n"%_prog%"  "%dp0%\\node_modules\\pkg\\cli.js" %*\r\n', 'utf8');
  writeFileSync(scriptPath, 'console.log("ok");\n', 'utf8');

  try {
    assert.equal(parseShimFile(cmdPath), scriptPath);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('parseShimFile resolves extensionless entrypoints when no .js match exists', () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'cli-spawn-win-parse-noext-'));
  mkdirSync(join(tempRoot, 'node_modules', 'opencode-ai', 'bin'), { recursive: true });

  const cmdPath = join(tempRoot, 'opencode.cmd');
  const scriptPath = join(tempRoot, 'node_modules', 'opencode-ai', 'bin', 'opencode');

  writeFileSync(cmdPath, '"%dp0%\\node_modules\\opencode-ai\\bin\\opencode" %*\r\n', 'utf8');
  writeFileSync(scriptPath, '#!/usr/bin/env node\nconsole.log("ok");\n', 'utf8');

  try {
    assert.equal(parseShimFile(cmdPath), scriptPath);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('parseShimFile resolves native exe entrypoints when the shim directly launches a CLI binary', () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'cli-spawn-win-parse-native-exe-'));
  mkdirSync(join(tempRoot, 'node_modules', '@anthropic-ai', 'claude-code', 'bin'), { recursive: true });

  const cmdPath = join(tempRoot, 'claude.cmd');
  const exePath = join(tempRoot, 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');

  writeFileSync(cmdPath, '"%dp0%\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe" %*\r\n', 'utf8');
  writeFileSync(exePath, 'MZ fake native exe', 'utf8');

  try {
    assert.equal(parseShimFile(cmdPath), exePath);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('parseShimFile prefers .js match over extensionless when both exist', () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'cli-spawn-win-parse-prefer-js-'));
  mkdirSync(join(tempRoot, 'node_modules', 'pkg', 'bin'), { recursive: true });

  const cmdPath = join(tempRoot, 'test.cmd');
  const jsScript = join(tempRoot, 'node_modules', 'pkg', 'bin', 'cli.js');
  const noextScript = join(tempRoot, 'node_modules', 'pkg', 'bin', 'cli');

  // Shim references the .js version
  writeFileSync(cmdPath, '"%dp0%\\node_modules\\pkg\\bin\\cli.js" %*\r\n', 'utf8');
  writeFileSync(jsScript, 'console.log("js");\n', 'utf8');
  writeFileSync(noextScript, 'console.log("noext");\n', 'utf8');

  try {
    assert.equal(parseShimFile(cmdPath), jsScript);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('parseShimFile resolves absolute %APPDATA% paths in .cmd shims (#284)', () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'cli-spawn-win-appdata-shim-'));
  const originalAppData = process.env.APPDATA;
  const fakeAppData = join(tempRoot, 'appdata');

  mkdirSync(join(fakeAppData, 'npm', 'node_modules', '@anthropic-ai', 'claude-code'), { recursive: true });

  const cmdPath = join(tempRoot, 'claude.cmd');
  const scriptPath = join(fakeAppData, 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js');

  writeFileSync(
    cmdPath,
    '@IF EXIST "%~dp0\\node.exe" (\r\n  "%~dp0\\node.exe" "%APPDATA%\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*\r\n) ELSE (\r\n  node "%APPDATA%\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*\r\n)\r\n',
    'utf8',
  );
  writeFileSync(scriptPath, 'console.log("ok");\n', 'utf8');

  try {
    process.env.APPDATA = fakeAppData;
    const resolved = parseShimFile(cmdPath);
    assert.equal(resolved, scriptPath);
  } finally {
    if (originalAppData === undefined) {
      delete process.env.APPDATA;
    } else {
      process.env.APPDATA = originalAppData;
    }
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('parseShimFile prefers relative %dp0 paths over absolute %APPDATA% paths', () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'cli-spawn-win-prefer-rel-'));
  const originalAppData = process.env.APPDATA;
  const fakeAppData = join(tempRoot, 'appdata');

  mkdirSync(join(tempRoot, 'node_modules', 'pkg'), { recursive: true });
  mkdirSync(join(fakeAppData, 'npm', 'node_modules', 'pkg'), { recursive: true });

  const cmdPath = join(tempRoot, 'test.cmd');
  const relScript = join(tempRoot, 'node_modules', 'pkg', 'cli.js');
  const absScript = join(fakeAppData, 'npm', 'node_modules', 'pkg', 'cli.js');

  writeFileSync(
    cmdPath,
    '@"%dp0\\node_modules\\pkg\\cli.js" "%APPDATA%\\npm\\node_modules\\pkg\\cli.js" %*\r\n',
    'utf8',
  );
  writeFileSync(relScript, 'console.log("rel");\n', 'utf8');
  writeFileSync(absScript, 'console.log("abs");\n', 'utf8');

  try {
    process.env.APPDATA = fakeAppData;
    const resolved = parseShimFile(cmdPath);
    assert.equal(resolved, relScript, 'relative path should be preferred over absolute');
  } finally {
    if (originalAppData === undefined) {
      delete process.env.APPDATA;
    } else {
      process.env.APPDATA = originalAppData;
    }
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('parseShimFile resolves native .exe entrypoints when no .js or extensionless match (#234)', () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'cli-spawn-win-exe-target-'));
  mkdirSync(join(tempRoot, 'node_modules', '@anthropic-ai', 'claude-code', 'bin'), { recursive: true });

  const cmdPath = join(tempRoot, 'claude.cmd');
  const exePath = join(tempRoot, 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');

  writeFileSync(
    cmdPath,
    '@IF EXIST "%~dp0\\node.exe" (\r\n  "%~dp0\\node.exe" "%~dp0\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe" %*\r\n)\r\n',
    'utf8',
  );
  writeFileSync(exePath, 'MZ fake exe', 'utf8');

  try {
    const resolved = parseShimFile(cmdPath);
    assert.equal(resolved, exePath, 'must resolve to claude.exe, not node.exe');
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('parseShimFile skips sibling node.exe and resolves claude.exe in native .exe pass (#247 regression)', () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'cli-spawn-win-exe-node-sibling-'));
  mkdirSync(join(tempRoot, 'node_modules', '@anthropic-ai', 'claude-code', 'bin'), { recursive: true });

  const cmdPath = join(tempRoot, 'claude.cmd');
  const fakeNodeExe = join(tempRoot, 'node.exe');
  const claudeExe = join(tempRoot, 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');

  writeFileSync(
    cmdPath,
    [
      '@ECHO off',
      'SETLOCAL',
      'SET dp0=%~dp0',
      'IF EXIST "%dp0%\\node.exe" (',
      '  "%dp0%\\node.exe" "%dp0%\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe" %*',
      ') ELSE (',
      '  "%dp0%\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe" %*',
      ')',
    ].join('\r\n'),
    'utf8',
  );
  writeFileSync(fakeNodeExe, 'MZ fake node', 'utf8');
  writeFileSync(claudeExe, 'MZ fake claude', 'utf8');

  try {
    const resolved = parseShimFile(cmdPath);
    assert.equal(resolved, claudeExe, 'must resolve to claude.exe, not node.exe');
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('resolveWindowsShimSpawn spawns native .exe directly instead of via node (#234)', () => {
  const exePath = join(tmpdir(), 'claude-shim-exe-test.exe');

  const resolved = resolveWindowsShimSpawn('claude', ['--json', '-p', 'hello'], exePath);

  assert.deepEqual(resolved, {
    command: exePath,
    args: ['--json', '-p', 'hello'],
  });
});

// --- resolveCmdShimScript full-path tests ---

test('resolveCmdShimScript resolves full .cmd path directly without where fallback', () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'cli-spawn-win-fullpath-'));
  mkdirSync(join(tempRoot, 'node_modules', 'pkg'), { recursive: true });

  const cmdPath = join(tempRoot, 'test-fullpath.cmd');
  const scriptPath = join(tempRoot, 'node_modules', 'pkg', 'cli.js');

  writeFileSync(cmdPath, '@"%dp0\\node_modules\\pkg\\cli.js" %*\n', 'utf8');
  writeFileSync(scriptPath, 'console.log("ok");\n', 'utf8');

  try {
    const resolved = resolveCmdShimScript(cmdPath);
    assert.equal(resolved, scriptPath);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test(
  'resolveCmdShimScript with full path does NOT fall back to where when parsing fails',
  { skip: process.platform === 'win32' && 'uses fake where shell script (Unix only)' },
  () => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'cli-spawn-win-no-fallback-'));
    const originalPath = process.env.PATH;
    const fakeBin = join(tempRoot, 'bin');
    const shimDir = join(tempRoot, 'shim');
    const whereDir = join(tempRoot, 'where-target');

    mkdirSync(fakeBin, { recursive: true });
    mkdirSync(shimDir, { recursive: true });
    mkdirSync(join(whereDir, 'node_modules', 'pkg'), { recursive: true });

    const badCmdPath = join(shimDir, 'test-no-fallback.cmd');
    const whereCmd = join(whereDir, 'test-no-fallback.cmd');
    const whereScript = join(whereDir, 'node_modules', 'pkg', 'cli.js');
    const fakeWhere = join(fakeBin, 'where');

    // Full-path .cmd points to missing script → parsing should fail
    writeFileSync(badCmdPath, '@"%dp0\\missing\\cli.js" %*\n', 'utf8');
    // where would find a different .cmd that resolves successfully
    writeFileSync(whereCmd, '@"%dp0\\node_modules\\pkg\\cli.js" %*\n', 'utf8');
    writeFileSync(whereScript, 'console.log("where-found");\n', 'utf8');
    writeFileSync(fakeWhere, `#!/bin/sh\nprintf '%s\n' '${whereCmd}'\n`, 'utf8');
    chmodSync(fakeWhere, 0o755);

    try {
      process.env.PATH = `${fakeBin}:${originalPath ?? ''}`;
      // Pass the full path — should NOT fall back to bare name `where` search
      const resolved = resolveCmdShimScript(badCmdPath);
      assert.equal(resolved, null, 'full-path failure must NOT fall back to where');
    } finally {
      process.env.PATH = originalPath;
      rmSync(tempRoot, { recursive: true, force: true });
    }
  },
);

test('resolveCmdShimScript with full .exe path does NOT fall back to APPDATA known paths', () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'cli-spawn-win-exe-no-appdata-'));
  const originalAppData = process.env.APPDATA;
  const appDataDir = join(tempRoot, 'appdata');

  mkdirSync(join(appDataDir, 'npm', 'node_modules', '@anthropic-ai', 'claude-code'), {
    recursive: true,
  });

  const appDataScript = join(appDataDir, 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js');
  writeFileSync(appDataScript, 'console.log("appdata");\n', 'utf8');

  try {
    process.env.APPDATA = appDataDir;
    // Full .exe path — should NOT be remapped to APPDATA install
    const resolved = resolveCmdShimScript(join(tempRoot, 'bin', 'claude.exe'));
    assert.equal(resolved, null, 'full .exe path must NOT fall back to APPDATA');
  } finally {
    if (originalAppData === undefined) {
      delete process.env.APPDATA;
    } else {
      process.env.APPDATA = originalAppData;
    }
    rmSync(tempRoot, { recursive: true, force: true });
  }
});
