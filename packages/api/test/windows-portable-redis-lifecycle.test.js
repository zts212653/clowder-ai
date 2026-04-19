import assert from 'node:assert/strict';
import test from 'node:test';
import {
  commandHelpersScript,
  helpersScript,
  installScript,
  startBatScript,
  startWindowsScript,
  stopWindowsScript,
  uiHelpersScript,
} from './windows-portable-redis-test-helpers.js';

test('Windows service job failure sets exit code 1 instead of falling through with success', () => {
  assert.match(startWindowsScript, /\$serviceFailure = \$false/);
  assert.match(startWindowsScript, /\$serviceFailure = \$true/);
  assert.match(startWindowsScript, /if \(\$serviceFailure\) \{\s+exit 1\s+\}/s);
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
  assert.match(
    installScript,
    /Exit-InstallerIfCancelled -ErrorRecord \$frozenInstallResult\.ErrorRecord -Context "pnpm install"/,
  );
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
  assert.match(
    startWindowsScript,
    /\$storageMode = if \(\$useRedis -and \$safeEffectiveRedisUrl\) \{ "Redis \(\$safeEffectiveRedisUrl\)" \}/,
  );
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

test('Windows startup preserves configured REDIS_URL with DB suffix and credentials when local Redis is already running', () => {
  assert.match(
    startWindowsScript,
    /if \(\$configuredRedisUrl\) \{\s+\$env:REDIS_URL = \$configuredRedisUrl\s+\} else \{\s+\$env:REDIS_URL = "redis:\/\/localhost:\$RedisPort"\s+\}/s,
  );
});

test('Windows startup refuses non-Clowder Redis listeners before reusing port 6399', () => {
  assert.match(
    startWindowsScript,
    /\$redisConnections = Get-NetTCPConnection -LocalPort \$RedisPort -State Listen -ErrorAction SilentlyContinue/,
  );
  assert.match(startWindowsScript, /\$managedRedisPid = Get-ManagedProcessId -PidFile \$redisPidFile/);
  assert.match(
    startWindowsScript,
    /\$isClowderOwned = \$isManagedPid -or \(Test-ClowderOwnedProcess -ProcessId \$conn\.OwningProcess -ProjectRoot \$ProjectRoot\)/,
  );
  assert.match(
    startWindowsScript,
    /Write-Err "Redis port \$RedisPort is in use by non-Clowder PID \$\(\$conn\.OwningProcess\)\. Stop it manually or change REDIS_PORT\."/,
  );
  assert.match(startWindowsScript, /throw "Redis port \$RedisPort is in use by a non-Clowder process"/);
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
  assert.match(
    commandHelpersScript,
    /Merge-ToolPathSegments -PathValues @\(\$processPath, \$machinePath, \$userPath\)/,
  );
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
  assert.match(
    stopWindowsScript,
    /\$redisPidFile = if \(\$redisLayout\) \{ Join-Path \$redisLayout\.Data "redis-\$RedisPort\.pid" \} else \{ \$null \}/,
  );
  assert.match(
    stopWindowsScript,
    /\$redisConnections = Get-NetTCPConnection -LocalPort \$RedisPort -State Listen -ErrorAction SilentlyContinue/,
  );
  assert.match(stopWindowsScript, /\$managedRedisPid = Get-ManagedProcessId -ManagedPidFile \$redisPidFile/);
  assert.match(
    stopWindowsScript,
    /\$isClowderOwned = \$isManagedPid -or \(Test-ClowderOwnedProcess -ProcessId \$conn\.OwningProcess -ClowderProjectRoot \$ProjectRoot\)/,
  );
  assert.match(stopWindowsScript, /Write-Warn "Skipping non-Clowder Redis listener on port \$RedisPort/);
  assert.match(stopWindowsScript, /Get-RedisAuthArgs\s+-RedisUrl\s+\$configuredRedisUrl/);
  assert.match(stopWindowsScript, /@redisAuthArgs\s+ping/);
  assert.match(stopWindowsScript, /@redisAuthArgs\s+shutdown/);
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

test('Windows installer runs preflight before Node and pnpm bootstrap', () => {
  const preflightIndex = installScript.indexOf('$preflightScript = Join-Path $ProjectRoot "scripts\\preflight.ps1"');
  const nodeStepIndex = installScript.indexOf('Write-Step "Step 2/9 - Node.js and pnpm"');
  const wingetIndex = installScript.indexOf('winget install OpenJS.NodeJS.LTS');
  const npmIndex = installScript.indexOf('& $npmCommand install -g pnpm');
  const corepackIndex = installScript.indexOf('& $corepackCommand install -g pnpm@latest');

  assert.notEqual(preflightIndex, -1, 'install.ps1 must contain the preflight block');
  assert.notEqual(nodeStepIndex, -1, 'install.ps1 must still contain the Node/pnpm step');
  assert.notEqual(wingetIndex, -1, 'install.ps1 must still contain winget bootstrap');
  assert.notEqual(npmIndex, -1, 'install.ps1 must still contain npm pnpm bootstrap');
  assert.notEqual(corepackIndex, -1, 'install.ps1 must still contain corepack pnpm bootstrap');
  assert.ok(preflightIndex < nodeStepIndex, 'preflight must run before Node/pnpm step begins');
  assert.ok(preflightIndex < wingetIndex, 'preflight must run before winget Node bootstrap');
  assert.ok(preflightIndex < npmIndex, 'preflight must run before npm pnpm bootstrap');
  assert.ok(preflightIndex < corepackIndex, 'preflight must run before corepack pnpm bootstrap');
});

test('Windows installer strips surrounding quotes when loading .env into the build session', () => {
  assert.match(installScript, /\$val = \$Matches\[2\]\.Trim\(\)\.Trim\('"'\)\.Trim\("'"\)/);
  assert.match(installScript, /SetEnvironmentVariable\(\$key, \$val, "Process"\)/);
});

test('Windows installer overwrites stale process env with the current repo .env before build', () => {
  assert.match(installScript, /SetEnvironmentVariable\(\$key, \$val, "Process"\)/);
  assert.doesNotMatch(installScript, /if \(-not \[System\.Environment\]::GetEnvironmentVariable\(\$key\)\) \{/);
});
