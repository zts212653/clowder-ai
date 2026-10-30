param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('installer', 'portable')]
  [string]$Distribution,
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^[a-f0-9-]{36}$')]
  [string]$AttemptId
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$root = [IO.Path]::GetFullPath($env:CANDIDATE_ROOT)
$parent = [IO.Path]::GetFullPath($env:RUNNER_TEMP).TrimEnd('\')
if ([IO.Path]::GetDirectoryName($root) -ne $parent -or [IO.Path]::GetFileName($root) -notmatch '^f330-candidate-[A-Za-z0-9_-]+$') { throw 'Candidate root must be the download-owned temporary directory' }
$version = $env:CANDIDATE_VERSION
if ($version -notmatch '^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$') { throw 'Invalid candidate version' }
$evidence = Join-Path $root 'evidence'
$browser = Join-Path $PSScriptRoot 'browser.mjs'
$node = (Get-Command node.exe).Source
$records = [Collections.Generic.List[object]]::new()

function Expand-OwnedZip([string]$Zip, [string]$Destination, [bool]$SingleFile) {
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $archive = [IO.Compression.ZipFile]::OpenRead($Zip)
  try {
    if ($SingleFile -and $archive.Entries.Count -ne 1) { throw 'Workflow artifact must contain exactly one distribution file' }
    foreach ($entry in $archive.Entries) {
      if ($entry.FullName -match '(^[\\/]|:|(^|[\\/])\.\.([\\/]|$)|[. ]([\\/]|$))') { throw 'Unsafe archive member path' }
      if ($SingleFile -and $entry.FullName -match '[\\/]') { throw 'Distribution filename must be a basename' }
    }
  } finally { $archive.Dispose() }
  [IO.Compression.ZipFile]::ExtractToDirectory($Zip, $Destination)
}

function Start-Owned([string]$File, [string[]]$Arguments, [string]$Working, [string]$State, [int[]]$Ports, [string]$Phase) {
  $instanceHome = Join-Path $State 'home'
  $temp = Join-Path $State 'temp'
  $appdata = Join-Path $instanceHome 'AppData\Roaming'
  $local = Join-Path $instanceHome 'AppData\Local'
  foreach ($directory in @($instanceHome, $temp, $appdata, $local)) { [IO.Directory]::CreateDirectory($directory) | Out-Null }
  $start = [Diagnostics.ProcessStartInfo]::new($File)
  $start.UseShellExecute = $false
  $start.WorkingDirectory = $Working
  $start.RedirectStandardOutput = $true
  $start.RedirectStandardError = $true
  $start.Environment.Clear()
  foreach ($key in @('SystemRoot','WINDIR','COMSPEC','PATHEXT','PROCESSOR_ARCHITECTURE','NUMBER_OF_PROCESSORS','SystemDrive','ProgramFiles','ProgramFiles(x86)','ProgramW6432','ProgramData')) {
    if (Test-Path "Env:$key") { $start.Environment[$key] = (Get-Item "Env:$key").Value }
  }
  $start.Environment['PATH'] = "$env:SystemRoot\System32;$env:SystemRoot;$env:SystemRoot\System32\WindowsPowerShell\v1.0"
  foreach ($pair in @{ HOME=$instanceHome; USERPROFILE=$instanceHome; APPDATA=$appdata; LOCALAPPDATA=$local; TEMP=$temp; TMP=$temp; CAT_CAFE_DESKTOP_INSTANCE_ROOT=$State; FRONTEND_PORT=[string]$Ports[0]; API_SERVER_PORT=[string]$Ports[1]; REDIS_PORT=[string]$Ports[2] }.GetEnumerator()) { $start.Environment[$pair.Key] = $pair.Value }
  foreach ($argument in $Arguments) { $start.ArgumentList.Add($argument) }
  $process = [Diagnostics.Process]::Start($start)
  $records.Add(@{ phase=$Phase; process=$process; stdout=$process.StandardOutput.ReadToEndAsync(); stderr=$process.StandardError.ReadToEndAsync() })
  return $process
}

function Wait-Success($Process, [int]$Seconds) {
  if (-not $Process.WaitForExit($Seconds * 1000)) { throw 'Owned command exceeded its explicit deadline' }
  if ($Process.ExitCode -ne 0) { throw "Owned command failed: exit $($Process.ExitCode)" }
}

function Assert-Free([int[]]$Ports) {
  foreach ($port in $Ports) {
    if (Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue) { throw "Port $port is already listening; will not stop its owner" }
  }
}

function Wait-Ready([int]$ApiPort) {
  $deadline = [DateTime]::UtcNow.AddMinutes(3)
  while ([DateTime]::UtcNow -lt $deadline) {
    try {
      $health = Invoke-RestMethod "http://127.0.0.1:$ApiPort/health" -TimeoutSec 3
      if ($health.callbackAuth.backend -eq 'redis' -and $health.callbackAuth.durability -eq 'durable') { return }
    } catch { }
    Start-Sleep -Seconds 1
  }
  throw 'Installed application did not reach durable API readiness'
}

function Quit-Owned([string]$Exe, [string]$Install, [string]$State, [int[]]$Ports) {
  Wait-Success (Start-Owned $Exe @('--quit-owned-installation') $Install $State $Ports 'normal-quit') 20
  $deadline = [DateTime]::UtcNow.AddSeconds(30)
  do {
    $owned = @(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($root + '\', [StringComparison]::OrdinalIgnoreCase) })
    if ($owned.Count -eq 0) { Assert-Free $Ports; return }
    Start-Sleep -Seconds 1
  } while ([DateTime]::UtcNow -lt $deadline)
  throw 'Normal application exit did not release its owned processes'
}

foreach ($kind in @($Distribution)) {
  $install = Join-Path $root "$kind-install"
  $state = Join-Path $root "$kind-state"
  $output = Join-Path $evidence $kind
  [IO.Directory]::CreateDirectory($output) | Out-Null
  $ports = if ($kind -eq 'installer') { @(35471,35472,36471,35473) } else { @(35481,35482,36481,35483) }
  Assert-Free $ports
  $wrapper = Join-Path $root "$kind-distribution"
  Expand-OwnedZip (Join-Path $root "$kind-artifact.zip") $wrapper $true
  $distribution = @(Get-ChildItem -LiteralPath $wrapper -File)
  if ($distribution.Count -ne 1 -or $distribution[0].Extension -ne $(if ($kind -eq 'installer') { '.exe' } else { '.zip' })) { throw 'Unexpected distribution content' }
  Get-FileHash -LiteralPath $distribution[0].FullName -Algorithm SHA256 | ConvertTo-Json | Set-Content (Join-Path $output 'distribution-sha256.json')
  $logsComplete = $true
  try {
    if ($kind -eq 'installer') {
      $arguments = @('/VERYSILENT','/SUPPRESSMSGBOXES','/NORESTART','/SP-','/NOICONS','/NoAutoStart=1',"/DIR=$install","/LOG=$(Join-Path $output 'setup.log')","/DesktopInstanceRoot=$state","/FrontendPort=$($ports[0])","/ApiPort=$($ports[1])","/RedisPort=$($ports[2])")
      Wait-Success (Start-Owned $distribution[0].FullName $arguments $root $state $ports 'install') 600
    } else {
      Expand-OwnedZip $distribution[0].FullName $install $false
      # Exercise the shipped first-run entrypoint, including its real offline configuration.
      $null = Start-Owned "$env:SystemRoot\System32\cmd.exe" @('/d','/c','start.bat') $install $state $ports 'portable-first-run'
      Wait-Ready $ports[1]
    }
    $executables = @(Get-ChildItem -LiteralPath (Join-Path $install 'desktop-dist') -Filter '*.exe' -File | Where-Object { $_.VersionInfo.ProductVersion -eq $version -or $_.VersionInfo.ProductVersion -eq "$version.0" })
    if ($executables.Count -ne 1) { throw 'Expected exactly one executable with the actual candidate ProductVersion' }
    $exe = $executables[0].FullName
    $executables[0].VersionInfo | Select-Object FileName,ProductVersion,FileVersion,ProductName | ConvertTo-Json | Set-Content (Join-Path $output 'executable-version.json')
    if ($kind -eq 'portable') { Quit-Owned $exe $install $state $ports }
    $launchArgs = @("--remote-debugging-port=$($ports[3])", '--remote-debugging-address=127.0.0.1')
    foreach ($phase in @('create','restore')) {
      Assert-Free $ports
      $null = Start-Owned $exe $launchArgs $install $state $ports "app-$phase"
      Wait-Ready $ports[1]
      & $node $browser $phase $output $ports[0] $ports[1] $ports[3] $version
      if ($LASTEXITCODE -ne 0) { throw "Real renderer $phase verification failed" }
      Quit-Owned $exe $install $state $ports
    }
  } finally {
    # Includes this Setup's temporary child. Every matching executable is inside our unique root.
    $remaining = @(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($root + '\', [StringComparison]::OrdinalIgnoreCase) })
    foreach ($owned in $remaining) {
      $current = Get-CimInstance Win32_Process -Filter "ProcessId=$($owned.ProcessId)"
      if ($current -and $current.ExecutablePath -eq $owned.ExecutablePath) { Stop-Process -Id $owned.ProcessId -Force -ErrorAction SilentlyContinue }
    }
    $remaining | Select-Object ProcessId,ExecutablePath | ConvertTo-Json | Set-Content (Join-Path $output 'emergency-cleanup.json')
    if (Test-Path (Join-Path $state 'logs')) { Copy-Item (Join-Path $state 'logs') (Join-Path $output 'logs') -Recurse }
    if (Test-Path (Join-Path $install '.installer-logs')) { Copy-Item (Join-Path $install '.installer-logs') (Join-Path $output 'installer-logs') -Recurse }
    foreach ($record in $records) {
      foreach ($stream in @('stdout','stderr')) {
        $task = $record[$stream]
        try { $complete = $task.Wait(5000) } catch { $complete = $false }
        if (-not $complete -or -not $task.IsCompletedSuccessfully) { $logsComplete = $false; continue }
        $text = $task.Result
        if ($text.Length -gt 2097152) { $logsComplete = $false }
        $text.Substring(0,[Math]::Min($text.Length,2097152)) | Set-Content (Join-Path $output "$($record.phase)-$($record.process.Id)-$stream.log")
      }
    }
    @{ allStreamsCapturedWithinBudget=$logsComplete } | ConvertTo-Json | Set-Content (Join-Path $output 'log-capture.json')
    $records.Clear()
    $cleanupDeadline = [DateTime]::UtcNow.AddSeconds(5)
    do {
      $left = @(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($root + '\', [StringComparison]::OrdinalIgnoreCase) })
      if ($left.Count -eq 0) { break }
      Start-Sleep -Milliseconds 100
    } while ([DateTime]::UtcNow -lt $cleanupDeadline)
    $listeners = @()
    foreach ($port in $ports) { $listeners += @(Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue) }
    @{ distribution=$kind; attemptId=$AttemptId; ownedProcessesAbsent=($left.Count -eq 0); portsFree=($listeners.Count -eq 0) } | ConvertTo-Json | Set-Content (Join-Path $output 'cleanup-confirmed.json')
    if ($left.Count -ne 0) { throw 'Owned process cleanup was not confirmed' }
    Assert-Free $ports
  }
  if (-not $logsComplete) { throw 'Actual startup logs exceed the evidence budget; cannot certify absence of plugin errors' }
  & $node (Join-Path $PSScriptRoot 'initial-plugins.mjs') --logs $output
  if ($LASTEXITCODE -ne 0) { throw 'Actual distribution logs contain initial plugin setup failures' }
  @{ status='passed'; distribution=$kind; attemptId=$AttemptId; instanceRoot=$state; ports=$ports; normalExit=$true; actualInstallAndRestore=$true; defaultInitialPluginsReady=$true; actualStartupLogsChecked=$true; scope='fresh runner; no paid model, real account import or non-elevated installation claim' } | ConvertTo-Json -Depth 5 | Set-Content (Join-Path $output 'result.json')
}
