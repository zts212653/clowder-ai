import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const testDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(testDir, '..', '..', '..');
const installScript = readFileSync(join(repoRoot, 'scripts', 'install.ps1'), 'utf8');
const commandHelpersPath = join(repoRoot, 'scripts', 'windows-command-helpers.ps1');
const commandHelpersScript = existsSync(commandHelpersPath)
  ? readFileSync(commandHelpersPath, 'utf8')
  : '';
const helpersScript = readFileSync(join(repoRoot, 'scripts', 'install-windows-helpers.ps1'), 'utf8');
const startWindowsScript = readFileSync(join(repoRoot, 'scripts', 'start-windows.ps1'), 'utf8');
const startBatPath = join(repoRoot, 'scripts', 'start.bat');
const startBatScript = existsSync(startBatPath) ? readFileSync(startBatPath, 'utf8') : '';

test('Windows installer resolves its script path via PSCommandPath before MyInvocation fallback', () => {
  assert.match(installScript, /\$ScriptPath = if \(\$PSCommandPath\)/);
  assert.match(installScript, /\$MyInvocation\.MyCommand\.Path/);
});

test('Windows installer treats non-git directories as a warning instead of a PowerShell native command error', () => {
  const gitProbeIndex = installScript.indexOf('& git -C $projectRoot rev-parse --is-inside-work-tree 1>$null 2>$null');
  const tryIndex = installScript.lastIndexOf('try {', gitProbeIndex);
  const catchIndex = installScript.indexOf('} catch {}', gitProbeIndex);
  const warningIndex = installScript.indexOf('Write-Warn "No .git directory detected');

  assert.notEqual(gitProbeIndex, -1, 'expected git worktree probe');
  assert.notEqual(tryIndex, -1, 'expected git probe to be wrapped in try/catch');
  assert.notEqual(catchIndex, -1, 'expected git probe to swallow PowerShell native command errors');
  assert.notEqual(warningIndex, -1, 'expected non-git installs to warn instead of exiting');
  assert.ok(tryIndex < gitProbeIndex, 'expected try block to begin before git probe');
  assert.ok(gitProbeIndex < catchIndex, 'expected catch block after git probe');
  assert.ok(catchIndex < warningIndex, 'expected warning path after the protected git probe');
});

test('Windows installer probes the npm shim path when pnpm is installed but not yet on PATH', () => {
  assert.match(commandHelpersScript, /Join-Path \$env:APPDATA "npm\\\$Name\.cmd"/);
  assert.match(installScript, /Resolve-PnpmCommand/);
  assert.match(installScript, /Invoke-Pnpm/);
  assert.match(installScript, /Resolve-ToolCommand -Name "pnpm"/);
});

test('Windows scripts share a generic npm shim resolver for pnpm and agent CLIs', () => {
  assert.match(commandHelpersScript, /function Resolve-ToolCommand/);
  assert.match(commandHelpersScript, /Join-Path \$env:APPDATA "npm\\\$Name\.cmd"/);
  assert.match(commandHelpersScript, /function Invoke-ToolCommand/);
  assert.match(helpersScript, /\$hasClaude = \$null -ne \(Resolve-ToolCommand -Name "claude"\)/);
  assert.match(helpersScript, /\$hasCodex = \$null -ne \(Resolve-ToolCommand -Name "codex"\)/);
  assert.match(helpersScript, /\$hasGemini = \$null -ne \(Resolve-ToolCommand -Name "gemini"\)/);
});

test('Windows installer keeps portable Redis inside the project .cat-cafe directory', () => {
  assert.match(helpersScript, /Join-Path \$ProjectRoot "\.cat-cafe\\redis\\windows"/);
  assert.match(helpersScript, /ArchiveDir = Join-Path \$[A-Za-z]+ "archives"/);
  assert.match(helpersScript, /Data = Join-Path \$[A-Za-z]+ "data"/);
  assert.match(helpersScript, /Logs = Join-Path \$[A-Za-z]+ "logs"/);
  assert.doesNotMatch(helpersScript, /Join-Path \$ProjectRoot "downloads\\redis\\windows"/);
});

test('Windows installer prefers plain portable Redis zips before service bundles', () => {
  const msys2Zip = helpersScript.indexOf('Windows-x64-msys2\\.zip$');
  const msys2ServiceZip = helpersScript.indexOf('Windows-x64-msys2-with-Service\\.zip$');

  assert.notEqual(msys2Zip, -1, 'expected portable msys2 zip asset selection');
  assert.notEqual(msys2ServiceZip, -1, 'expected service zip fallback selection');
  assert.ok(msys2Zip < msys2ServiceZip, 'portable zip should be preferred before service zip');
});

test('Windows startup resolves portable Redis from the shared helper before global PATH lookup', () => {
  assert.match(startWindowsScript, /install-windows-helpers\.ps1/);
  assert.match(startWindowsScript, /Resolve-PortableRedisBinaries -ProjectRoot \$ProjectRoot/);
  assert.match(startWindowsScript, /Resolve-PortableRedisLayout -ProjectRoot \$ProjectRoot/);
  assert.match(startWindowsScript, /"--dir", \$redisLayout\.Data/);
  assert.match(startWindowsScript, /"--logfile", \$redisLogFile/);
  assert.match(helpersScript, /function Resolve-GlobalRedisBinaries/);
  assert.match(helpersScript, /Get-Command redis-server -ErrorAction SilentlyContinue/);
});

test('Windows installer and startup reuse shared tool resolution instead of raw pnpm PATH lookups', () => {
  assert.match(installScript, /Resolve-ToolCommand -Name "pnpm"/);
  assert.match(installScript, /Invoke-ToolCommand -Name "corepack" -Args @\("enable"\)/);
  assert.match(installScript, /Invoke-ToolCommand -Name "npm" -Args @\("install", "-g", "pnpm"\)/);
  assert.match(installScript, /Resolve-ToolCommand -Name \$tool\.Cmd/);
  assert.match(startWindowsScript, /\$pnpmCommand = Resolve-ToolCommand -Name "pnpm"/);
  assert.match(startWindowsScript, /& \$pnpmCommand run build/);
  assert.match(startWindowsScript, /param\(\$root, \$port, \$pnpmPath\)/);
  assert.match(startWindowsScript, /& \$pnpmPath exec next dev -p \$port/);
  assert.match(startWindowsScript, /& \$pnpmPath exec next start -p \$port -H 0\.0\.0\.0/);
});

test('Windows start.bat delegates to start-windows.ps1', () => {
  assert.match(startBatScript, /powershell/i);
  assert.match(startBatScript, /start-windows\.ps1/);
});
