import assert from 'node:assert/strict';
import test from 'node:test';
import {
  helpersScript,
  installScript,
  startWindowsScript,
  stopWindowsScript,
  uiHelpersScript,
} from './windows-portable-redis-test-helpers.js';

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
  assert.match(helpersScript, /\[System\.Uri\]::TryCreate\(\$RedisUrl, \[System\.UriKind\]::Absolute, \[ref\]\$uri\)/);
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

test('Windows Redis URL handling preserves external backends and treats localhost URLs with suffixes as local', () => {
  assert.match(startWindowsScript, /Test-LocalRedisUrl -RedisUrl \$configuredRedisUrl -RedisPort \$RedisPort/);
  assert.match(helpersScript, /\$uri\.Host -notin @\("localhost", "127\.0\.0\.1"\)/);
  assert.match(helpersScript, /if \(\$uri\.Port -gt 0 -and "\$\(\$uri\.Port\)" -ne "\$RedisPort"\) \{/);
  assert.match(
    stopWindowsScript,
    /\$configuredRedisUrl = Get-InstallerEnvValueFromFile -EnvFile \$envFile -Key "REDIS_URL"\s+if \(-not \$configuredRedisUrl -and \$env:REDIS_URL\) \{\s+\$configuredRedisUrl = \$env:REDIS_URL\.Trim\(\)\s+\}/,
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

test('Windows installer filters local Redis URLs from external default to avoid misleading keep_external option', () => {
  assert.match(uiHelpersScript, /Test-LocalRedisUrl -RedisUrl \$rawUrl -RedisPort \$redisPort/);
  assert.match(uiHelpersScript, /if \(Test-LocalRedisUrl -RedisUrl \$rawUrl -RedisPort \$redisPort\) \{ return "" \}/);
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

test('Windows startup preserves configured REDIS_URL with DB suffix after Redis auto-start', () => {
  const pattern =
    /if \(\$configuredRedisUrl\) \{\s+\$env:REDIS_URL = \$configuredRedisUrl\s+\} else \{\s+\$env:REDIS_URL = "redis:\/\/localhost:\$RedisPort"\s+\}/g;
  const matches = startWindowsScript.match(pattern);
  assert.ok(
    matches && matches.length >= 2,
    `Expected REDIS_URL preservation in both already-running and auto-start branches, found ${matches ? matches.length : 0}`,
  );
});

test('Windows Test-LocalRedisUrl treats IPv6 loopback [::1] as local', () => {
  assert.match(helpersScript, /\[System\.Net\.IPAddress\]::TryParse\(\$uri\.Host, \[ref\]\$ipAddress\)/);
  assert.match(helpersScript, /\[System\.Net\.IPAddress\]::IsLoopback\(\$ipAddress\)/);
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
