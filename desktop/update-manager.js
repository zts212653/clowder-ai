// F273: Desktop In-App Update — Electron main-process orchestrator
const path = require('node:path');
const fs = require('node:fs');
const checker = require('./update-checker');
const dl = require('./update-downloader');
const { fetchReleases, downloadAsset } = require('./update-installer');
const UpdateInstallFlow = require('./update-install-flow');
const { safeErrorMessage } = require('./update-network-diagnostics');

const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const MAX_RENDERED_RELEASE_NOTES_LENGTH = 32_000;
const RELEASE_NOTES_TRUNCATED_SUFFIX = '\n\n_Release notes truncated. Open the version link for the complete notes._';
const GITHUB_OWNER = 'zts212653';
const GITHUB_REPO = 'clowder-ai';
const RELEASES_URL = `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/releases`;

function releaseUrl(version) {
  if (!checker.parseVersion(version)) throw new TypeError('Invalid update version');
  return `${RELEASES_URL}/tag/v${version}`;
}

function releaseNotesForRenderer(releaseNotes) {
  if (typeof releaseNotes !== 'string') return '';
  const normalized = releaseNotes.trim();
  if (normalized.length <= MAX_RENDERED_RELEASE_NOTES_LENGTH) return normalized;
  return `${normalized.slice(0, MAX_RENDERED_RELEASE_NOTES_LENGTH - RELEASE_NOTES_TRUNCATED_SUFFIX.length)}${RELEASE_NOTES_TRUNCATED_SUFFIX}`;
}

class UpdateManager {
  /** @param {object} deps — injected Electron deps (app, net, showDialog, setProgressBar, openExternal, openPath, quitApp, stopServices, startServices, dbg, userDataRoot, platform, arch) */
  constructor(deps) {
    this._d = deps;
    this._updatesDir = dl.updatesDir(deps.userDataRoot);
    this._settingsPath = path.join(deps.userDataRoot, 'update-settings.json');
    this._installFlow = new UpdateInstallFlow(deps, this._updatesDir);
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
    if (this._intervalTimer !== null) return;
    const settings = checker.loadSettings(this._settingsPath);
    if (!settings.autoCheck) {
      this._d.dbg('Auto-check disabled');
      return;
    }
    this.checkForUpdates();
    this._intervalTimer = this._setInterval(() => this.checkForUpdates(), CHECK_INTERVAL_MS);
  }

  stopSchedule() {
    if (this._intervalTimer !== null) {
      this._clearInterval(this._intervalTimer);
      this._intervalTimer = null;
    }
  }

  getSettings() {
    const { autoCheck } = checker.loadSettings(this._settingsPath);
    return { autoCheck };
  }

  setAutoCheck(enabled) {
    if (typeof enabled !== 'boolean') throw new TypeError('autoCheck must be a boolean');
    const settings = checker.loadSettings(this._settingsPath);
    checker.saveSettings(this._settingsPath, { ...settings, autoCheck: enabled });
    if (enabled) this.startSchedule();
    else this.stopSchedule();
    return { autoCheck: enabled };
  }

  checkForUpdates(opts) {
    const run = () => this._runUpdateCheck(opts);
    this._checkQueue = this._checkQueue.then(run, run);
    return this._checkQueue;
  }

  async _runUpdateCheck(opts) {
    const manual = opts?.manual === true;
    const { dbg, platform, arch } = this._d;
    const currentVersion = this._d.app.getVersion();
    const settings = checker.loadSettings(this._settingsPath);
    dbg(`Checking for updates (current: ${currentVersion}, manual: ${manual})`);

    try {
      const metadata = await this._fetchReleaseMetadata(currentVersion, settings.etag);
      if (!metadata) {
        if (manual) await this._showCheckFailed(currentVersion);
        return;
      }

      const latestSettings = checker.loadSettings(this._settingsPath);
      const target = checker.selectUpdateTarget(metadata.releaseData, currentVersion, platform, arch, {
        skippedVersion: manual ? null : latestSettings.skippedVersion,
      });

      const refreshedSettings = {
        ...latestSettings,
        lastCheckAt: new Date().toISOString(),
        etag: metadata.etag,
      };
      checker.saveSettings(this._settingsPath, refreshedSettings);

      if (!target) {
        dbg('No update available');
        if (manual) await this._showUpToDate(currentVersion);
        return;
      }
      dbg(`Update available: v${target.version}`);
      await this._promptUpdate(target);
    } catch (err) {
      dbg(`Update check failed: ${safeErrorMessage(err)}`);
      if (manual) await this._showCheckFailed(currentVersion);
    }
  }

  async _fetchReleaseMetadata(currentVersion, etag) {
    const result = await fetchReleases(this._d.net, currentVersion, etag);
    if (!result) {
      this._d.dbg('Release fetch failed');
      return null;
    }
    if (result !== 'not-modified') {
      return { releaseData: result.data, etag: result.etag || etag };
    }

    const fresh = await fetchReleases(this._d.net, currentVersion);
    if (!fresh || fresh === 'not-modified') {
      this._d.dbg('304 metadata refresh failed');
      return null;
    }
    this._d.dbg('304 — using unconditionally refreshed release metadata');
    return { releaseData: fresh.data, etag: fresh.etag };
  }

