// F273: Desktop In-App Update — Electron main-process orchestrator
const path = require('node:path');
const fs = require('node:fs');
const checker = require('./update-checker');
const dl = require('./update-downloader');
const { fetchReleases, downloadAsset, spawnInstaller } = require('./update-installer');

const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const GITHUB_OWNER = 'zts212653';
const GITHUB_REPO = 'clowder-ai';

class UpdateManager {
  /** @param {object} deps — injected Electron deps (app, net, showDialog, setProgressBar, openExternal, openPath, quitApp, stopServices, startServices, dbg, userDataRoot, platform, arch) */
  constructor(deps) {
    this._d = deps;
    this._updatesDir = dl.updatesDir(deps.userDataRoot);
    this._settingsPath = path.join(deps.userDataRoot, 'update-settings.json');
    this._spawn = deps.spawn || require('node:child_process').spawn;
    this._setInterval = deps.setInterval || setInterval;
    this._clearInterval = deps.clearInterval || clearInterval;
    this._intervalTimer = null;
    this._checkQueue = Promise.resolve();
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
      dl.cleanUpdatesDir(this._updatesDir);
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

    if (btn === 0) {
      const r = await this._retryInstall(journal);
      if (r === 'quitting') return 'quitting';
    } else if (btn === 1) openPath(this._updatesDir);
    else if (btn === 2)
      openPath(this._d.platform === 'win32' ? path.join(this._updatesDir, 'install.log') : this._updatesDir);
    else {
      dl.clearJournal(this._updatesDir);
      dbg('User cleared failed journal');
    }
  }

  /** Check once at startup, then once daily while the app remains running. */
  startSchedule() {
    const settings = checker.loadSettings(this._settingsPath);
    if (!settings.autoCheck) {
      this._d.dbg('Auto-check disabled');
      return;
    }
    this.checkForUpdates();
    this._intervalTimer = this._setInterval(() => this.checkForUpdates(), CHECK_INTERVAL_MS);
  }

  stopSchedule() {
    if (this._intervalTimer) {
      this._clearInterval(this._intervalTimer);
      this._intervalTimer = null;
    }
  }

  checkForUpdates(opts) {
    const run = () => this._runUpdateCheck(opts);
    this._checkQueue = this._checkQueue.then(run, run);
    return this._checkQueue;
  }

  async _runUpdateCheck(opts) {
    const manual = opts?.manual === true;
    const { dbg, net, platform, arch, showDialog } = this._d;
    const currentVersion = this._d.app.getVersion();
    const settings = checker.loadSettings(this._settingsPath);
    dbg(`Checking for updates (current: ${currentVersion}, manual: ${manual})`);

    try {
      const result = await fetchReleases(net, currentVersion, settings.etag);

      let releaseData;
      let newEtag = settings.etag;

      if (result === 'not-modified') {
        const fresh = await fetchReleases(net, currentVersion);
        if (!fresh || fresh === 'not-modified') {
          dbg('304 metadata refresh failed');
          return;
        }
        releaseData = fresh.data;
        newEtag = fresh.etag;
        dbg('304 — using unconditionally refreshed release metadata');
      } else if (result) {
        releaseData = result.data;
        newEtag = result.etag || settings.etag;
      } else {
        dbg('Release fetch failed');
        if (manual)
          await showDialog({
            type: 'warning',
            buttons: ['OK'],
            title: 'Update Check Failed',
            message: 'Could not check for updates',
            detail: 'Could not reach GitHub. Please check your network connection and try again.',
          });
        return;
      }

      const target = checker.selectUpdateTarget(releaseData, currentVersion, platform, arch, {
        skippedVersion: settings.skippedVersion,
      });

      const refreshedSettings = {
        ...settings,
        lastCheckAt: new Date().toISOString(),
        etag: newEtag,
      };
      checker.saveSettings(this._settingsPath, refreshedSettings);

      if (!target) {
        dbg('No update available');
        if (manual) await this._showUpToDate(currentVersion);
        return;
      }
      dbg(`Update available: v${target.version}`);
      await this._promptUpdate(target, refreshedSettings);
    } catch (err) {
      dbg(`Update check failed: ${err.message}`);
      if (manual)
        await this._d.showDialog({
          type: 'warning',
          buttons: ['OK'],
          title: 'Update Check Failed',
          message: 'Something went wrong',
          detail: 'Check the logs for details.',
        });
    }
  }

