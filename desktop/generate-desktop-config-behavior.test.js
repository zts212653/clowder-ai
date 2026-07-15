/**
 * Behavioral tests for generate-desktop-config.ps1 — Windows only.
 *
 * These tests actually execute the PowerShell script against temporary
 * app directories and assert the generated desktop-config.json values.
 * They validate the #1107 acceptance boundary: non-empty version and
 * correct installType for both installer and portable paths.
 *
 * Skipped on non-Windows platforms (PowerShell not available).
 */
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { describe, it, beforeEach, afterEach } = require('node:test');
const os = require('node:os');

const IS_WINDOWS = os.platform() === 'win32';
const SCRIPT = path.join(__dirname, 'scripts', 'generate-desktop-config.ps1');

/**
 * Run generate-desktop-config.ps1 with given parameters.
 * Uses execFileSync to invoke powershell directly — bypasses cmd.exe
 * shell layer entirely, eliminating double-quote mangling that causes
 * PowerShell parsing errors on Windows CI (see #1112 review round 5).
 * @param {string} appDir
 * @param {{ version?: string, installType?: string }} opts
 * @returns {object} parsed desktop-config.json
 */
function runGenerator(appDir, opts = {}) {
  const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT, '-AppDir', appDir];
  if (opts.version) args.push('-Version', opts.version);
  if (opts.installType) args.push('-InstallType', opts.installType);
  execFileSync('powershell', args, { stdio: 'pipe', timeout: 15000 });
  const configPath = path.join(appDir, '.cat-cafe', 'desktop-config.json');
  const raw = fs.readFileSync(configPath, 'utf8');
  return JSON.parse(raw);
}

describe(
  '#1107: generate-desktop-config.ps1 behavioral tests',
  { skip: !IS_WINDOWS && 'PowerShell required (Windows only)' },
  () => {
    let tmpDir;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-desktop-test-'));
    });

    afterEach(() => {
      if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('installer path: explicit version + installType=installer', () => {
      const config = runGenerator(tmpDir, { version: '1.2.3', installType: 'installer' });
      assert.equal(config.version, '1.2.3', 'version must match explicit -Version param');
      assert.equal(config.installType, 'installer', 'installType must be "installer"');
      assert.ok(config.installedAt, 'installedAt must be present');
    });

    it('portable path: version from desktop/package.json + installType=portable', () => {
      // Simulate portable app directory with desktop/package.json
      const desktopDir = path.join(tmpDir, 'desktop');
      fs.mkdirSync(desktopDir, { recursive: true });
      fs.writeFileSync(path.join(desktopDir, 'package.json'), JSON.stringify({ name: 'test', version: '0.10.1' }));

      const config = runGenerator(tmpDir, { installType: 'portable' });
      assert.equal(config.version, '0.10.1', 'version must be read from desktop/package.json');
      assert.equal(config.installType, 'portable', 'installType must be "portable"');
    });

    it('fallback: version from root package.json when desktop/package.json absent', () => {
      // Only root package.json, no desktop/package.json
      fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({ name: 'root', version: '0.1.0' }));

      const config = runGenerator(tmpDir, { installType: 'portable' });
      assert.equal(config.version, '0.1.0', 'version must fall back to root package.json');
    });

    it('fallback: version is "unknown" when no package.json exists', () => {
      const config = runGenerator(tmpDir, { installType: 'portable' });
      assert.equal(config.version, 'unknown', 'version must fall back to "unknown"');
    });

    it('desktop/package.json preferred over root package.json', () => {
      // Both exist — desktop should win
      fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({ name: 'root', version: '0.1.0' }));
      const desktopDir = path.join(tmpDir, 'desktop');
      fs.mkdirSync(desktopDir, { recursive: true });
      fs.writeFileSync(path.join(desktopDir, 'package.json'), JSON.stringify({ name: 'desktop', version: '0.10.1' }));

      const config = runGenerator(tmpDir, { installType: 'installer' });
      assert.equal(config.version, '0.10.1', 'desktop/package.json version must take priority');
      assert.notEqual(config.version, '0.1.0', 'root package.json version must not be used');
    });
  },
);
