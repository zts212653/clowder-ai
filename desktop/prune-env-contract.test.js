const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');

const helper = path.join(__dirname, 'scripts', 'invoke-with-process-env.ps1');
const buildScript = path.join(__dirname, 'scripts', 'build-desktop.ps1');

function runPowerShell(script) {
  const shell = process.env.PWSH ?? 'powershell';
  const result = spawnSync(
    shell,
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script],
    {
      encoding: 'utf8',
      timeout: 30000,
      env: { ...process.env },
    },
  );
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  return result.stdout.trim();
}

test(
  'build entry applies defaults without overriding explicit opt-outs',
  { skip: process.platform !== 'win32' },
  (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'prune-env-contract-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const harness = path.join(root, 'harness.ps1');
    fs.writeFileSync(
      harness,
      [
        `. '${helper.replaceAll("'", "''")}'`,
        '$results = [ordered]@{}',
        // Unset: default applies inside the action, then the variable disappears.
        'Remove-Item Env:CAT_CAFE_PRUNE_SWC -ErrorAction SilentlyContinue',
        "Invoke-WithProcessEnv -Defaults @{ CAT_CAFE_PRUNE_SWC = '1' } -Action { $script:seen = $env:CAT_CAFE_PRUNE_SWC }",
        '$results.unsetInside = $seen',
        '$results.unsetAfter = [bool](Test-Path Env:CAT_CAFE_PRUNE_SWC)',
        // Explicit 0: caller wins inside, and the caller value survives.
        "$env:CAT_CAFE_PRUNE_SWC = '0'",
        "Invoke-WithProcessEnv -Defaults @{ CAT_CAFE_PRUNE_SWC = '1' } -Action { $script:seen = $env:CAT_CAFE_PRUNE_SWC }",
        '$results.explicitInside = $seen',
        '$results.explicitAfter = $env:CAT_CAFE_PRUNE_SWC',
        // Throwing action still restores the caller's value.
        "try { Invoke-WithProcessEnv -Defaults @{ CAT_CAFE_PRUNE_SWC = '1' } -Action { throw 'boom' } } catch { }",
        '$results.throwAfter = $env:CAT_CAFE_PRUNE_SWC',
        // Step 6 compression level uses the same helper contract.
        "$env:RUNTIME_ARCHIVE_GZIP_LEVEL = '3'",
        "Invoke-WithProcessEnv -Defaults @{ RUNTIME_ARCHIVE_GZIP_LEVEL = '9' } -Action { $script:seen = $env:RUNTIME_ARCHIVE_GZIP_LEVEL }",
        '$results.levelInside = $seen',
        '$results.levelAfter = $env:RUNTIME_ARCHIVE_GZIP_LEVEL',
        '$results | ConvertTo-Json -Compress',
      ].join('\n'),
    );

    const observed = JSON.parse(runPowerShell(harness));
    assert.deepEqual(observed, {
      unsetInside: '1',
      unsetAfter: false,
      explicitInside: '0',
      explicitAfter: '0',
      throwAfter: '0',
      levelInside: '3',
      levelAfter: '3',
    });

    const source = fs.readFileSync(buildScript, 'utf8');
    assert.match(source, /Invoke-WithProcessEnv -Defaults @\{[\s\S]*CAT_CAFE_PRUNE_SWC = '1'/);
    assert.doesNotMatch(source, /\$env:CAT_CAFE_PRUNE_SWC = '1'/);
    assert.match(source, /Invoke-WithProcessEnv -Defaults @\{ RUNTIME_ARCHIVE_GZIP_LEVEL = '9' \}/);
  },
);
