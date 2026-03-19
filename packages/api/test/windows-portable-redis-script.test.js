import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const testDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(testDir, '..', '..', '..');
const installScript = readFileSync(join(repoRoot, 'scripts', 'install.ps1'), 'utf8');
const commandHelpersPath = join(repoRoot, 'scripts', 'windows-command-helpers.ps1');
const commandHelpersScript = existsSync(commandHelpersPath) ? readFileSync(commandHelpersPath, 'utf8') : '';
const uiHelpersPath = join(repoRoot, 'scripts', 'windows-installer-ui.ps1');
const uiHelpersScript = existsSync(uiHelpersPath) ? readFileSync(uiHelpersPath, 'utf8') : '';
const helpersScript = readFileSync(join(repoRoot, 'scripts', 'install-windows-helpers.ps1'), 'utf8');
const startWindowsScript = readFileSync(join(repoRoot, 'scripts', 'start-windows.ps1'), 'utf8');
const stopWindowsPath = join(repoRoot, 'scripts', 'stop-windows.ps1');
const stopWindowsScript = existsSync(stopWindowsPath) ? readFileSync(stopWindowsPath, 'utf8') : '';
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

test('Windows installer treats winget Node install failures as retryable instead of terminating native command errors', () => {
  const wingetInstallIndex = installScript.indexOf(
    'winget install OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements --silent 2>$null',
  );
  const tryIndex = installScript.lastIndexOf('try {', wingetInstallIndex);
  const catchIndex = installScript.indexOf('} catch {', wingetInstallIndex);
  const cancelExitIndex = installScript.indexOf(
    'Exit-InstallerIfCancelled -ErrorRecord $_ -Context "Node.js installation"',
    catchIndex,
  );
  const fallbackWarnIndex = installScript.indexOf(
    'Write-Warn "winget Node.js install failed - falling back to manual prerequisite check"',
  );
  const manualInstallIndex = installScript.indexOf(
    'Write-Err "Node.js >= 20 required. Install from https://nodejs.org/"',
  );

  assert.notEqual(wingetInstallIndex, -1, 'expected winget-based Node install path');
  assert.notEqual(tryIndex, -1, 'expected winget install to be wrapped in try/catch');
  assert.notEqual(catchIndex, -1, 'expected winget install catch block');
  assert.notEqual(cancelExitIndex, -1, 'expected winget path to abort on user cancellation');
  assert.notEqual(fallbackWarnIndex, -1, 'expected fallback warning after non-cancellation failure');
  assert.notEqual(manualInstallIndex, -1, 'expected manual install fallback after winget failure');
  assert.ok(tryIndex < wingetInstallIndex, 'expected try block before winget install');
  assert.ok(wingetInstallIndex < catchIndex, 'expected catch block after winget install');
  assert.ok(catchIndex < cancelExitIndex, 'expected cancellation handling inside winget catch path');
  assert.ok(cancelExitIndex < fallbackWarnIndex, 'expected normal fallback after cancellation check');
  assert.ok(fallbackWarnIndex < manualInstallIndex, 'expected manual install fallback after protected winget path');
});

