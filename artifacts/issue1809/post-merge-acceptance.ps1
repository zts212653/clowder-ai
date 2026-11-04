$ErrorActionPreference = 'Continue'
$mergeAcceptanceHead = (git rev-parse HEAD).Trim()
if ($mergeAcceptanceHead -ne '581d70bbbb3de40a27e8e95174ea4c29f9826182') { throw 'Unexpected acceptance HEAD' }
# The isolated install intentionally skipped package prepare scripts.
pnpm --filter @cat-cafe/finance build *> artifacts/issue1809/post-merge-finance-build.log
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
pnpm --filter @cat-cafe/api build *> artifacts/issue1809/post-merge-build.log
$mergeBuildExit = $LASTEXITCODE
[IO.File]::WriteAllText((Join-Path (Get-Location) 'artifacts/issue1809/post-merge-build-exit.json'), (@{ head = $mergeAcceptanceHead; exitCode = $mergeBuildExit } | ConvertTo-Json), [Text.UTF8Encoding]::new($false))
Write-Output "Merged API build: exit $mergeBuildExit"
if ($mergeBuildExit -ne 0) { Get-Content -LiteralPath artifacts/issue1809/post-merge-build.log -Tail 35; exit $mergeBuildExit }
node packages/web/scripts/sync-vendor-assets.mjs *> artifacts/issue1809/post-merge-vendor.log
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
node artifacts/issue1809/live-ui.mjs *> artifacts/issue1809/post-merge-live-run.log
$mergeLiveExit = $LASTEXITCODE
[IO.File]::WriteAllText((Join-Path (Get-Location) 'artifacts/issue1809/post-merge-live-exit.json'), (@{ head = $mergeAcceptanceHead; exitCode = $mergeLiveExit } | ConvertTo-Json), [Text.UTF8Encoding]::new($false))
Write-Output "Merged Windows live acceptance: exit $mergeLiveExit"
if ($mergeLiveExit -ne 0) { Get-Content -LiteralPath artifacts/issue1809/post-merge-live-run.log -Tail 35 }
exit $mergeLiveExit