  async _showUpToDate(currentVersion) {
    await this._d.showDialog({
      type: 'info',
      buttons: ['OK'],
      title: 'No Updates Available',
      message: `Clowder AI v${currentVersion} is up to date`,
      detail: 'You are running the latest version.',
    });
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
    const installType = dl.getInstallType(this._d.app.getAppPath(), this._d.userDataRoot);
    if (this._d.platform === 'win32' && installType !== 'installer') {
      this._d.dbg('Non-installer — opening release page (skipping download)');
      this._d.openExternal(`https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/releases/tag/v${target.version}`);
      return;
    }
    this._downloading = true;
    const { dbg, setProgressBar } = this._d;
    const destPath = path.join(this._updatesDir, target.asset.name);
    fs.mkdirSync(this._updatesDir, { recursive: true });

    try {
      let valid = await dl.verifyFileIntegrity(destPath, target.asset.digest, target.asset.size);
      if (valid) {
        dbg('Reusing previously verified download');
      } else {
        if (!dl.checkDiskSpace(this._updatesDir, target.asset.size)) {
          dbg('Insufficient disk space');
          await this._d.showDialog({
            type: 'warning',
            buttons: ['OK'],
            title: 'Not Enough Space',
            message: 'Insufficient disk space to download the update',
          });
          return;
        }
        await downloadAsset(this._d.net, target.asset, destPath, this._d.app.getVersion(), setProgressBar, dbg);
        valid = await dl.verifyFileIntegrity(destPath, target.asset.digest, target.asset.size);
        if (!valid) {
          dbg('Integrity check FAILED');
          try {
            fs.unlinkSync(destPath);
          } catch {}
          setProgressBar(-1);
          await this._offerDownloadRetry(target, 'Integrity verification failed', 'The file may be corrupted.');
          return;
        }
      }
      setProgressBar(-1);
      await this._executeInstall(target, destPath);
    } catch (err) {
      dbg(`Download failed: ${err.message}`);
      setProgressBar(-1);
      await this._offerDownloadRetry(target, 'Could not download update', err.message);
    } finally {
      this._downloading = false;
    }
  }

  async _offerDownloadRetry(target, message, detail) {
    const retry = await this._d.showDialog({
      type: 'error',
      buttons: ['Retry', 'Cancel'],
      title: 'Download Failed',
      message,
      detail,
    });
    if (retry !== 0) return;
    this._downloading = false;
    await this.downloadAndInstall(target);
  }
  async _executeInstall(target, installerPath) {
    const { platform, dbg, showDialog, quitApp } = this._d;
    const isWin = platform === 'win32';
    const msg = {
      buttons: [isWin ? 'Restart & Upgrade' : 'Quit & Install', 'Later'],
      message: `v${target.version} ${isWin ? 'is ready' : 'downloaded'}`,
      detail: isWin
        ? 'The app will close and the installer will run.\nYour data will be preserved.'
        : 'Drag Clowder AI into Applications to replace the old version.\nYour data will not be affected.',
    };
    const btn = await showDialog({ type: 'info', defaultId: 0, cancelId: 1, title: 'Ready to Install', ...msg });
    if (btn !== 0) return;
    if (!(await dl.verifyFileIntegrity(installerPath, target.asset.digest, target.asset.size))) {
      dbg('Installer modified after confirmation (TOCTOU) — aborting');
      return;
    }

    const logPath = isWin ? path.join(this._updatesDir, 'install.log') : '';
    dl.writeJournal(this._updatesDir, {
      targetVersion: target.version,
      assetId: target.asset.id,
      assetName: target.asset.name,
      digest: target.asset.digest,
      assetSize: target.asset.size,
      installerPath,
      startedAt: new Date().toISOString(),
    });
    try {
      if (isWin && this._d.stopServices) await this._d.stopServices();
      if (!(await dl.verifyFileIntegrity(installerPath, target.asset.digest, target.asset.size))) {
        dl.clearJournal(this._updatesDir);
        throw new Error('Installer changed before launch');
      }
      await this._spawnInstaller(installerPath, logPath || null);
      await quitApp();
    } catch (err) {
      dbg(`Installer launch failed: ${err.message}`);
      // Restore services so the UI isn't left running with no backend (UAC declined / spawn error)
      if (this._d.startServices) await this._d.startServices().catch(() => {});
      await this._showInstallFailure(err);
    }
  }
  _showInstallFailure(err) {
    return this._d.showDialog({
      type: 'error',
      buttons: ['OK'],
      title: 'Install Failed',
      message: 'Could not start the installer',
      detail: err.message,
    });
  }
  async _retryInstall(journal) {
    if (!journal?.targetVersion) return;
    const releases = await fetchReleases(this._d.net, this._d.app.getVersion());
    const target = checker.selectUpdateTarget(
      releases?.data ?? [],
      this._d.app.getVersion(),
      this._d.platform,
      this._d.arch,
      { requiredVersion: journal.targetVersion },
    );
    if (!target) {
      this._d.dbg('Retry install metadata could not be authenticated');
      await this._showInstallFailure(new Error('Could not verify installer release metadata'));
      return;
    }
    const installerPath = path.join(this._updatesDir, target.asset.name);
    if (!fs.existsSync(installerPath)) {
      await this._d.showDialog({
        type: 'error',
        buttons: ['OK'],
        title: 'Cannot Retry',
        message: 'Installer file not found',
        detail: `Expected: ${installerPath}`,
      });
      dl.clearJournal(this._updatesDir);
      return;
    }
    if (!(await dl.verifyFileIntegrity(installerPath, target.asset.digest, target.asset.size))) {
      dl.clearJournal(this._updatesDir);
      return;
    }
    try {
      const logPath = this._d.platform === 'win32' ? path.join(this._updatesDir, 'install.log') : null;
      await this._spawnInstaller(installerPath, logPath);
      await this._d.quitApp();
      return 'quitting';
    } catch (err) {
      this._d.dbg(`Retry install failed: ${err.message}`);
      await this._showInstallFailure(err);
    }
  }

  _spawnInstaller(installerPath, logPath) {
    return spawnInstaller(this._spawn, this._d.platform, this._d.dbg, installerPath, logPath);
  }
}

module.exports = UpdateManager;
