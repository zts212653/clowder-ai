const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

// Chromium Pickle layout, verified against @electron/asar 4.3.1's disk/pickle readers.
function archiveFixture(file, kind) {
  const body = Buffer.from('// installation lifecycle');
  const entry = { size: body.length, offset: '0' };
  if (kind === 'unpacked-missing') entry.unpacked = true;
  const json = Buffer.from(JSON.stringify({ files: { 'installation-lifecycle.js': entry } }));
  const header = Buffer.alloc(8 + Math.ceil(json.length / 4) * 4);
  header.writeUInt32LE(header.length - 4, 0);
  header.writeUInt32LE(json.length, 4);
  json.copy(header, 8);
  const size = Buffer.alloc(8);
  size.writeUInt32LE(4, 0);
  size.writeUInt32LE(kind === 'oversized' ? 0x7fffffff : header.length, 4);
  fs.writeFileSync(file, kind === 'truncated' ? size : Buffer.concat([size, header, body]));
}

// Exercise the real PowerShell gate, mocking only process inventory/launch.
// No user process, registry entry or runtime data is touched by these fixtures.
for (const [layout, handler, marker, expected] of [
  ['plain', 'app', true, true],
  ['asar-unpacked', 'app.asar.unpacked', true, true],
  ['asar-packed', 'archive', true, true],
  ['asar-truncated', 'truncated', true, false],
  ['asar-oversized', 'oversized', true, false],
  ['asar-unpacked-file-missing', 'unpacked-missing', true, false],
  ['legacy', null, true, false],
  ['unidentified', 'app.asar.unpacked', false, false],
]) {
  test(`Windows shutdown admission: ${layout}`, { skip: process.platform !== 'win32' }, () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'install-shutdown-'));
    try {
      const install = path.join(base, 'install');
      const instance = path.join(base, 'instance');
      const desktop = path.join(install, 'desktop-dist');
      fs.mkdirSync(desktop, { recursive: true });
      fs.mkdirSync(instance);
      fs.writeFileSync(path.join(desktop, 'Clowder AI.exe'), 'not executed: Start-Process is mocked');
      if (handler === 'app' || handler === 'app.asar.unpacked') {
        const resource = path.join(desktop, 'resources', handler);
        fs.mkdirSync(resource, { recursive: true });
        fs.writeFileSync(path.join(resource, 'installation-lifecycle.js'), '// supported lifecycle');
      } else if (handler) {
        const resource = path.join(desktop, 'resources');
        fs.mkdirSync(resource);
        archiveFixture(path.join(resource, 'app.asar'), handler);
      }
      if (marker) fs.writeFileSync(path.join(install, 'desktop-instance.json'), '{}');
      const receipt = path.join(base, 'launch.json');
      const quote = (value) => `'${value.replaceAll("'", "''")}'`;
      const script = path.join(base, 'probe.ps1');
      fs.writeFileSync(
        script,
        `
$ErrorActionPreference = 'Stop'
function Start-Process {
  param($FilePath, $ArgumentList, $WindowStyle)
  @{ file = $FilePath; argument = $ArgumentList; style = $WindowStyle } |
    ConvertTo-Json | Set-Content -LiteralPath ${quote(receipt)} -Encoding UTF8
}
function Get-Process { @() }
& ${quote(path.join(__dirname, 'scripts/stop-installed-desktop.ps1'))} -AppDir ${quote(install)} -InstanceRoot ${quote(instance)} -WaitSeconds 0
`,
      );
      execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script], {
        timeout: 15000,
        windowsHide: true,
        stdio: 'pipe',
      });
      assert.equal(fs.existsSync(receipt), expected, 'only a known handler and isolated identity admit graceful quit');
      if (expected) {
        const launch = JSON.parse(fs.readFileSync(receipt, 'utf8').replace(/^\uFEFF/, ''));
        assert.equal(launch.file, path.join(desktop, 'Clowder AI.exe'));
        assert.equal(launch.argument, '--quit-owned-installation');
        assert.equal(launch.style, 'Hidden');
      }
    } finally {
      assert.equal(path.dirname(base), os.tmpdir());
      assert.match(path.basename(base), /^install-shutdown-/);
      fs.rmSync(base, { recursive: true, force: true });
    }
  });
}
