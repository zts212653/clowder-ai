// F258: Desktop In-App Update — orchestrator (Electron main process)
//
// Lifecycle: startup check → scheduled checks → download → install
// Pure logic: update-checker.js | Journal/verify: update-downloader.js
// Install execution: update-installer.js

'use strict';

const path = require('node:path');
const fs = require('node:fs');
const checker = require('./update-checker');
const dl = require('./update-downloader');
const { fetchReleases, downloadAsset, spawnInstaller } = require('./update-installer');

const CHECK_DELAY_MS = 3 * 60 * 1000;
const GITHUB_OWNER = 'zts212653';
const GITHUB_REPO = 'clowder-ai';

class UpdateManager {
  /** @param {object} deps — injected Electron deps (app, net, showDialog, setProgressBar, openExternal, openPath, quitApp, dbg, userDataRoot, platform, arch) */
  constructor(deps) {
    this._d = deps;
    this._updatesDir = dl.updatesDir(deps.userDataRoot);
    this._settingsPath = path.join(deps.userDataRoot, 'update-settings.json');
    this._spawn = deps.spawn || require('node:child_process').spawn;
    this._checkTimer = null;
    this._downloading = false;
  }

  /** Check result of a previous upgrade attempt (called early at startup). */
  async checkPendingUpgrade() {
    const { dbg, showDialog, showNotification, openPath } = this._d;
    const currentVersion = this._d.app.getVersion();
    const result = dl.checkUpgradeResult(this._updatesDir, currentVersion);

    if (result === 'success') {
      dbg(`Upgrade to ${currentVersion} succeeded`);
      dl.clearJournal(this._updatesDir);
      this._cleanOldFiles();
      showNotification('Clowder AI Updated', `Updated to v${currentVersion}`);
      return;
    }

    if (result !== 'failed') return;

    const journal = dl.readJournal(this._updatesDir);
    dbg(`Upgrade to ${journal?.targetVersion} FAILED`);
    const btn = await showDialog({
      type: 'warning',
      buttons: ['Retry Install', 'Open Installer Location', 'View Log', 'Ignore'],
      defaultId: 0,
      cancelId: 3,
      title: 'Clowder AI — Update Failed',
      message: `Update to v${journal?.targetVersion} did not complete`,
      detail: `The update was interrupted. You can retry, or run the installer manually from:\n${this._updatesDir}\n\nThe installer is preserved — you can rerun it without opening the app.`,
    });

    if (btn === 0) await this._retryInstall(journal);
    else if (btn === 1) openPath(this._updatesDir);
    else if (btn === 2) openPath(journal?.logPath || this._updatesDir);
    else {
      dl.clearJournal(this._updatesDir);
      dbg('User cleared failed journal');
    }
  }

  /** Run a single startup update check after a short delay (3min). */
  startSchedule() {
    const settings = checker.loadSettings(this._settingsPath);
    if (!settings.autoCheck) {
      this._d.dbg('Auto-check disabled');
      return;
    }
    this._checkTimer = setTimeout(() => {
      this._checkTimer = null;
      this.checkForUpdates();
    }, CHECK_DELAY_MS);
  }

  stopSchedule() {
    if (this._checkTimer) {
      clearTimeout(this._checkTimer);
      this._checkTimer = null;
    }
  }