test('Windows installer revalidates Node major version after winget install', () => {
  assert.ok(
    installScript.includes("if ($nodeRaw -match 'v(\\d+)\\.(\\d+)') {"),
    'expected Node.js version check to rerun after winget install',
  );
  assert.match(installScript, /\$nodeMajor = \[int\]\$Matches\[1\]/);
  assert.match(installScript, /if \(\$nodeMajor -ge 20\) \{/);
  assert.match(installScript, /Write-Warn "Node\.js \$nodeRaw still too old after winget install"/);
});

test('Windows installer retries plain pnpm install when frozen lockfile mode hits a native command error', () => {
  const frozenInstallIndex = installScript.indexOf(
    'Invoke-Pnpm -CommandArgs @("install", "--frozen-lockfile") 2>$null',
  );
  const tryIndex = installScript.lastIndexOf('try {', frozenInstallIndex);
  const catchIndex = installScript.indexOf('} catch {', frozenInstallIndex);
  const capturedErrorIndex = installScript.indexOf('$frozenInstallError = $_', catchIndex);
  const cancelExitIndex = installScript.indexOf(
    'Exit-InstallerIfCancelled -ErrorRecord $frozenInstallError -Context "pnpm install"',
  );
  const retryWarnIndex = installScript.indexOf('Write-Warn "Frozen lockfile failed, retrying..."');
  const retryInstallIndex = installScript.indexOf('Invoke-Pnpm -CommandArgs @("install")', retryWarnIndex);

  assert.notEqual(frozenInstallIndex, -1, 'expected frozen lockfile install attempt');
  assert.notEqual(tryIndex, -1, 'expected frozen lockfile attempt to be wrapped in try/catch');
  assert.notEqual(catchIndex, -1, 'expected frozen lockfile attempt catch block');
  assert.notEqual(capturedErrorIndex, -1, 'expected frozen lockfile catch to capture the error record');
  assert.notEqual(cancelExitIndex, -1, 'expected retry path to abort on user cancellation');
  assert.notEqual(retryWarnIndex, -1, 'expected retry warning after frozen lockfile failure');
  assert.notEqual(retryInstallIndex, -1, 'expected plain pnpm install retry after frozen lockfile failure');
  assert.ok(tryIndex < frozenInstallIndex, 'expected try block before frozen lockfile install');
  assert.ok(frozenInstallIndex < catchIndex, 'expected catch block after frozen lockfile install');
  assert.ok(catchIndex < capturedErrorIndex, 'expected frozen lockfile catch to save the error record');
  assert.ok(capturedErrorIndex < cancelExitIndex, 'expected cancellation check before retry warning');
  assert.ok(cancelExitIndex < retryWarnIndex, 'expected retry warning after protected frozen lockfile path');
  assert.ok(retryWarnIndex < retryInstallIndex, 'expected plain install retry after warning');
});

test('Windows command forwarding helpers avoid PowerShell automatic $args collisions', () => {
  assert.match(installScript, /function Invoke-Pnpm/);
  assert.match(installScript, /param\(\[string\[\]\]\$CommandArgs\)/);
  assert.match(installScript, /Invoke-ToolCommand -Name "pnpm" -CommandArgs \$CommandArgs/);
  assert.doesNotMatch(installScript, /param\(\[string\[\]\]\$Args\)/);
  assert.doesNotMatch(installScript, /Invoke-ToolCommand -Name "pnpm" -Args \$Args/);

  assert.match(commandHelpersScript, /function Invoke-ToolCommand/);
  assert.match(commandHelpersScript, /param\(\[string\]\$Name, \[string\[\]\]\$CommandArgs\)/);
  assert.match(commandHelpersScript, /& \$toolCommand @CommandArgs/);
  assert.doesNotMatch(commandHelpersScript, /param\(\[string\]\$Name, \[string\[\]\]\$Args\)/);
  assert.doesNotMatch(commandHelpersScript, /& \$toolCommand @Args/);

  assert.match(helpersScript, /function Invoke-InstallerAuthHelper/);
  assert.match(helpersScript, /param\(\$State, \[string\[\]\]\$CommandArgs\)/);
  assert.match(helpersScript, /& node \$State\.HelperPath @CommandArgs/);
  assert.match(helpersScript, /\$profileArgs = @\("claude-profile", "set"/);
  assert.match(helpersScript, /Invoke-InstallerAuthHelper \$State \$profileArgs/);
  assert.doesNotMatch(helpersScript, /param\(\$State, \[string\[\]\]\$Args\)/);
  assert.doesNotMatch(helpersScript, /& node \$State\.HelperPath @Args/);
  assert.doesNotMatch(helpersScript, /\$args = @\("claude-profile", "set"/);
});

test('Windows installer probes the npm shim path when pnpm is installed but not yet on PATH', () => {
  assert.match(
    commandHelpersScript,
    /@\(\(Join-Path \$env:APPDATA "npm\\\$Name\.cmd"\), \(Join-Path \$env:APPDATA "npm\\\$Name\.ps1"\), \(Join-Path \$env:APPDATA "npm\\\$Name"\)\)/,
  );
  assert.match(commandHelpersScript, /Join-Path \$env:APPDATA "npm\\\$Name\.cmd"/);
  assert.match(commandHelpersScript, /Join-Path \$env:APPDATA "npm\\\$Name\.ps1"/);
  assert.match(commandHelpersScript, /prefix -g/);
  assert.match(commandHelpersScript, /Select-Object -Last 1/);
  assert.match(
    commandHelpersScript,
    /@\(\(Join-Path \$npmPrefix "\$Name\.cmd"\), \(Join-Path \$npmPrefix "\$Name\.ps1"\), \(Join-Path \$npmPrefix \$Name\)\)/,
  );
  assert.match(commandHelpersScript, /Join-Path \$npmPrefix "\$Name\.cmd"/);
  assert.match(commandHelpersScript, /Join-Path \$npmPrefix "\$Name\.ps1"/);
  assert.match(installScript, /Resolve-PnpmCommand/);
  assert.match(installScript, /Invoke-Pnpm/);
  assert.match(installScript, /Resolve-ToolCommand -Name "pnpm"/);
});

test('Windows installer prints pnpm resolver diagnostics before giving up', () => {
  assert.match(commandHelpersScript, /function Get-ToolCommandCandidates/);
  assert.match(commandHelpersScript, /Write-Warn "\$Name resolver candidates:"/);
  assert.match(commandHelpersScript, /Write-Warn " {2}\[\$status\] \$candidate"/);
  assert.match(installScript, /Write-ToolResolutionDiagnostics -Name "pnpm"/);
});

test('Windows scripts share a generic npm shim resolver for pnpm and agent CLIs', () => {
  assert.match(commandHelpersScript, /function Resolve-ToolCommand/);
  assert.match(commandHelpersScript, /function Resolve-ToolCommandWithRetry/);
  assert.match(commandHelpersScript, /Join-Path \$env:APPDATA "npm\\\$Name\.cmd"/);
  assert.match(commandHelpersScript, /function Invoke-ToolCommand/);
  assert.match(helpersScript, /\$hasClaude = \$null -ne \(Resolve-ToolCommandWithRetry -Name "claude" -Attempts 6\)/);
  assert.match(helpersScript, /\$hasCodex = \$null -ne \(Resolve-ToolCommandWithRetry -Name "codex" -Attempts 6\)/);
  assert.match(helpersScript, /\$hasGemini = \$null -ne \(Resolve-ToolCommandWithRetry -Name "gemini" -Attempts 6\)/);
});

test('Windows tool resolution prefers explicit shim candidates before generic Get-Command resolution', () => {
  const candidatesIndex = commandHelpersScript.indexOf(
    'foreach ($candidate in (Get-ToolCommandCandidates -Name $Name))',
  );
  const getCommandIndex = commandHelpersScript.indexOf(
    '$toolCommand = Get-Command $Name -ErrorAction SilentlyContinue',
  );

  assert.notEqual(candidatesIndex, -1, 'expected explicit shim candidate loop');
  assert.notEqual(getCommandIndex, -1, 'expected Get-Command fallback');
  assert.ok(
    candidatesIndex < getCommandIndex,
    'expected shim candidates to be preferred before generic Get-Command lookup',
  );
});

test('Windows tool resolution validates shim candidates before returning the first existing path', () => {
  assert.match(commandHelpersScript, /function Test-ToolCommandCandidate/);
  assert.match(commandHelpersScript, /& \$Candidate "--version" 1>\$null 2>\$null/);
  assert.match(commandHelpersScript, /if \(Test-ToolCommandCandidate -Candidate \$candidate\) \{/);
});

test('Windows installer uses interactive selectors instead of typed or letter-based menus', () => {
  assert.match(uiHelpersScript, /function Select-InstallerChoice/);
  assert.match(uiHelpersScript, /function Select-InstallerMultiChoice/);
  assert.match(uiHelpersScript, /if \(-not \$text\) \{ \$text = \$Option\.Name \}/);
  assert.match(uiHelpersScript, /if \(-not \$text\) \{ \$text = \$Option\.Cmd \}/);
  assert.match(uiHelpersScript, /\[\*\] /);
  assert.match(uiHelpersScript, /\[ \] /);
  assert.match(uiHelpersScript, /Use Up\/Down arrows to move, Enter to select/);
  assert.match(uiHelpersScript, /Space to toggle, Enter to confirm/);
  assert.match(installScript, /Name = "Claude"; Label = "Claude"; Cmd = "claude"/);
  assert.match(installScript, /Name = "Codex"; Label = "Codex"; Cmd = "codex"/);
  assert.match(installScript, /Name = "Gemini"; Label = "Gemini"; Cmd = "gemini"/);
  assert.match(installScript, /Select-InstallerMultiChoice -Title "Missing agent CLIs"/);
  assert.doesNotMatch(uiHelpersScript, /Label = "&All"/);
  assert.doesNotMatch(uiHelpersScript, /Label = "&Select"/);
  assert.doesNotMatch(uiHelpersScript, /Prompt "Install \$\(\$option.Name\)\?"/);
  assert.doesNotMatch(installScript, /Read-Host " {4}Install which\?"/);
  assert.doesNotMatch(uiHelpersScript, /↑|↓|◉|◯/);
  assert.match(helpersScript, /Select-InstallerChoice -Title "Claude auth"/);
  assert.match(helpersScript, /Select-InstallerChoice -Title "Codex auth"/);
  assert.match(helpersScript, /Select-InstallerChoice -Title "Gemini auth"/);
  assert.doesNotMatch(helpersScript, /Read-Host " {4}Choose \[1\/2\]/);
});

test('Windows installer masks provider API key prompts instead of echoing secrets', () => {
  assert.match(helpersScript, /function Read-InstallerSecret/);
  assert.match(helpersScript, /Read-Host \$Prompt -AsSecureString/);
  assert.match(helpersScript, /SecureStringToBSTR/);
  assert.match(helpersScript, /ZeroFreeBSTR/);

  const apiPromptMatches = helpersScript.match(/\$apiKey = Read-InstallerSecret " {4}API Key"/g) ?? [];
  assert.equal(apiPromptMatches.length, 3, 'expected Claude, Codex, and Gemini API key prompts to use masked input');
  assert.doesNotMatch(helpersScript, /\$apiKey = Read-Host " {4}API Key"/);
});

test('Windows installer prefers npm before corepack when bootstrapping pnpm', () => {
  assert.match(installScript, /\$npmCommand = Resolve-ToolCommand -Name "npm"/);
  assert.match(installScript, /& \$npmCommand install -g pnpm 2>\$null/);
  assert.doesNotMatch(installScript, /Invoke-ToolCommand -Name "npm" -Args @\("install", "-g", "pnpm"\)/);

  assert.match(installScript, /\$corepackCommand = Resolve-ToolCommand -Name "corepack"/);
  assert.match(installScript, /& \$corepackCommand enable 2>\$null/);
  assert.match(installScript, /& \$corepackCommand install -g pnpm@latest 2>\$null/);
  assert.doesNotMatch(installScript, /corepack" -Args @\("prepare", "pnpm@latest", "--activate"\)/);

  const npmIndex = installScript.indexOf('$npmCommand = Resolve-ToolCommand -Name "npm"');
  const corepackIndex = installScript.indexOf('$corepackCommand = Resolve-ToolCommand -Name "corepack"');
  assert.notEqual(npmIndex, -1, 'expected explicit npm resolution');
  assert.notEqual(corepackIndex, -1, 'expected explicit corepack resolution');
  assert.ok(npmIndex < corepackIndex, 'expected npm bootstrap path before corepack fallback on Windows');
});

test('Windows installer retries pnpm shim detection after bootstrap instead of failing on the first probe', () => {
  assert.match(installScript, /function Get-PnpmStatus/);
  assert.match(installScript, /param\(\[int\]\$Attempts = 1, \[int\]\$DelayMs = 500\)/);
  assert.match(installScript, /for \(\$attempt = 0; \$attempt -lt \$Attempts; \$attempt\+\+\)/);
  assert.match(installScript, /Start-Sleep -Milliseconds \$DelayMs/);
  assert.match(installScript, /\$pnpmStatus = Get-PnpmStatus -Attempts 6/);
});

test('Windows CLI installs use the explicit npm command path and Redis mode only offers portable or external', () => {
  assert.match(installScript, /\$npmInstallCommand = Resolve-ToolCommand -Name "npm"/);
  assert.match(installScript, /& \$npmInstallCommand install -g \$tool\.Pkg 2>\$null/);
  assert.match(uiHelpersScript, /Select-InstallerChoice -Title "Redis setup"/);
  assert.match(uiHelpersScript, /Install Redis locally \(recommended\)/);
  assert.match(uiHelpersScript, /Use external Redis URL/);
  assert.match(uiHelpersScript, /Value = "portable"/);
  assert.match(uiHelpersScript, /Value = "external"/);
  assert.doesNotMatch(uiHelpersScript, /Value = "memory"/);
  assert.doesNotMatch(uiHelpersScript, /using memory storage/);
  assert.doesNotMatch(uiHelpersScript, /Write-Warn "Memory mode — data will be lost on restart"/);
  assert.match(installScript, /Resolve-InstallerRedisPlan -ProjectRoot \$ProjectRoot/);
});

test('Windows installer headless Redis planning respects existing external Redis defaults', () => {
  assert.match(uiHelpersScript, /function Get-InstallerExternalRedisUrl/);
  assert.match(uiHelpersScript, /\$envFile = Join-Path \$ProjectRoot "\.env"/);
  assert.match(uiHelpersScript, /\$rawUrl = Get-InstallerEnvValueFromFile -EnvFile \$envFile -Key "REDIS_URL"/);
  assert.match(
    uiHelpersScript,
    /\} elseif \(\$defaultRedisUrl\) \{ "keep_external" \} elseif \(\$anyRedisUrl\) \{ "keep_local" \} else \{ "portable" \}/,
  );
  assert.match(uiHelpersScript, /if \(\$mode -eq "keep_external"\) \{/);
  assert.match(uiHelpersScript, /Mode = "external"; RedisUrl = \$defaultRedisUrl/);
  assert.match(
    uiHelpersScript,
    /if \(Test-InstallerConsoleUi\) \{ Read-Host " {2}External Redis URL" \} else \{ \$defaultRedisUrl \}/,
  );
});

test('Windows installer headless rerun preserves local authenticated Redis URL via keep_local mode', () => {
  assert.match(uiHelpersScript, /function Get-InstallerAnyRedisUrl/);
  assert.match(uiHelpersScript, /\$anyRedisUrl = Get-InstallerAnyRedisUrl -ProjectRoot \$ProjectRoot/);
  assert.match(uiHelpersScript, /Mode = "keep_local"; RedisUrl = \$anyRedisUrl/);
  assert.match(uiHelpersScript, /if \(\$Plan\.Mode -eq "external" -or \$Plan\.Mode -eq "keep_local"\) \{/);
  assert.match(uiHelpersScript, /if \(\$Plan\.Mode -eq "keep_local"\) \{/);
  assert.match(uiHelpersScript, /Preserving local Redis URL/);
  assert.match(uiHelpersScript, /\} elseif \(\$anyRedisUrl\) \{/);
  assert.match(uiHelpersScript, /Keep current Redis \(\$safeLabel\)/);
  assert.match(uiHelpersScript, /Keep the current local Redis configuration/);
  assert.match(uiHelpersScript, /Value = "keep_local"/);
  assert.match(uiHelpersScript, /function Get-InstallerRedactedRedisUrl/);
  assert.match(uiHelpersScript, /\$safeLabel = Get-InstallerRedactedRedisUrl -RedisUrl \$anyRedisUrl/);
  assert.match(uiHelpersScript, /Get-RedactedRedisUrl -RedisUrl \$RedisUrl/);
});

test('Windows installer validates external Redis URLs before persisting them', () => {
  assert.match(helpersScript, /function Get-InstallerExternalRedisValidationError/);
  assert.match(
    helpersScript,
    /\[System\.Uri\]::TryCreate\(\$RedisUrl, \[System\.UriKind\]::Absolute, \[ref\]\$uri\)/,
  );
  assert.match(helpersScript, /\$uri\.Scheme -notin @\("redis", "rediss"\)/);
  assert.match(helpersScript, /\[System\.Net\.Sockets\.TcpClient\]::new\(\)/);

  const validationIndex = uiHelpersScript.indexOf(
    '$redisValidationError = Get-InstallerExternalRedisValidationError -RedisUrl $Plan.RedisUrl',
  );
  const setEnvIndex = uiHelpersScript.indexOf('Set-InstallerEnvValue $State "REDIS_URL" $Plan.RedisUrl');

  assert.notEqual(validationIndex, -1, 'expected Apply-InstallerRedisPlan to validate external Redis URLs');
  assert.notEqual(setEnvIndex, -1, 'expected REDIS_URL to still be written after validation passes');
  assert.ok(validationIndex < setEnvIndex, 'expected external Redis validation before writing REDIS_URL');
  assert.match(
    uiHelpersScript,
    /if \(\$Plan\.Mode -eq "external"\) \{\s+\$redisValidationError = Get-InstallerExternalRedisValidationError -RedisUrl \$Plan\.RedisUrl\s+if \(\$redisValidationError\) \{\s+Write-Warn \$redisValidationError\s+return \$false\s+\}\s+\}/s,
  );
});

test('Windows installer ignores ambient REDIS_URL until this repo has its own .env', () => {
  const guardedAmbientPattern =
    /\$rawUrl = Get-InstallerEnvValueFromFile -EnvFile \$envFile -Key "REDIS_URL"\s+if \(-not \$rawUrl -and \(Test-Path \$envFile\) -and \$env:REDIS_URL\) \{\s+\$rawUrl = \$env:REDIS_URL\.Trim\(\)\s+\}/g;
  const matches = uiHelpersScript.match(guardedAmbientPattern);
  assert.ok(
    matches && matches.length >= 2,
    `expected both installer REDIS_URL helpers to guard ambient fallback behind repo .env existence, found ${matches ? matches.length : 0}`,
  );
});

test('Windows service job failure sets exit code 1 instead of falling through with success', () => {
  assert.match(startWindowsScript, /\$serviceFailure = \$false/);
  assert.match(startWindowsScript, /\$serviceFailure = \$true/);
  assert.match(startWindowsScript, /if \(\$serviceFailure\) \{\s+exit 1\s+\}/s);
});

test('Windows Redis auth helpers decode percent-escaped ACL credentials before invoking redis-cli or redis-server', () => {
  assert.match(helpersScript, /function Get-RedisAuthArgs/);
  assert.match(helpersScript, /function Get-RedisServerAuthArgs/);
  assert.match(helpersScript, /\$parts = \$userInfo -split ":", 2/);
  const decodeMatches = helpersScript.match(/\[System\.Uri\]::UnescapeDataString\(\$parts\[(0|1)\]\)/g);
  assert.ok(
    decodeMatches && decodeMatches.length >= 4,
    `expected Redis auth helpers to decode both username/password parts before use, found ${decodeMatches ? decodeMatches.length : 0}`,
  );
});

test('Windows installer exits immediately when native installs are cancelled by the user', () => {
  assert.match(installScript, /function Test-InstallerCancellation/);
  assert.match(installScript, /function Exit-InstallerIfCancelled/);
  assert.match(installScript, /\$exceptionType = \$exception\.GetType\(\)\.FullName/);
  assert.match(installScript, /\$exceptionType -eq 'System\.Management\.Automation\.PipelineStoppedException'/);
  assert.match(installScript, /\$exceptionType -eq 'System\.Management\.Automation\.OperationStoppedException'/);
  assert.doesNotMatch(installScript, /-is \[System\.Management\.Automation\.OperationStoppedException\]/);
  assert.match(installScript, /if \(Test-InstallerCancellation -ErrorRecord \$ErrorRecord\) \{/);
  assert.match(installScript, /Write-Err "\$Context cancelled by user"/);
  assert.match(installScript, /Exit-InstallerIfCancelled -ErrorRecord \$_ -Context "pnpm installation"/);
  assert.match(installScript, /Exit-InstallerIfCancelled -ErrorRecord \$frozenInstallError -Context "pnpm install"/);
  assert.match(installScript, /Exit-InstallerIfCancelled -ErrorRecord \$_ -Context "\$\(\$tool.Name\) CLI install"/);
  assert.match(installScript, /exit 1/);
});

test('Windows PowerShell scripts stay ASCII-only to avoid console codepage issues', () => {
  const windowsScriptBundle = [
    installScript,
    helpersScript,
    uiHelpersScript,
    startWindowsScript,
    stopWindowsScript,
  ].join('\n');

  assert.equal(
    [...windowsScriptBundle].some((char) => char.charCodeAt(0) > 0x7f),
    false,
  );
});

test('Windows portable Redis defers REDIS_URL to runtime instead of hardcoding localhost:6379', () => {
  assert.match(uiHelpersScript, /function Apply-InstallerRedisPlan/);
  assert.match(uiHelpersScript, /Add-InstallerEnvDelete \$State "REDIS_URL"/);
  assert.doesNotMatch(uiHelpersScript, /Set-InstallerEnvValue \$State "REDIS_URL" "redis:\/\/localhost:6379"/);
  assert.doesNotMatch(installScript, /REDIS_URL=redis:\/\/localhost:6379/);
});

test('Windows installer keeps portable Redis inside the project .cat-cafe directory', () => {
  assert.match(helpersScript, /Join-Path \$ProjectRoot "\.cat-cafe\\redis\\windows"/);
  assert.match(helpersScript, /ArchiveDir = Join-Path \$[A-Za-z]+ "archives"/);
  assert.match(helpersScript, /Data = Join-Path \$[A-Za-z]+ "data"/);
  assert.match(helpersScript, /Logs = Join-Path \$[A-Za-z]+ "logs"/);
  assert.doesNotMatch(helpersScript, /Join-Path \$ProjectRoot "downloads\\redis\\windows"/);
});

test('Windows installer allows explicit Redis release API and archive URL overrides', () => {
  assert.match(helpersScript, /\$redisReleaseApi = if \(\$env:CAT_CAFE_WINDOWS_REDIS_RELEASE_API\)/);
  assert.match(helpersScript, /\$redisDownloadUrl = if \(\$env:CAT_CAFE_WINDOWS_REDIS_DOWNLOAD_URL\)/);
  assert.match(helpersScript, /Invoke-RestMethod -Uri \$redisReleaseApi -Headers \$headers/);
  assert.match(helpersScript, /if \(\$redisDownloadUrl\) \{/);
  assert.match(
    helpersScript,
    /Invoke-WebRequest -Uri \$redisDownloadUrl -OutFile \$archivePath -Headers \$headers -UseBasicParsing/,
  );
});

test('Windows Redis failures print underlying exception details for installer and startup debugging', () => {
  assert.match(helpersScript, /function Get-InstallerExceptionDetails/);
  assert.match(helpersScript, /function Write-InstallerExceptionDetails/);
  assert.match(helpersScript, /Write-InstallerExceptionDetails -Context "Redis auto-install" -ErrorRecord \$_/);
  assert.match(startWindowsScript, /Write-InstallerExceptionDetails -Context "Redis start" -ErrorRecord \$_/);
});

test('Windows exception detail interpolation avoids PowerShell colon parsing traps', () => {
  assert.match(helpersScript, /\$\(\$typeName\): \$message/);
  assert.doesNotMatch(helpersScript, /\$typeName: \$message/);
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
  assert.match(helpersScript, /function Resolve-GlobalRedisBinaries/);
  assert.match(helpersScript, /Get-Command redis-server -ErrorAction SilentlyContinue/);
});

test('Windows startup quotes portable Redis file arguments before Start-Process', () => {
  assert.match(helpersScript, /function Quote-WindowsProcessArgument/);
  assert.match(startWindowsScript, /Quote-WindowsProcessArgument -Value \$redisLayout\.Data/);
  assert.match(startWindowsScript, /Quote-WindowsProcessArgument -Value \$redisLogFile/);
  assert.match(startWindowsScript, /Quote-WindowsProcessArgument -Value \$redisPidFile/);
  assert.match(helpersScript, /Quote-WindowsProcessArgument -Value \$AclFilePath/);
});

test('Windows stop script only stops Clowder-owned API and frontend listeners', () => {
  assert.match(
    stopWindowsScript,
    /\$RunDir = if \(\$ProjectRoot\) \{ Join-Path \$ProjectRoot "\.cat-cafe\/run\/windows" \} else \{ \$null \}/,
  );
  assert.match(stopWindowsScript, /Get-ManagedProcessId/);
  assert.match(stopWindowsScript, /Test-ClowderOwnedProcess/);
  assert.match(
    stopWindowsScript,
    /\$isClowderOwned = \$isManagedPid -or \(Test-ClowderOwnedProcess -ProcessId \$conn\.OwningProcess -ClowderProjectRoot \$ProjectRoot\)/,
  );
  assert.match(stopWindowsScript, /Write-Warn "Skipping non-Clowder \$Name listener on port \$Port/);
  assert.match(stopWindowsScript, /Write-Warn "\$Name \(port \$Port\) - no Clowder-owned listener found"/);
  assert.match(stopWindowsScript, /\$normalizedRoot = \$ClowderProjectRoot\.TrimEnd\('\\', '\/'\) \+ '\\'/);
});

test('Windows startup preserves runtime Redis overrides, validates artifacts, and exits when service jobs stop', () => {
  assert.match(startWindowsScript, /\$configuredRedisUrl = if \(\$env:REDIS_URL\)/);
  assert.match(helpersScript, /function Test-LocalRedisUrl/);
  assert.match(helpersScript, /function Get-RedactedRedisUrl/);
  assert.match(
    startWindowsScript,
    /\$useExternalRedis = \$useRedis -and \$configuredRedisUrl -and -not \(Test-LocalRedisUrl -RedisUrl \$configuredRedisUrl -RedisPort \$RedisPort\)/,
  );
  assert.match(startWindowsScript, /\$safeConfiguredRedisUrl = Get-RedactedRedisUrl -RedisUrl \$configuredRedisUrl/);
  assert.match(startWindowsScript, /Write-Ok "Using external Redis: \$safeConfiguredRedisUrl"/);
  assert.match(startWindowsScript, /\$safeEffectiveRedisUrl = Get-RedactedRedisUrl -RedisUrl \$effectiveRedisUrl/);
  assert.match(startWindowsScript, /\$storageMode = if \(\$useRedis -and \$safeEffectiveRedisUrl\) \{ "Redis \(\$safeEffectiveRedisUrl\)" \}/);
  assert.match(startWindowsScript, /\$runtimeEnvOverrides = @\{/);
  assert.match(startWindowsScript, /REDIS_URL = \$env:REDIS_URL/);
  assert.match(startWindowsScript, /MEMORY_STORE = \$env:MEMORY_STORE/);
  assert.match(startWindowsScript, /try \{\s+# -- Build \(unless -Quick\) -+\s+if \(-not \$Quick\) \{/s);
  assert.match(startWindowsScript, /\$apiEntry = Join-Path \$ProjectRoot "packages\/api\/dist\/index\.js"/);
  assert.match(startWindowsScript, /API build artifact not found - run without -Quick first to build/);
  assert.match(startWindowsScript, /Write-Err "Build failed: shared";\s+throw "Build failed: shared"/);
  assert.match(startWindowsScript, /Write-Err "Build failed: mcp-server";\s+throw "Build failed: mcp-server"/);
  assert.match(startWindowsScript, /Write-Err "Build failed: api";\s+throw "Build failed: api"/);
  assert.match(startWindowsScript, /Write-Err "Build failed: web";\s+throw "Build failed: web"/);
  assert.match(startWindowsScript, /\$nextCli = Join-Path \$ProjectRoot "node_modules\/next\/dist\/bin\/next"/);
  assert.match(startWindowsScript, /Write-Err "Next CLI not found at \$nextCli - run pnpm install first"/);
  assert.match(startWindowsScript, /Service job '\$\(\$job.Name\)' stopped \(\$\(\$job.State\)\)/);
});

test('Windows Redis URL handling preserves external backends and treats localhost URLs with suffixes as local', () => {
  assert.match(startWindowsScript, /Test-LocalRedisUrl -RedisUrl \$configuredRedisUrl -RedisPort \$RedisPort/);
  assert.match(helpersScript, /\$uri\.Host -notin @\("localhost", "127\.0\.0\.1"\)/);
  assert.match(helpersScript, /if \(\$uri\.Port -gt 0 -and "\$\(\$uri\.Port\)" -ne "\$RedisPort"\) \{/);
  assert.match(
    stopWindowsScript,
    /\$configuredRedisUrl = if \(\$env:REDIS_URL\) \{ \$env:REDIS_URL\.Trim\(\) \} else \{ Get-InstallerEnvValueFromFile -EnvFile \$envFile -Key "REDIS_URL" \}/,
  );
  assert.match(
    stopWindowsScript,
    /if \(\$configuredRedisUrl -and -not \(Test-LocalRedisUrl -RedisUrl \$configuredRedisUrl -RedisPort \$RedisPort\)\) \{/,
  );
  assert.match(
    stopWindowsScript,
    /Write-Warn "Skipping local Redis shutdown because REDIS_URL points to an external host"/,
  );
});

test('Windows startup preserves configured REDIS_URL with DB suffix and credentials when local Redis is already running', () => {
  assert.match(
    startWindowsScript,
    /if \(\$configuredRedisUrl\) \{\s+\$env:REDIS_URL = \$configuredRedisUrl\s+\} else \{\s+\$env:REDIS_URL = "redis:\/\/localhost:\$RedisPort"\s+\}/s,
  );
});

test('Windows installer filters local Redis URLs from external default to avoid misleading keep_external option', () => {
  assert.match(uiHelpersScript, /Test-LocalRedisUrl -RedisUrl \$rawUrl -RedisPort \$redisPort/);
  assert.match(uiHelpersScript, /if \(Test-LocalRedisUrl -RedisUrl \$rawUrl -RedisPort \$redisPort\) \{ return "" \}/);
});

test('Windows startup only stops Clowder-owned listeners and records managed service PIDs', () => {
  assert.match(startWindowsScript, /\$RunDir = Join-Path \$ProjectRoot "\.cat-cafe\/run\/windows"/);
  assert.match(startWindowsScript, /\$ApiPidFile = Join-Path \$RunDir "api-\$ApiPort\.pid"/);
  assert.match(startWindowsScript, /function Get-ManagedProcessId/);
  assert.match(startWindowsScript, /function Set-ManagedProcessId/);
  assert.match(startWindowsScript, /function Test-ClowderOwnedProcess/);
  assert.match(startWindowsScript, /Get-CimInstance Win32_Process -Filter "ProcessId = \$ProcessId"/);
  assert.match(startWindowsScript, /Port \$Port \(\$Name\) is in use by non-Clowder PID/);
  assert.match(
    startWindowsScript,
    /Stop-PortProcess -Port \(\[int\]\$ApiPort\) -Name "API" -PidFile \$ApiPidFile -ProjectRoot \$ProjectRoot/,
  );
  assert.match(startWindowsScript, /Set-ManagedProcessId -Port \(\[int\]\$ApiPort\) -PidFile \$ApiPidFile/);
  assert.match(startWindowsScript, /Clear-ManagedProcessId -PidFile \$ApiPidFile/);
});

test('Windows installer and startup reuse shared tool resolution instead of raw pnpm PATH lookups', () => {
  assert.match(installScript, /Resolve-ToolCommand -Name "pnpm"/);
  assert.match(installScript, /\$corepackCommand = Resolve-ToolCommand -Name "corepack"/);
  assert.match(installScript, /\$npmCommand = Resolve-ToolCommand -Name "npm"/);
  assert.match(installScript, /Resolve-ToolCommand -Name \$tool\.Cmd/);
  assert.match(startWindowsScript, /\$pnpmCommand = Resolve-ToolCommand -Name "pnpm"/);
  assert.match(startWindowsScript, /& \$pnpmCommand run build/);
  assert.match(startWindowsScript, /param\(\$root, \$port, \$nextCli\)/);
  assert.match(startWindowsScript, /& node \$nextCli dev \(Join-Path \$root "packages\/web"\) -p \$port/);
  assert.match(
    startWindowsScript,
    /& node \$nextCli start \(Join-Path \$root "packages\/web"\) -p \$port -H 0\.0\.0\.0/,
  );
});

test('Windows CLI installs retry command discovery before warning and auth detection uses the same retry helper', () => {
  assert.match(commandHelpersScript, /function Resolve-ToolCommandWithRetry/);
  assert.match(commandHelpersScript, /param\(\[string\]\$Name, \[int\]\$Attempts = 1, \[int\]\$DelayMs = 500\)/);
  assert.match(commandHelpersScript, /for \(\$attempt = 0; \$attempt -lt \$Attempts; \$attempt\+\+\)/);
  assert.match(commandHelpersScript, /Start-Sleep -Milliseconds \$DelayMs/);
  assert.match(installScript, /Resolve-ToolCommandWithRetry -Name \$tool\.Cmd -Attempts 6/);
  assert.match(helpersScript, /Resolve-ToolCommandWithRetry -Name "claude" -Attempts 6/);
  assert.match(helpersScript, /Resolve-ToolCommandWithRetry -Name "codex" -Attempts 6/);
  assert.match(helpersScript, /Resolve-ToolCommandWithRetry -Name "gemini" -Attempts 6/);
});

test('Windows PATH refresh preserves shell-provided shim entries while appending machine and user paths', () => {
  assert.match(commandHelpersScript, /function Merge-ToolPathSegments/);
  assert.match(commandHelpersScript, /\$processPath = \$env:Path/);
  assert.match(commandHelpersScript, /Merge-ToolPathSegments -PathValues @\(\$processPath, \$machinePath, \$userPath\)/);
  assert.match(commandHelpersScript, /\$normalized = \$candidate\.TrimEnd\('\\'\)\.ToLowerInvariant\(\)/);
  assert.match(installScript, /function Refresh-Path \{\s+Sync-ToolPath\s+\}/s);
  assert.doesNotMatch(
    installScript,
    /\$env:Path = \[System\.Environment\]::GetEnvironmentVariable\("Path", "Machine"\) \+ ";" \+\s+\[System\.Environment\]::GetEnvironmentVariable\("Path", "User"\)/,
  );
});

test('Windows stop script resolves redis-cli through the shared helper chain before shutdown', () => {
  assert.match(stopWindowsScript, /install-windows-helpers\.ps1/);
  assert.match(stopWindowsScript, /Resolve-PortableRedisBinaries -ProjectRoot \$ProjectRoot/);
  assert.match(stopWindowsScript, /Resolve-PortableRedisLayout -ProjectRoot \$ProjectRoot/);
  assert.match(stopWindowsScript, /Resolve-GlobalRedisBinaries/);
  assert.match(stopWindowsScript, /\$redisCli = \$redisCommands\.CliPath/);
  assert.doesNotMatch(stopWindowsScript, /& redis-cli -p \$RedisPort ping/);
  assert.match(stopWindowsScript, /\$redisPidFile = if \(\$redisLayout\) \{ Join-Path \$redisLayout\.Data "redis-\$RedisPort\.pid" \} else \{ \$null \}/);
  assert.match(stopWindowsScript, /\$redisConnections = Get-NetTCPConnection -LocalPort \$RedisPort -State Listen -ErrorAction SilentlyContinue/);
  assert.match(stopWindowsScript, /\$managedRedisPid = Get-ManagedProcessId -ManagedPidFile \$redisPidFile/);
  assert.match(stopWindowsScript, /\$isClowderOwned = \$isManagedPid -or \(Test-ClowderOwnedProcess -ProcessId \$conn\.OwningProcess -ClowderProjectRoot \$ProjectRoot\)/);
  assert.match(stopWindowsScript, /Write-Warn "Skipping non-Clowder Redis listener on port \$RedisPort/);
  // stop script must pass auth args from REDIS_URL to redis-cli (ping + shutdown)
  assert.match(stopWindowsScript, /Get-RedisAuthArgs\s+-RedisUrl\s+\$configuredRedisUrl/);
  assert.match(stopWindowsScript, /@redisAuthArgs\s+ping/);
  assert.match(stopWindowsScript, /@redisAuthArgs\s+shutdown/);
});

test('Windows installer reads FRONTEND_PORT from .env file not process environment', () => {
  assert.match(installScript, /Get-InstallerEnvValueFromFile\s+-EnvFile\s+\$envFile\s+-Key\s+"FRONTEND_PORT"/);
  assert.doesNotMatch(installScript, /\$env:FRONTEND_PORT/);
});

test('Windows start and stop scripts share Get-RedisAuthArgs from helpers instead of local definitions', () => {
  assert.match(helpersScript, /function\s+Get-RedisAuthArgs/);
  assert.doesNotMatch(startWindowsScript, /function\s+Get-RedisAuthArgs/);
  assert.doesNotMatch(stopWindowsScript, /function\s+Get-RedisAuthArgs/);
});

test('Windows start.bat delegates to start-windows.ps1', () => {
  assert.match(startBatScript, /powershell/i);
  assert.match(startBatScript, /start-windows\.ps1/);
});

test('Windows installer generates .env before building so NEXT_PUBLIC_API_URL is baked into the web bundle', () => {
  const envStepMatch = installScript.match(/Step (\d+)\/\d+ - Generate \.env/);
  const buildStepMatch = installScript.match(/Step (\d+)\/\d+ - Install dependencies and build/);
  assert.ok(envStepMatch, 'install.ps1 must have a "Generate .env" step');
  assert.ok(buildStepMatch, 'install.ps1 must have an "Install dependencies and build" step');
  assert.ok(
    Number(envStepMatch[1]) < Number(buildStepMatch[1]),
    `.env generation (Step ${envStepMatch[1]}) must come before build (Step ${buildStepMatch[1]})`,
  );
  assert.match(installScript, /SetEnvironmentVariable\(\$key, \$val, "Process"\)/);
});

test('Windows installer strips surrounding quotes when loading .env into the build session', () => {
  assert.match(installScript, /\$val = \$Matches\[2\]\.Trim\(\)\.Trim\('"'\)\.Trim\("'"\)/);
  assert.match(installScript, /SetEnvironmentVariable\(\$key, \$val, "Process"\)/);
});

test('Windows installer overwrites stale process env with the current repo .env before build', () => {
  assert.match(installScript, /SetEnvironmentVariable\(\$key, \$val, "Process"\)/);
  assert.doesNotMatch(installScript, /if \(-not \[System\.Environment\]::GetEnvironmentVariable\(\$key\)\) \{/);
});

test('Windows startup preserves configured REDIS_URL with DB suffix after Redis auto-start', () => {
  // Need >= 2 matches: "already running" branch + "auto-start" branch
  const pattern =
    /if \(\$configuredRedisUrl\) \{\s+\$env:REDIS_URL = \$configuredRedisUrl\s+\} else \{\s+\$env:REDIS_URL = "redis:\/\/localhost:\$RedisPort"\s+\}/g;
  const matches = startWindowsScript.match(pattern);
  assert.ok(
    matches && matches.length >= 2,
    `Expected REDIS_URL preservation in both already-running and auto-start branches, found ${matches ? matches.length : 0}`,
  );
});

test('Windows startup passes localhost REDIS_URL auth into redis-server auto-start and authenticated ping', () => {
  assert.match(helpersScript, /function Get-RedisServerAuthArgs/);
  assert.match(helpersScript, /\$utf8NoBom = New-Object System\.Text\.UTF8Encoding\(\$false\)/);
  assert.match(helpersScript, /\[System\.IO\.File\]::WriteAllLines\(\$AclFilePath, \$aclLines, \$utf8NoBom\)/);
  assert.doesNotMatch(helpersScript, /Set-Content -Path \$AclFilePath -Value \$aclLines -Encoding ascii/);
  assert.match(startWindowsScript, /\$redisAclFile = Join-Path \$redisLayout\.Data "redis-\$RedisPort\.acl"/);
  assert.match(
    startWindowsScript,
    /Get-RedisServerAuthArgs -RedisUrl \$configuredRedisUrl -AclFilePath \$redisAclFile/,
  );

  const pingMatches = startWindowsScript.match(
    /\$redisPing = & \$redisCliPath -p \$RedisPort @redisAuthArgs ping 2>\$null/g,
  );
  assert.ok(
    pingMatches && pingMatches.length >= 2,
    `Expected authenticated redis-cli ping in both already-running and auto-start branches, found ${pingMatches ? pingMatches.length : 0}`,
  );
  assert.match(startWindowsScript, /& \$redisCliPath -p \$RedisPort @redisAuthArgs shutdown save 2>\$null/);
});
