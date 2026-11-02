'use strict';

/** Read-only follow-up for one observed production callback: metadata and ACL aggregates, never contents or ACL writes. */

const BASELINE_ROOT_ENV = 'CLOWDER_WINDOWS_PRIVATE_OBSERVER_ROOT';
const SAFE_CODE = /^[A-Z][A-Z0-9_]{0,31}$/u;
const SAFE_SIGNAL = /^SIG[A-Z0-9]{1,12}$/u;
const PUBLISHABLE_CATEGORY_REASONS = new Map([
  ['objectnotfound', 'ObjectNotFound'],
  ['operationstopped', 'OperationStopped'],
  ['permissiondenied', 'PermissionDenied'],
  ['securityerror', 'SecurityError'],
]);
const PUBLISHABLE_EXCEPTION_TYPES = new Map([
  ['parentcontainserrorrecordexception', 'ParentContainsErrorRecordException'],
  ['runtimeexception', 'RuntimeException'],
  ['unauthorizedaccessexception', 'UnauthorizedAccessException'],
]);
const PUBLISHABLE_FULLY_QUALIFIED_ERROR_IDS = new Map([
  ['acl_read_failed', 'ACL_READ_FAILED'],
  ['couldnotautoloadmatchingmodule', 'CouldNotAutoloadMatchingModule'],
  ['unauthorizedaccess', 'UnauthorizedAccess'],
]);

const READ_ONLY_CENSUS_SCRIPT = `
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
Import-Module Microsoft.PowerShell.Security -ErrorAction Stop

$rootPath = [Environment]::GetEnvironmentVariable('${BASELINE_ROOT_ENV}', 'Process')
if ([String]::IsNullOrWhiteSpace($rootPath)) { throw 'Private observer root was not provided' }
$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
try { $currentSid = $identity.User.Value } finally { $identity.Dispose() }
if ([String]::IsNullOrWhiteSpace($currentSid)) { throw 'Current Windows user has no SID' }

$root = Get-Item -Force -LiteralPath $rootPath -ErrorAction Stop
$pending = [System.Collections.Generic.Stack[object]]::new()
$pending.Push([PSCustomObject]@{ Item = $root; Depth = 0 })
$itemCount = 0
$maxDepth = 0
$reparseCount = 0
$aclInspectedCount = 0
$maxRuleCount = 0
$ownerCounts = @{ current = 0; admin = 0; system = 0; other = 0 }

while ($pending.Count -gt 0) {
  $entry = $pending.Pop()
  $item = [System.IO.FileSystemInfo] $entry.Item
  $depth = [int] $entry.Depth
  $itemCount++
  if ($depth -gt $maxDepth) { $maxDepth = $depth }
  if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
    $reparseCount++
    continue
  }

  $acl = Get-Acl -LiteralPath $item.FullName -ErrorAction Stop
  $owner = $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value
  if ($owner -eq $currentSid) { $ownerCounts.current++ }
  elseif ($owner -eq 'S-1-5-32-544') { $ownerCounts.admin++ }
  elseif ($owner -eq 'S-1-5-18') { $ownerCounts.system++ }
  else { $ownerCounts.other++ }
  $rules = @($acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]))
  $aclInspectedCount++
  if ($rules.Count -gt $maxRuleCount) { $maxRuleCount = $rules.Count }

  if ($item -is [System.IO.DirectoryInfo]) {
    foreach ($child in $item.EnumerateFileSystemInfos()) {
      $pending.Push([PSCustomObject]@{ Item = $child; Depth = $depth + 1 })
    }
  }
}

[PSCustomObject]@{
  itemCount = $itemCount
  maxDepth = $maxDepth
  reparseCount = $reparseCount
  aclInspectedCount = $aclInspectedCount
  ownerCounts = $ownerCounts
  maxRuleCount = $maxRuleCount
} | ConvertTo-Json -Compress -Depth 4
`;

function safeRead(value, key) {
  try {
    return value && (typeof value === 'object' || typeof value === 'function') ? value[key] : undefined;
  } catch {
    return undefined;
  }
}

function safeByteLength(value) {
  if (typeof value === 'string') return Buffer.byteLength(value);
  if (Buffer.isBuffer(value) || ArrayBuffer.isView(value)) return value.byteLength;
  return null;
}

function stderrText(value) {
  if (typeof value === 'string') return value;
  if (Buffer.isBuffer(value)) return value.toString('utf8');
  return '';
}

function normalizePowerShellText(value) {
  return stderrText(value)
    .replaceAll('_x000D__x000A_', '\n')
    .replaceAll('_x000A_', '\n')
    .replaceAll('_x000D_', '\n')
    .replace(/<[^>]*>/gu, '')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&amp;', '&');
}

function lastCapture(text, pattern) {
  let value;
  for (const match of text.matchAll(pattern)) value = match[1]?.trim();
  return value;
}

function publishKnownIdentifier(value, allowlist) {
  return typeof value === 'string' ? (allowlist.get(value.toLowerCase()) ?? null) : null;
}