  _showUpToDate(currentVersion) {
    return this._showCheckResult({ kind: 'up-to-date', version: currentVersion });
  }

  _showCheckFailed(currentVersion) {
    return this._showCheckResult({ kind: 'check-failed', version: currentVersion, releaseUrl: RELEASES_URL });
  }

  async _showCheckResult(prompt) {
    if (!this._d.showUpdatePrompt) {
      this._d.dbg(`Rendered ${prompt.kind} result unavailable`);
      return;
    }
    try {
      await this._d.showUpdatePrompt(prompt);
    } catch (error) {
      this._d.dbg(`Rendered ${prompt.kind} result unavailable: ${safeErrorMessage(error)}`);
    }
  }

  async _promptUpdate(target) {
    const prompt = {
      kind: 'available',
      version: target.version,
      currentVersion: this._d.app.getVersion(),
      platform: this._d.platform === 'win32' ? 'windows' : 'macos',
      assetName: target.asset.name,
      releaseUrl: releaseUrl(target.version),
      releaseNotes: releaseNotesForRenderer(target.releaseNotes),
    };
    let action;
    if (this._d.showUpdatePrompt) {
      try {
        action = await this._d.showUpdatePrompt(prompt);
      } catch (error) {
        this._d.dbg(`Rendered update prompt unavailable: ${error.message}`);
      }
    }
    if (!action) this._d.dbg(`Rendered update prompt returned no action for v${target.version}`);

    if (action === 'download') await this.downloadAndInstall(target);
    else if (action === 'skip') {
      const latestSettings = checker.loadSettings(this._settingsPath);
      checker.saveSettings(this._settingsPath, { ...latestSettings, skippedVersion: target.version });
      this._d.dbg(`Skipped v${target.version}`);
    }
  }

  /** Download, verify, then prompt install. */
  async downloadAndInstall(target) {
    if (this._downloading) return;
    const installType = dl.getInstallType(this._d.app.getAppPath(), this._d.userDataRoot);
    if (this._d.platform === 'win32' && installType !== 'installer') {
      this._d.dbg('Non-installer — opening release page (skipping download)');
      await this._openReleasePage(target.version);
      return;
    }
    this._downloading = true;
    const { dbg, setProgressBar } = this._d;
    const destPath = path.join(this._updatesDir, target.asset.name);
    const progressContext = { version: target.version, assetName: target.asset.name };
    const reportProgress = (progress) => setProgressBar(progress, progressContext);

    try {
      fs.mkdirSync(this._updatesDir, { recursive: true });
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
        reportProgress(0);
        await downloadAsset(this._d.net, target.asset, destPath, this._d.app.getVersion(), reportProgress, dbg, {
          session: this._d.netSession,
        });
        valid = await dl.verifyFileIntegrity(destPath, target.asset.digest, target.asset.size);
        if (!valid) {
          dbg('Integrity check FAILED');
          try {
            fs.unlinkSync(destPath);
          } catch {}
          reportProgress(-1);
          await this._offerDownloadRetry(target, 'Integrity verification failed', 'The file may be corrupted.');
          return;
        }
      }
      reportProgress(-1);
      await this._executeInstall(target, destPath);
    } catch (err) {
      const detail = safeErrorMessage(err);
      dbg(`Download failed: ${detail}`);
      reportProgress(-1);
      await this._offerDownloadRetry(target, 'Could not download update', detail);
    } finally {
      this._downloading = false;
    }
  }

  async _offerDownloadRetry(target, message, detail) {
    const retry = await this._d.showDialog({
      type: 'error',
      buttons: ['Retry', 'Download in Browser', 'Cancel'],
      defaultId: 0,
      cancelId: 2,
      title: 'Download Failed',
      message,
      detail: `${detail}\n\nRetry the automatic download, or download the installer in your browser and install it over the current version. Your data will be preserved.`,
    });
    if (retry === 1) {
      await this._openReleasePage(target.version);
      return;
    }
    if (retry !== 0) return;
    this._downloading = false;
    await this.downloadAndInstall(target);
  }
  async _openReleasePage(version) {
    const url = releaseUrl(version);
    try {
      await this._d.openExternal(url);
    } catch (error) {
      this._d.dbg(`Could not open update release page: ${safeErrorMessage(error)}`);
      await this._d.showDialog({
        type: 'error',
        buttons: ['OK'],
        title: 'Could Not Open Browser',
        message: 'Open the release page manually',
        detail: url,
      });
    }
  }
  async _executeInstall(target, installerPath) {
    return this._installFlow.execute(target, installerPath);
  }
  _showInstallFailure(err) {
    return this._installFlow.showInstallFailure(err);
  }
  async _retryInstall(journal) {
    return this._installFlow.retry(journal);
  }

  _spawnInstaller(installerPath, logPath) {
    return this._installFlow.spawnInstaller(installerPath, logPath);
  }
}

module.exports = UpdateManager;
