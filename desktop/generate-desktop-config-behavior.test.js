/**
 * Behavioral tests for generate-desktop-config.ps1 — Windows only.
 *
 * These tests execute the production PowerShell script against temporary app
 * directories and assert the generated desktop-config.json contract absorbed
 * from clowder-ai#1107.
 */
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { afterEach, beforeEach, describe, it } = require('node:test');

const IS_WINDOWS = os.platform() === 'win32';
const SCRIPT = path.join(__dirname, 'scripts', 'generate-desktop-config.ps1');
// GitHub-hosted Windows runners can spend more than 15s cold-starting the
// first Windows PowerShell 5.1 process (Defender/profile initialization). Keep
// a finite guard, but leave enough headroom for that one-time startup cost.
const POWERSHELL_TIMEOUT_MS = 60_000;

function runGenerator(appDir, opts = {}) {
  const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT, '-AppDir', appDir];
  if (opts.version) args.push('-Version', opts.version);
  if (opts.installType) args.push('-InstallType', opts.installType);
  execFileSync('powershell', args, { stdio: 'pipe', timeout: POWERSHELL_TIMEOUT_MS });
  const configPath = path.join(appDir, '.cat-cafe', 'desktop-config.json');
  return JSON.parse(fs.readFileSync(configPath, 'utf8'));
}

describe(
  'clowder-ai#1107: generate-desktop-config.ps1 behavior',
  { skip: !IS_WINDOWS && 'PowerShell required (Windows only)' },
  () => {
    let tmpDir;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-desktop-test-'));
    });

    afterEach(() => {
      if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('records explicit installer metadata', () => {
      const config = runGenerator(tmpDir, { version: '1.2.3', installType: 'installer' });
      assert.equal(config.version, '1.2.3');
      assert.equal(config.installType, 'installer');
      assert.ok(config.installedAt);
    });

    it('resolves portable version from desktop/package.json', () => {
      const desktopDir = path.join(tmpDir, 'desktop');
      fs.mkdirSync(desktopDir, { recursive: true });
      fs.writeFileSync(path.join(desktopDir, 'package.json'), JSON.stringify({ version: '0.10.1' }));

      const config = runGenerator(tmpDir, { installType: 'portable' });
      assert.equal(config.version, '0.10.1');
      assert.equal(config.installType, 'portable');
    });

    it('falls back to root package.json', () => {
      fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({ version: '0.1.0' }));
      assert.equal(runGenerator(tmpDir, { installType: 'portable' }).version, '0.1.0');
    });

    it('falls back to unknown without a package.json', () => {
      assert.equal(runGenerator(tmpDir, { installType: 'portable' }).version, 'unknown');
    });

    it('prefers desktop/package.json over root package.json', () => {
      fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({ version: '0.1.0' }));
      const desktopDir = path.join(tmpDir, 'desktop');
      fs.mkdirSync(desktopDir, { recursive: true });
      fs.writeFileSync(path.join(desktopDir, 'package.json'), JSON.stringify({ version: '0.10.1' }));

      assert.equal(runGenerator(tmpDir, { installType: 'installer' }).version, '0.10.1');
    });
  },
);