function projectPowerShellDiagnostic(stderr) {
  const text = normalizePowerShellText(stderr);
  const category = lastCapture(text, /CategoryInfo\s*:\s*([^\r\n]+)/giu);
  let categoryInfo = null;
  if (category && !/^[A-Za-z]:[\\/]/u.test(category) && !/^\\\\/u.test(category)) {
    const separator = category.indexOf(':');
    const reason = (separator === -1 ? category : category.slice(0, separator)).trim();
    const exceptionType = category.includes(',') ? category.slice(category.lastIndexOf(',') + 1).trim() : null;
    const publishedReason = publishKnownIdentifier(reason, PUBLISHABLE_CATEGORY_REASONS);
    if (publishedReason)
      categoryInfo = {
        reason: publishedReason,
        exceptionType: publishKnownIdentifier(exceptionType, PUBLISHABLE_EXCEPTION_TYPES),
      };
  }
  const rawId = lastCapture(text, /FullyQualifiedErrorId\s*:\s*([^\r\n]+)/giu);
  const firstId = rawId?.split(',')[0]?.trim();
  return {
    categoryInfo,
    fullyQualifiedErrorId: publishKnownIdentifier(firstId, PUBLISHABLE_FULLY_QUALIFIED_ERROR_IDS),
  };
}

function projectExecFileCallback({ error, stdout, stderr, elapsedMs, observerSha256 }) {
  const diagnostic = error ? projectPowerShellDiagnostic(stderr) : { categoryInfo: null, fullyQualifiedErrorId: null };
  return {
    v: 1,
    kind: 'collective_windows_private_execfile',
    observerSha256,
    outcome: error ? 'error' : 'success',
    elapsedMs: Number.isFinite(elapsedMs) && elapsedMs >= 0 ? Math.min(Math.trunc(elapsedMs), 86_400_000) : 0,
    code: safeCode(safeRead(error, 'code')),
    killed: safeRead(error, 'killed') === true,
    signal: safeSignal(safeRead(error, 'signal')),
    stdoutBytes: safeByteLength(stdout),
    stderrBytes: safeByteLength(stderr),
    ...diagnostic,
  };
}

function safeCode(value) {
  if (Number.isSafeInteger(value) && value >= 0) return value;
  return typeof value === 'string' && SAFE_CODE.test(value) ? value : null;
}

function safeSignal(value) {
  return typeof value === 'string' && SAFE_SIGNAL.test(value) ? value : null;
}

function boundedInteger(value, maximum = 10_000_000) {
  return Number.isSafeInteger(value) && value >= 0 && value <= maximum ? value : null;
}

function projectCensus(stdout) {
  try {
    const parsed = JSON.parse(stderrText(stdout));
    const census = {
      itemCount: boundedInteger(parsed.itemCount),
      maxDepth: boundedInteger(parsed.maxDepth),
      reparseCount: boundedInteger(parsed.reparseCount),
      aclInspectedCount: boundedInteger(parsed.aclInspectedCount),
      ownerCounts: {
        current: boundedInteger(parsed.ownerCounts?.current),
        admin: boundedInteger(parsed.ownerCounts?.admin),
        system: boundedInteger(parsed.ownerCounts?.system),
        other: boundedInteger(parsed.ownerCounts?.other),
      },
      maxRuleCount: boundedInteger(parsed.maxRuleCount, 100_000),
    };
    const values = [
      census.itemCount,
      census.maxDepth,
      census.reparseCount,
      census.aclInspectedCount,
      census.maxRuleCount,
      ...Object.values(census.ownerCounts),
    ];
    if (values.some((value) => value === null)) return null;
    const ownerTotal = Object.values(census.ownerCounts).reduce((sum, value) => sum + value, 0);
    if (
      census.reparseCount > census.itemCount ||
      census.aclInspectedCount > census.itemCount ||
      ownerTotal !== census.aclInspectedCount ||
      census.maxDepth > census.itemCount
    )
      return null;
    return census;
  } catch {
    return null;
  }
}

function runReadOnlyBaseline({
  execFile,
  executable,
  privateRoot,
  inheritedEnvironment,
  appendRecord,
  observerSha256,
  nowNs = process.hrtime.bigint,
}) {
  return new Promise((resolve) => {
    const started = nowNs();
    const finish = (error, stdout, stderr) => {
      const census = error ? null : projectCensus(stdout);
      const record = {
        ...projectExecFileCallback({
          error,
          stdout,
          stderr,
          elapsedMs: Number((nowNs() - started) / 1_000_000n),
          observerSha256,
        }),
        kind: 'collective_windows_private_readonly_baseline',
        outcome: error ? 'error' : census ? 'success' : 'invalid_output',
        census,
      };
      try {
        appendRecord(record);
      } catch {}
      resolve(record);
    };
    try {
      execFile(
        executable,
        [
          '-NoLogo',
          '-NoProfile',
          '-NonInteractive',
          '-EncodedCommand',
          Buffer.from(READ_ONLY_CENSUS_SCRIPT, 'utf16le').toString('base64'),
        ],
        {
          env: { ...inheritedEnvironment, [BASELINE_ROOT_ENV]: privateRoot },
          maxBuffer: 64 * 1024,
          timeout: 30_000,
          windowsHide: true,
        },
        finish,
      );
    } catch (error) {
      finish(error, '', '');
    }
  });
}

module.exports = {
  READ_ONLY_CENSUS_SCRIPT,
  projectExecFileCallback,
  projectPowerShellDiagnostic,
  runReadOnlyBaseline,
};