  /**
   * Check for updates.
   * @param {{ manual?: boolean }} opts — manual=true shows feedback when up-to-date
   */
  async checkForUpdates(opts) {
    const manual = opts?.manual === true;
    const { dbg, net, platform, arch, showNotification } = this._d;
    const currentVersion = this._d.app.getVersion();
    const settings = checker.loadSettings(this._settingsPath);
    const cachePath = path.join(this._d.userDataRoot, 'release-cache.json');
    dbg(`Checking for updates (current: ${currentVersion}, manual: ${manual})`);

    try {
      const result = await fetchReleases(net, currentVersion, settings.etag);

      let releaseData;
      let newEtag = settings.etag;

      if (result === 'not-modified') {
        // P1-4: 304 = feed unchanged, but re-evaluate cached data — user may
        // have changed their skip/later choice since the last check.
        releaseData = checker.loadCachedReleases(cachePath);
        if (!releaseData) {
          dbg('304 but no cached releases — skipping');
          if (manual) showNotification('No Updates', `Clowder AI v${currentVersion} is the latest version.`);
          return;
        }
        dbg('304 — re-evaluating cached releases');
      } else if (result) {
        releaseData = result.data;
        newEtag = result.etag || settings.etag;
        checker.saveCachedReleases(cachePath, releaseData);
      } else {
        dbg('Release fetch failed');
        if (manual) showNotification('Update Check Failed', 'Could not reach GitHub. Check your network connection.');
        return;
      }

      const target = checker.selectUpdateTarget(releaseData, currentVersion, platform, arch, {
        skippedVersion: settings.skippedVersion,
      });

      checker.saveSettings(this._settingsPath, {
        ...settings,
        lastCheckAt: new Date().toISOString(),
        etag: newEtag,
      });

      if (!target) {
        dbg('No update available');
        if (manual) showNotification('No Updates', `Clowder AI v${currentVersion} is the latest version.`);
        return;
      }
      dbg(`Update available: v${target.version}`);
      await this._promptUpdate(target, settings);
    } catch (err) {
      dbg(`Update check failed: ${err.message}`);
      if (manual) showNotification('Update Check Failed', 'Something went wrong. Check the logs for details.');
    }
  }

  async _promptUpdate(target, settings) {
    const notes = target.releaseNotes?.slice(0, 500) || '';
    const detail = `Current: v${this._d.app.getVersion()}${notes ? `\n\n${notes}` : ''}`;
    const btn = await this._d.showDialog({
      type: 'info',
      buttons: ['Download', 'Later', 'Skip This Version'],
      defaultId: 0,
      cancelId: 1,
      title: 'Update Available',
      message: `Clowder AI v${target.version} is available`,
      detail,
    });

    if (btn === 0) await this.downloadAndInstall(target);
    else if (btn === 2) {
      checker.saveSettings(this._settingsPath, { ...settings, skippedVersion: target.version });
      this._d.dbg(`Skipped v${target.version}`);
    }
  }

  /** Download, verify, then prompt install. */
  async downloadAndInstall(target) {
    if (this._downloading) return;
    // P2: check install type BEFORE downloading — don't waste 600+ MB bandwidth
    // for portable users who'll just get redirected to the release page.
    if (this._d.platform === 'win32' && this._getInstallType() !== 'installer') {
      this._d.dbg('Non-installer — opening release page (skipping download)');
      this._d.openExternal(`https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/releases/tag/v${target.version}`);
      return;
    }
    this._downloading = true;
    const { dbg, setProgressBar } = this._d;
    const destPath = path.join(this._updatesDir, target.asset.name);
    fs.mkdirSync(this._updatesDir, { recursive: true });

    try {
      await downloadAsset(this._d.net, target.asset, destPath, this._d.app.getVersion(), setProgressBar, dbg);
      const valid = await dl.verifyFileIntegrity(destPath, target.asset.digest, target.asset.size);
      if (!valid) {
        dbg('Integrity check FAILED');
        try {
          fs.unlinkSync(destPath);
        } catch {}
        setProgressBar(-1);
        const r = await this._d.showDialog({
          type: 'error',
          buttons: ['Retry', 'Cancel'],
          title: 'Download Failed',
          message: 'Integrity verification failed',
          detail: 'The file may be corrupted.',
        });
        if (r === 0) {
          // Reset guard before retry — recursive call checks _downloading
          this._downloading = false;
          await this.downloadAndInstall(target);
        }
        return;
      }
      setProgressBar(-1);
      await this._executeInstall(target, destPath);
    } catch (err) {
      dbg(`Download failed: ${err.message}`);
      setProgressBar(-1);
    } finally {
      this._downloading = false;
    }
  }

