$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted') { throw 'Upgrade verification requires a disposable runner' }
$root=[IO.Path]::GetFullPath($env:CANDIDATE_ROOT)
$parent=[IO.Path]::GetFullPath($env:RUNNER_TEMP).TrimEnd('\')
if ([IO.Path]::GetDirectoryName($root) -ne $parent -or [IO.Path]::GetFileName($root) -notmatch '^f330-candidate-[A-Za-z0-9_-]+$') { throw 'Upgrade root must be a fresh runner-owned candidate directory' }
$candidateVersion=$env:CANDIDATE_VERSION
$candidateSource=$env:CANDIDATE_SOURCE_SHA
if ($candidateVersion -notmatch '^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$' -or $candidateSource -notmatch '^[a-f0-9]{40}$') { throw 'Invalid candidate identity' }
$catalog=Get-Content -Raw -LiteralPath (Join-Path $PSScriptRoot 'nightly-cases.json')|ConvertFrom-Json
$baseline=($catalog.cases|Where-Object id -eq 'WIN-UPGRADE-STATE').baseline
$evidence=Join-Path $root 'evidence'
New-Item -ItemType Directory -Path $evidence|Out-Null
$phase='baseline'
$passed=$false
$result=@{runId=$env:GITHUB_RUN_ID;attempt=$env:GITHUB_RUN_ATTEMPT;catalogRevision=$env:GITHUB_SHA;source=$candidateSource;baselineVersion=$baseline.version;baselineSource=$baseline.source;candidateVersion=$candidateVersion}
try {
  if ([version]$candidateVersion -le [version]$baseline.version) { throw 'Candidate must be newer than the recorded release baseline' }
  $candidate=@(Get-ChildItem -LiteralPath (Join-Path $root 'upgrade-candidate-distribution') -File)
  $hash=(Get-Content -Raw -LiteralPath (Join-Path $root 'candidate-hash/installer-sha256.txt')).Trim()
  if ($hash -notmatch '^[a-f0-9]{64}$' -or $candidate.Count -ne 1 -or (Get-FileHash -LiteralPath $candidate[0].FullName).Hash.ToLowerInvariant() -ne $hash) { throw 'Candidate differs from the published installer hash' }
  $result.candidateSha256=$hash
  $release=gh api "repos/$env:GITHUB_REPOSITORY/releases/tags/$($baseline.tag)"|ConvertFrom-Json
  if ($LASTEXITCODE -ne 0) { throw 'Cannot resolve the recorded baseline release' }
  $asset=@($release.assets|Where-Object name -eq $baseline.filename)
  if ($asset.Count -ne 1 -or $asset[0].id -ne $baseline.assetId -or $asset[0].digest -ne "sha256:$($baseline.sha256)") { throw 'Baseline release identity changed' }
  gh release download $baseline.tag -R $env:GITHUB_REPOSITORY -p $baseline.filename -D (Join-Path $root 'installer-distribution')
  if ($LASTEXITCODE -ne 0) { throw 'Cannot download the recorded baseline' }
  $package=Join-Path $root "installer-distribution/$($baseline.filename)"
  if ((Get-FileHash -LiteralPath $package).Hash.ToLowerInvariant() -ne $baseline.sha256) { throw 'Released baseline bytes changed' }
  $result.baselineSha256=$baseline.sha256
  $env:CANDIDATE_DIRECT_ARTIFACTS='1'
  $env:NIGHTLY_SUITE='smoke'
  $env:CANDIDATE_VERSION=$baseline.version
  $env:CANDIDATE_SOURCE_SHA=$baseline.source
  & pwsh -NoProfile -NonInteractive -File (Join-Path $PSScriptRoot 'windows.ps1') -Distribution installer -AttemptId ([guid]::NewGuid().ToString()) -Phases create
  if ($LASTEXITCODE -ne 0) { throw 'Released baseline could not create the persistence sample' }
  $output=Join-Path $evidence 'installer'
  $expected=Get-Content -Raw -LiteralPath (Join-Path $output 'expected-state.json')|ConvertFrom-Json
  $marker=Join-Path $root 'installer-install/desktop-instance.json'
  $identityBefore=(Get-FileHash -LiteralPath $marker).Hash
  $archive=[IO.Path]::GetFullPath((Join-Path $evidence 'upgrade-baseline'))
  $output=[IO.Path]::GetFullPath($output)
  $from=[IO.Path]::GetFullPath((Join-Path $root 'installer-distribution'))
  $saved=[IO.Path]::GetFullPath((Join-Path $root 'upgrade-baseline-distribution'))
  $incoming=[IO.Path]::GetFullPath((Join-Path $root 'upgrade-candidate-distribution'))
  $owned=$root.TrimEnd('\')+'\'
  if (@($output,$archive,$from,$saved,$incoming|Where-Object {-not $_.StartsWith($owned,[StringComparison]::OrdinalIgnoreCase)}).Count) { throw 'Upgrade move leaves the owned root' }
  Move-Item -LiteralPath $output -Destination $archive
  Move-Item -LiteralPath $from -Destination $saved
  Move-Item -LiteralPath $incoming -Destination $from
  New-Item -ItemType Directory -Path $output|Out-Null
  Copy-Item -LiteralPath (Join-Path $archive 'expected-state.json') -Destination (Join-Path $output 'expected-state.json')
  $phase='candidate'
  $env:CANDIDATE_VERSION=$candidateVersion
  $env:CANDIDATE_SOURCE_SHA=$candidateSource
  & pwsh -NoProfile -NonInteractive -File (Join-Path $PSScriptRoot 'windows.ps1') -Distribution installer -AttemptId ([guid]::NewGuid().ToString()) -Phases restore
  if ($LASTEXITCODE -ne 0) { throw 'Candidate in-place install or historical state readback failed' }
  if ((Get-FileHash -LiteralPath $marker).Hash -ne $identityBefore) { throw 'Upgrade changed the installation instance marker' }
  $result.instanceMarkerPreserved=$true
  $result.preservedThreadId=$expected.thread.id
  $passed=$true
} finally {
  $result.status=if ($passed) {'passed'} elseif ($phase -eq 'baseline') {'blocked'} else {'failed'}
  $result.code=if ($passed) {$null} elseif ($phase -eq 'baseline') {'windows-upgrade-baseline-unavailable'} else {'windows-upgrade-restore'}
  $result|ConvertTo-Json -Depth 5|Set-Content -LiteralPath (Join-Path $evidence 'upgrade-result.json')
}
