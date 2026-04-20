import assert from 'node:assert/strict';
import test from 'node:test';
import {
  commandHelpersScript,
  helpersScript,
  installScript,
  uiHelpersScript,
} from './windows-portable-redis-test-helpers.js';

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

test('Windows installer warns when Git is missing instead of exiting before ZIP installs can proceed', () => {
  assert.match(installScript, /\$gitCommand = Get-Command git -ErrorAction SilentlyContinue/);
  assert.match(
    installScript,
    /if \(-not \$gitCommand\) \{\s+Write-Warn "Git not found - git-dependent features will be unavailable"\s+\} else \{\s+Write-Ok "Git: \$\(& \$gitCommand\.Source --version\)"\s+\}/s,
  );
  assert.doesNotMatch(installScript, /Write-Err "Git not found\. Install from https:\/\/git-scm\.com\/ and re-run\."/);
  assert.doesNotMatch(installScript, /Write-Err "Git not found[\s\S]*?exit 1/);
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

test('Windows installer retries plain pnpm install when frozen lockfile mode still fails after protected retries', () => {
  const helperIndex = installScript.indexOf('function Invoke-PnpmInstallWithCapturedOutput');
  const frozenInstallIndex = installScript.indexOf(
    '$frozenInstallResult = Invoke-PnpmInstallWithCapturedOutput -CommandArgs @("install", "--frozen-lockfile")',
  );
  const cancelExitIndex = installScript.indexOf(
    'Exit-InstallerIfCancelled -ErrorRecord $frozenInstallResult.ErrorRecord -Context "pnpm install"',
  );
  const retryWarnIndex = installScript.indexOf('Write-Warn "Frozen lockfile failed, retrying..."');
  const retryInstallIndex = installScript.indexOf(
    '$plainInstallResult = Invoke-PnpmInstallWithCapturedOutput -CommandArgs @("install")',
    retryWarnIndex,
  );

  assert.notEqual(helperIndex, -1, 'expected captured install helper');
  assert.notEqual(frozenInstallIndex, -1, 'expected frozen lockfile install attempt via helper');
  assert.notEqual(cancelExitIndex, -1, 'expected retry path to abort on user cancellation');
  assert.notEqual(retryWarnIndex, -1, 'expected retry warning after protected frozen lockfile path');
  assert.notEqual(retryInstallIndex, -1, 'expected plain pnpm install retry after warning');
  assert.ok(helperIndex < frozenInstallIndex, 'expected helper declaration before frozen install use');
  assert.ok(frozenInstallIndex < cancelExitIndex, 'expected cancellation check after frozen install result');
  assert.ok(cancelExitIndex < retryWarnIndex, 'expected retry warning after cancellation guard');
  assert.ok(retryWarnIndex < retryInstallIndex, 'expected plain install retry after warning');
});

test('Windows installer retries with PUPPETEER_SKIP_DOWNLOAD only for Puppeteer browser download failures', () => {
  assert.match(installScript, /function Test-PuppeteerBrowserDownloadFailure/);
  assert.match(
    installScript,
    /return \$OutputText -match "puppeteer" -and\s+\(\$OutputText -match "Failed to set up chrome" -or \$OutputText -match "PUPPETEER_SKIP_DOWNLOAD"\)/,
  );
  assert.match(installScript, /function Write-PuppeteerSkipWarning/);
  assert.match(installScript, /Write-Warn "Bundled Chrome download failed - skipped"/);
  assert.match(
    installScript,
    /Write-Warn "Thread export \/ screenshot may be unavailable\. To install later: npx puppeteer browsers install chrome"/,
  );
  assert.match(
    installScript,
    /\$frozenInstallResult = Invoke-PnpmInstallWithCapturedOutput -CommandArgs @\("install", "--frozen-lockfile"\)/,
  );
  assert.match(
    installScript,
    /Invoke-PnpmInstallWithCapturedOutput -CommandArgs @\("install", "--frozen-lockfile"\) -SkipPuppeteerDownload/,
  );
  assert.match(
    installScript,
    /Invoke-PnpmInstallWithCapturedOutput -CommandArgs @\("install"\) -SkipPuppeteerDownload/,
  );
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

test('Windows OAuth helpers do not force-remove global installer accounts before set', () => {
  const codexOAuthBody = helpersScript.match(/function Set-CodexOAuthMode \{([\s\S]*?)^}/m)?.[1] ?? '';
  const geminiOAuthBody = helpersScript.match(/function Set-GeminiOAuthMode \{([\s\S]*?)^}/m)?.[1] ?? '';
  const claudeRemoveBody = helpersScript.match(/function Remove-ClaudeInstallerProfile \{([\s\S]*?)^}/m)?.[1] ?? '';

  assert.notEqual(codexOAuthBody, '', 'expected Set-CodexOAuthMode body');
  assert.notEqual(geminiOAuthBody, '', 'expected Set-GeminiOAuthMode body');
  assert.notEqual(claudeRemoveBody, '', 'expected Remove-ClaudeInstallerProfile body');

  assert.match(codexOAuthBody, /"client-auth", "set".*"--mode", "oauth"/s);
  assert.doesNotMatch(codexOAuthBody, /"client-auth", "remove"/);
  assert.doesNotMatch(codexOAuthBody, /"--force", "true"/);

  assert.match(geminiOAuthBody, /"client-auth", "set".*"--mode", "oauth"/s);
  assert.doesNotMatch(geminiOAuthBody, /"client-auth", "remove"/);
  assert.doesNotMatch(geminiOAuthBody, /"--force", "true"/);

  assert.match(claudeRemoveBody, /"claude-profile", "remove"/);
  assert.doesNotMatch(claudeRemoveBody, /"--force", "true"/);
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
  assert.match(helpersScript, /\$hasKimi = \$null -ne \(Resolve-ToolCommandWithRetry -Name "kimi" -Attempts 6\)/);
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
  assert.match(installScript, /Name = "Kimi"; Label = "Kimi"; Cmd = "kimi"/);
  assert.match(installScript, /Select-InstallerMultiChoice -Title "Missing agent CLIs"/);
  assert.doesNotMatch(uiHelpersScript, /Label = "&All"/);
  assert.doesNotMatch(uiHelpersScript, /Label = "&Select"/);
  assert.doesNotMatch(uiHelpersScript, /Prompt "Install \$\(\$option.Name\)\?"/);
  assert.doesNotMatch(installScript, /Read-Host " {4}Install which\?"/);
  assert.doesNotMatch(uiHelpersScript, /↑|↓|◉|◯/);
  assert.match(helpersScript, /Select-InstallerChoice -Title "Claude auth"/);
  assert.match(helpersScript, /Select-InstallerChoice -Title "Codex auth"/);
  assert.match(helpersScript, /Select-InstallerChoice -Title "Gemini auth"/);
  assert.match(helpersScript, /Select-InstallerChoice -Title "Kimi auth"/);
  assert.doesNotMatch(helpersScript, /Read-Host " {4}Choose \[1\/2\]/);
});

test('Windows installer masks provider API key prompts instead of echoing secrets', () => {
  assert.match(helpersScript, /function Read-InstallerSecret/);
  assert.match(helpersScript, /Read-Host \$Prompt -AsSecureString/);
  assert.match(helpersScript, /SecureStringToBSTR/);
  assert.match(helpersScript, /ZeroFreeBSTR/);

  const apiPromptMatches = helpersScript.match(/\$apiKey = Read-InstallerSecret " {4}API Key"/g) ?? [];
  assert.equal(
    apiPromptMatches.length,
    4,
    'expected Claude, Codex, Gemini, and Kimi API key prompts to use masked input',
  );
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

test('Windows skill mount detects and refreshes stale junctions instead of skipping them', () => {
  assert.match(helpersScript, /function Get-InstallerNormalizedPath/);
  assert.match(helpersScript, /function Get-InstallerSkillLinkTarget/);
  assert.match(helpersScript, /\$expectedTarget = Get-InstallerNormalizedPath -Path \$skill\.FullName/);
  assert.match(helpersScript, /\$existingTarget = Get-InstallerSkillLinkTarget -Path \$skillTarget/);
  assert.match(helpersScript, /Refreshing stale skill mount/);
  assert.match(helpersScript, /cmd \/c rmdir "\$skillTarget"/);
});
