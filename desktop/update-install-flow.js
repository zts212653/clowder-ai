// Verified installer confirmation, launch, and startup-retry lifecycle.

const path = require('node:path');
const fs = require('node:fs');
const checker = require('./update-checker');
const dl = require('./update-downloader');
const { fetchReleases, spawnInstaller } = require('./update-installer');
const { safeErrorMessage } = require('./update-network-diagnostics');
const READY_TO_INSTALL_PRESENTATION_TIMEOUT_MS = 15_000;

class UpdateInstallFlow {
  constructor(deps, updatesDir) {
    this._d = deps;
    this._updatesDir = updatesDir;
    this._spawn = deps.spawn || require('node:child_process').spawn;
  }

  async execute(target, installerPath) {
    const isWin = this._d.platform === 'win32';
    const action = await this._confirmInstall(target, isWin);
    if (action !== 'install') return;
    if (!(await dl.verifyFileIntegrity(installerPath, target.asset.digest, target.asset.size))) {
      this._d.dbg('Installer modified after confirmation (TOCTOU) — aborting');
      return;
    }

    const logPath = isWin ? path.join(this._updatesDir, 'install.log') : '';
    this._writeJournal(target, installerPath);
    await this._launchVerifiedInstaller(target, installerPath, logPath, isWin);
  }

  async _confirmInstall(target, isWin) {
    const renderedAction = await this._confirmInRenderer(target, isWin);
    if (renderedAction) return renderedAction;
    const btn = await this._d.showDialog({
      type: 'info',
      defaultId: 0,
      cancelId: 1,
      title: 'Ready to Install',
      buttons: [isWin ? 'Restart & Upgrade' : 'Quit & Install', 'Later'],
      message: `v${target.version} ${isWin ? 'is ready' : 'downloaded'}`,
      detail: isWin
        ? 'The app will close and the installer will run.\nYour data will be preserved.'
        : 'Drag Clowder AI into Applications to replace the old version.\nYour data will not be affected.',
    });
    return btn === 0 ? 'install' : 'later';
  }

  async _confirmInRenderer(target, isWin) {
    if (!this._d.showUpdatePrompt) return null;
    try {
      return await this._d.showUpdatePrompt(
        {
          kind: 'ready-to-install',
          version: target.version,
          platform: isWin ? 'windows' : 'macos',
          assetName: target.asset.name,
        },
        { presentationTimeoutMs: READY_TO_INSTALL_PRESENTATION_TIMEOUT_MS },
      );
    } catch (error) {
      this._d.dbg(`Rendered install confirmation unavailable: ${safeErrorMessage(error)}`);
      return null;
    }
  }

  _writeJournal(target, installerPath) {
    dl.writeJournal(this._updatesDir, {
      targetVersion: target.version,
      assetId: target.asset.id,
      assetName: target.asset.name,
      digest: target.asset.digest,
      assetSize: target.asset.size,
      installerPath,
      startedAt: new Date().toISOString(),
    });
  }

  async _launchVerifiedInstaller(target, installerPath, logPath, isWin) {
    try {
      if (isWin && this._d.stopServices) await this._d.stopServices();
      if (!(await dl.verifyFileIntegrity(installerPath, target.asset.digest, target.asset.size))) {
        dl.clearJournal(this._updatesDir);
        throw new Error('Installer changed before launch');
      }
      await this.spawnInstaller(installerPath, logPath || null);
      await this._d.quitApp();
    } catch (err) {
      this._d.dbg(`Installer launch failed: ${err.message}`);
      if (this._d.startServices) await this._d.startServices().catch(() => {});
      await this.showInstallFailure(err);
    }
  }

  showInstallFailure(err) {
    return this._d.showDialog({
      type: 'error',
      buttons: ['OK'],
      title: 'Install Failed',
      message: 'Could not start the installer',
      detail: err.message,
    });
  }

  async retry(journal) {
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
      await this.showInstallFailure(new Error('Could not verify installer release metadata'));
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
      await this.spawnInstaller(installerPath, logPath);
      await this._d.quitApp();
      return 'quitting';
    } catch (err) {
      this._d.dbg(`Retry install failed: ${err.message}`);
      await this.showInstallFailure(err);
    }
  }

  spawnInstaller(installerPath, logPath) {
    return spawnInstaller(this._spawn, this._d.platform, this._d.dbg, installerPath, logPath);
  }
}

module.exports = UpdateInstallFlow;
