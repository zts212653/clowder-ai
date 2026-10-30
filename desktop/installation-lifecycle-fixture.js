const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

function mockedInstallInspection({
  candidateName,
  candidatePath,
  unreadable = false,
  inspectOnly = true,
  delayedExit = false,
  waitAcknowledgesExit = true,
  exitState,
}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'install-enumeration-'));
  const appDir = path.join(base, 'install');
  fs.mkdirSync(appDir);
  fs.writeFileSync(path.join(appDir, 'probe.exe'), 'Only filename inventory is used; this fixture is never executed.');
  const marker = path.join(base, 'unexpected-stop');
  const waitMarker = path.join(base, 'owned-process-waited');
  const production = fs.readFileSync(path.join(__dirname, 'scripts/stop-installed-desktop.ps1'), 'utf8');
  const imageCall = '[InstallPathIdentity]::ProcessImage($candidate.Id)';
  assert.equal(production.split(imageCall).length, 2, 'replace only the native image lookup for fictitious PIDs');
  const fixtureScript = path.join(base, 'stop-with-fixture-image.ps1');
  fs.writeFileSync(fixtureScript, production.replace(imageCall, '$candidate.Path'));
  const quote = (value) => `'${value.replace(/'/g, "''")}'`;
  const exitStateSetup = {
    exited: '$global:fixtureProcess | Add-Member NoteProperty HasExited $true',
    live: '$global:fixtureProcess | Add-Member NoteProperty HasExited $false',
    unknown: "$global:fixtureProcess | Add-Member ScriptProperty HasExited { throw 'Exit state unavailable' }",
  };
  const wrapper = path.join(base, 'inspect.ps1');
  fs.writeFileSync(
    wrapper,
    [
      `$global:fixtureProcess = [pscustomobject]@{ Id = 2147483000; ProcessName = ${quote(candidateName)} }`,
      '$global:fixtureVisible = $true',
      exitStateSetup[exitState] ?? '',
      unreadable
        ? "$global:fixtureProcess | Add-Member ScriptProperty Path { throw 'Controlled protected process path' }"
        : `$global:fixtureProcess | Add-Member NoteProperty Path ${quote(delayedExit ? path.join(appDir, 'probe.exe') : (candidatePath ?? path.join(base, 'missing.exe')))}`,
      'function Get-Process { [CmdletBinding()] param([int]$Id) if ($global:fixtureVisible) { $global:fixtureProcess } }',
      'function Stop-Process { [CmdletBinding()] param([Parameter(ValueFromPipeline)]$InputObject, [switch]$Force) process {',
      `  [IO.File]::WriteAllText(${quote(marker)}, 'called')`,
      delayedExit
        ? "  if (-not [object]::ReferenceEquals(@($InputObject)[0], $global:fixtureProcess)) { throw 'Wrong stop object' }"
        : "  throw 'No process may be stopped by this fixture'",
      '} }',
      'function Wait-Process { [CmdletBinding()] param([Parameter(ValueFromPipeline)]$InputObject, [int]$Timeout) process {',
      "  if (@($InputObject).Count -ne 1 -or -not [object]::ReferenceEquals(@($InputObject)[0], $global:fixtureProcess)) { throw 'Wrong wait object' }",
      `  if ($Timeout -ne 5 -or -not (Test-Path -LiteralPath ${quote(marker)})) { throw 'Wait must follow stop and be bounded' }`,
      `  [IO.File]::WriteAllText(${quote(waitMarker)}, 'called')`,
      ...(waitAcknowledgesExit ? ['$global:fixtureVisible = $false'] : []),
      '} }',
      `& ${quote(fixtureScript)} -AppDir ${quote(appDir)} -WaitSeconds 0 ${inspectOnly ? '-InspectOnly' : ''}`,
      'exit $LASTEXITCODE',
    ].join('\r\n'),
  );
  try {
    let status = 0,
      stderr = '',
      stdout = '';
    try {
      stdout = execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', wrapper], {
        encoding: 'utf8',
        windowsHide: true,
        stdio: 'pipe',
        timeout: 15000,
      });
    } catch (error) {
      status = error.status;
      stderr = error.stderr?.toString() ?? '';
    }
    return { status, stderr, stdout, stopped: fs.existsSync(marker), waited: fs.existsSync(waitMarker) };
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
}

module.exports = { mockedInstallInspection };
