# Run in a normal PowerShell window on the Windows machine affected by #1653.
# SourceRepo is the existing source checkout; CheckoutPath is a separate test copy.
param(
    [string]$SourceRepo = (Get-Location).Path,
    [string]$CheckoutPath
)

$ErrorActionPreference = 'Stop'
$expectedHead = '2eaba4fdd1b7b89b8b74418244afd10fe810b84a'

function Invoke-Checked {
    param([string]$Command, [string[]]$CommandArgs)
    & $Command @CommandArgs
    if ($LASTEXITCODE -ne 0) {
        throw "$Command failed (exit $LASTEXITCODE); setup stopped."
    }
}

$acceptanceSourceRoot = git -C $SourceRepo rev-parse --show-toplevel
if ($LASTEXITCODE -ne 0) { throw 'SourceRepo must be an existing Clowder source checkout.' }
$acceptanceSourceRoot = [System.IO.Path]::GetFullPath($acceptanceSourceRoot.Trim())
if (-not $CheckoutPath) {
    $CheckoutPath = Join-Path (Split-Path $acceptanceSourceRoot -Parent) 'clowder-1653-acceptance'
}
$CheckoutPath = [System.IO.Path]::GetFullPath($CheckoutPath)
if ($CheckoutPath.TrimEnd('\', '/') -ieq $acceptanceSourceRoot.TrimEnd('\', '/')) {
    throw 'Acceptance checkout must differ from SourceRepo.'
}

if (-not (Test-Path -LiteralPath $CheckoutPath)) {
    Invoke-Checked -Command 'git' -CommandArgs @(
        'clone', '--single-branch', '--branch', 'fix/windows-acp-bootstrap-1653',
        'https://github.com/whutzefengxie-ops/clowder-ai.git', $CheckoutPath
    )
}
$actualHead = git -C $CheckoutPath rev-parse HEAD
if ($LASTEXITCODE -ne 0 -or $actualHead.Trim() -cne $expectedHead) {
    throw "Acceptance HEAD differs from $expectedHead; existing files were preserved."
}
if (Test-Path -LiteralPath (Join-Path $CheckoutPath '.env')) {
    throw 'Acceptance checkout has an .env file. Preserve it and check isolation before starting.'
}
if (Test-Path -LiteralPath (Join-Path $CheckoutPath 'packages/web/.env.local')) {
    throw 'Acceptance checkout has a web .env.local file. Preserve it and check isolation before starting.'
}

foreach ($acceptancePort in @(3043, 3044, 4313, 6413)) {
    if (Get-NetTCPConnection -LocalPort $acceptancePort -State Listen -ErrorAction SilentlyContinue) {
        throw "Port $acceptancePort is occupied. No process was stopped."
    }
}

# Reuse executable binaries only. The new Redis process gets a new port and data dir.
. (Join-Path $CheckoutPath 'scripts/install-windows-helpers.ps1')
$redisTools = Resolve-PortableRedisBinaries -ProjectRoot $acceptanceSourceRoot
if (-not $redisTools) { $redisTools = Resolve-GlobalRedisBinaries }
if (-not $redisTools) {
    throw 'Redis binaries were not found. Prepare an isolated Redis; do not connect this test to the existing data store.'
}
Add-ProcessPathPrefix -Directory $redisTools.BinDir

$acceptanceStateRoot = Join-Path $CheckoutPath '.tmp/acceptance1653'
New-Item -ItemType Directory -Path $acceptanceStateRoot -Force | Out-Null
$acceptanceEnvironment = @{
    FRONTEND_PORT = '3043'
    API_SERVER_PORT = '3044'
    PREVIEW_GATEWAY_PORT = '4313'
    NEXT_PUBLIC_API_URL = 'http://localhost:3044'
    REDIS_PORT = '6413'
    REDIS_URL = 'redis://127.0.0.1:6413'
    REDIS_KEY_PREFIX = 'cat-cafe:'
    WORKTREE_PORT_OFFSET = '0'
    CAT_TEMPLATE_PATH = (Join-Path $CheckoutPath 'cat-template.json')
    CAT_CAFE_DATA_DIR = (Join-Path $acceptanceStateRoot 'data')
    CAT_CAFE_GLOBAL_CONFIG_ROOT = (Join-Path $acceptanceStateRoot 'global-config')
    CAT_CAFE_CONFIG_ROOT = (Join-Path $acceptanceStateRoot 'capabilities')
    CAT_CAFE_RUNTIME_ROOT = $CheckoutPath
    CAT_CAFE_WORKSPACE_ROOT = $CheckoutPath
    CAT_CAFE_DEPLOYMENT_ID = 'acceptance1653'
    CAT_CAFE_SIDECAR_LIFECYCLE_DISABLED = '1'
    CAT_CAFE_F247_CLOUD_AUTOSTART = '0'
    CONNECTOR_GATEWAY_AUTOSTART = '0'
    EMBED_ENABLED = '0'
    EMBED_MODE = 'off'
    AUDIO_SERVICE_ENABLED = '0'
    LISTEN_MODE_DB = (Join-Path $acceptanceStateRoot 'listen-mode.sqlite')
    EVIDENCE_DB = (Join-Path $acceptanceStateRoot 'evidence.sqlite')
    GLOBAL_KNOWLEDGE_DB = (Join-Path $acceptanceStateRoot 'global-knowledge.sqlite')
    WORLD_DB = (Join-Path $acceptanceStateRoot 'world.sqlite')
    TASK_OUTCOME_DB = (Join-Path $acceptanceStateRoot 'task-outcome.sqlite')
    EVENT_MEMORY_DB = (Join-Path $acceptanceStateRoot 'event-memory.sqlite')
}
foreach ($entry in $acceptanceEnvironment.GetEnumerator()) {
    [System.Environment]::SetEnvironmentVariable($entry.Key, [string]$entry.Value, 'Process')
}

# Preserve the original TEMP/TMP and native CLI configuration to exercise the real
# failing machine conditions. Native CLI sessions/auth remain managed by those CLIs.
# Do not copy the original .env, Redis data, account store, or chat history here.
Push-Location $CheckoutPath
try {
    Write-Host "Acceptance HEAD: $actualHead"
    Write-Host "Clowder data/config: $acceptanceStateRoot"
    Write-Host "Redis data: $CheckoutPath\.cat-cafe\redis\windows\data"
    Write-Host 'Open http://localhost:3043 after startup. Keep this terminal open.'
    Write-Host 'This is a fresh Clowder instance; bind DSH/Pi in Hub if required.'
    Invoke-Checked -Command 'pnpm' -CommandArgs @('install', '--frozen-lockfile')
    Invoke-Checked -Command 'pnpm' -CommandArgs @('start:direct', '--profile=opensource')
} finally {
    Pop-Location
}