  async _executeInstall(target, installerPath) {
    const { platform, dbg, showDialog, quitApp, openExternal } = this._d;
    const isWin = platform === 'win32';

    if (isWin && this._getInstallType() !== 'installer') {
      dbg('Non-installer — opening release page');
      openExternal(`https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/releases/tag/v${target.version}`);
      return;
    }

    const msg = isWin
      ? {
          buttons: ['Restart & Upgrade', 'Later'],
          message: `v${target.version} is ready`,
          detail: 'The app will close and the installer will run.\nYour data will be preserved.',
        }
      : {
          buttons: ['Quit & Install', 'Later'],
          message: `v${target.version} downloaded`,
          detail: 'Drag Clowder AI into Applications to replace the old version.\nYour data will not be affected.',
        };
    const btn = await showDialog({ type: 'info', defaultId: 0, cancelId: 1, title: 'Ready to Install', ...msg });
    if (btn !== 0) return;

    const logPath = isWin ? path.join(this._updatesDir, 'install.log') : '';
    dl.writeJournal(this._updatesDir, {
      targetVersion: target.version,
      assetId: target.asset.id,
      assetName: target.asset.name,
      digest: target.asset.digest,
      installerPath,
      logPath,
      startedAt: new Date().toISOString(),
    });
    try {
      await this._spawnInstaller(installerPath, logPath || null);
      await quitApp();
    } catch (err) {
      dbg(`Installer launch failed: ${err.message}`);
      // Journal preserved — next startup checkPendingUpgrade() shows recovery dialog (AC-3)
      await showDialog({
        type: 'error',
        buttons: ['OK'],
        title: 'Install Failed',
        message: 'Could not start the installer',
        detail: err.message,
      });
    }
  }

  async _retryInstall(journal) {
    if (!journal?.installerPath) return;
    if (!fs.existsSync(journal.installerPath)) {
      await this._d.showDialog({
        type: 'error',
        buttons: ['OK'],
        title: 'Cannot Retry',
        message: 'Installer file not found',
        detail: `Expected: ${journal.installerPath}`,
      });
      dl.clearJournal(this._updatesDir);
      return;
    }
    const stat = fs.statSync(journal.installerPath);
    if (!(await dl.verifyFileIntegrity(journal.installerPath, journal.digest, stat.size))) {
      dl.clearJournal(this._updatesDir);
      return;
    }
    try {
      await this._spawnInstaller(journal.installerPath, journal.logPath || null);
      await this._d.quitApp();
    } catch (err) {
      this._d.dbg(`Retry install failed: ${err.message}`);
      // Journal preserved — next startup recovery dialog will offer retry again
    }
  }

  /** Delegate to update-installer.spawnInstaller (extracted for file-size compliance). */
  _spawnInstaller(installerPath, logPath) {
    return spawnInstaller(this._spawn, this._d.platform, this._d.dbg, installerPath, logPath);
  }

  _getInstallType() {
    // app.getAppPath() → {installDir}/desktop-dist/resources/app.asar
    // dirname → {installDir}/desktop-dist/resources
    // ../.. → {installDir}  (where .cat-cafe/desktop-config.json lives)
    const appPath = this._d.app.getAppPath();
    const candidates = [
      path.join(path.dirname(appPath), '..', '..', '.cat-cafe', 'desktop-config.json'),
      path.join(this._d.userDataRoot, '.cat-cafe', 'desktop-config.json'),
    ];
    for (const p of candidates) {
      try {
        const c = JSON.parse(fs.readFileSync(p, 'utf-8'));
        if (c.installType) return c.installType;
      } catch {}
    }
    return 'unknown'; // fail-safe: don't auto-install
  }

  _cleanOldFiles() {
    try {
      for (const f of fs.readdirSync(this._updatesDir)) {
        try {
          fs.unlinkSync(path.join(this._updatesDir, f));
        } catch {}
      }
    } catch {}
  }
}

module.exports = UpdateManager;
