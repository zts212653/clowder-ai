// F273: Desktop In-App Update — install execution layer
//
// Separated from update-manager.js for file-size compliance (350 line limit).
// HTTP transport: Electron `net` module with system proxy support.
// Resume: Range + If-Range; discard partial on ETag mismatch (spec §2).
// Spawn: platform-specific installer launch (Windows UAC / macOS open).

'use strict';

const fs = require('node:fs');

const GITHUB_OWNER = 'zts212653';
const GITHUB_REPO = 'clowder-ai';
const RELEASES_URL = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases?per_page=10`;

/**
 * Fetch releases from GitHub API.
 * Returns { data, etag } on 200, 'not-modified' on 304, null on error.
 *
 * Callers MUST distinguish 304 from error. Before release metadata can
 * authorize an installer, a 304 must be followed by an unconditional fetch:
 * same-user-writable persistent cache data is never an execution authority.
 *
 * @param {object} net — Electron net module
 * @param {string} appVersion — for User-Agent
 * @param {string|null} etag — If-None-Match
 * @returns {Promise<{ data: Array, etag: string|null } | 'not-modified' | null>}
 */
function fetchReleases(net, appVersion, etag, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    let timer = null;
    let request = null;
    const settle = (val) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (request && typeof request.abort === 'function') request.abort();
      resolve(val);
    };
    try {
      request = net.request(RELEASES_URL);
      request.setHeader('Accept', 'application/vnd.github+json');
      request.setHeader('User-Agent', `ClowderAI/${appVersion}`);
      if (etag) request.setHeader('If-None-Match', etag);

      let body = '';
      request.on('response', (response) => {
        if (settled) {
          response.destroy();
          return;
        }
        if (response.statusCode === 304) {
          settle('not-modified');
          return;
        }
        if (response.statusCode !== 200) {
          settle(null);
          return;
        }
        const newEtag = response.headers.etag || null;
        response.on('data', (chunk) => {
          body += chunk.toString();
        });
        response.on('end', () => {
          try {
            settle({ data: JSON.parse(body), etag: newEtag });
          } catch {
            settle(null);
          }
        });
        response.on('error', () => settle(null));
        response.on('aborted', () => settle(null));
      });
      request.on('error', () => settle(null));
      // 30s timeout — feed fetch should be fast; prevents permanent hang
      timer = setTimeout(() => settle(null), timeoutMs || 30_000);
      request.end();
    } catch {
      settle(null);
    }
  });
}

/**
 * Download a release asset with progress and resume support.
 *
 * Resume logic (spec §2):
 *   - Save ETag from first response in {dest}.meta
 *   - On retry: send Range + If-Range
 *   - If server returns 200 (not 206): discard partial, restart
 *   - If ETag changed: discard partial, restart
 *
 * @param {object} net — Electron net module
 * @param {{ name: string, size: number, browser_download_url?: string }} asset
 * @param {string} destPath — target file path
 * @param {string} appVersion — for User-Agent
 * @param {Function} setProgressBar — (0..1 | -1)
 * @param {Function} dbg — logger
 */
function downloadAsset(net, asset, destPath, appVersion, setProgressBar, dbg, timeoutMs) {
  return new Promise((resolve, reject) => {
    const url =
      asset.browser_download_url || `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/releases/download/${asset.name}`;
    const metaPath = `${destPath}.meta`;
    let existingSize = 0;
    let savedEtag = null;

    // Check for partial download
    try {
      existingSize = fs.statSync(destPath).size;
      savedEtag = JSON.parse(fs.readFileSync(metaPath, 'utf-8')).etag;
    } catch {
      existingSize = 0;
    }
    // Discard full-sized invalid partial — prevents 416 loop when download completed
    // but integrity check failed (corrupt file at full size)
    if (existingSize > 0 && existingSize >= asset.size) {
      dbg('Full-sized invalid partial — discarding for clean download');
      try {
        fs.unlinkSync(destPath);
      } catch {}
      try {
        fs.unlinkSync(metaPath);
      } catch {}
      existingSize = 0;
      savedEtag = null;
    }

    // State tracked at Promise scope so timeout, request-error, response-error,
    // and aborted handlers all share a single settle+cleanup path.
    let settled = false;
    let dlTimeout = null;
    let activeResponse = null;
    let activeWs = null;
    const settle = (fn, val) => {
      if (settled) return;
      settled = true;
      if (dlTimeout) clearTimeout(dlTimeout);
      // Unified cleanup: cancel request, destroy response, close writer
      if (activeResponse) {
        activeResponse.destroy();
        activeResponse = null;
      }
      if (activeWs) {
        activeWs.end();
        activeWs = null;
      }
      if (typeof request.abort === 'function') request.abort();
      fn(val);
    };

    const request = net.request(url);
    request.setHeader('User-Agent', `ClowderAI/${appVersion}`);
    if (existingSize > 0 && savedEtag) {
      request.setHeader('Range', `bytes=${existingSize}-`);
      request.setHeader('If-Range', savedEtag);
    }

    request.on('response', (response) => {
      // Guard: discard late response arriving after timeout/error settled the Promise.
      // Without this, a stalled-then-recovered connection creates a write stream
      // that races with the caller's retry.
      if (settled) {
        response.destroy();
        return;
      }
      activeResponse = response;
      let isResume = response.statusCode === 206;
      if (response.statusCode !== 200 && !isResume) {
        settle(reject, new Error(`HTTP ${response.statusCode}`));
        return;
      }
      if (!isResume && existingSize > 0) {
        dbg('Resume rejected — restarting download');
        existingSize = 0;
      }
      if (isResume) {
        const cr = response.headers['content-range'];
        const m = cr?.match(/bytes (\d+)-/);
        if (!m || Number(m[1]) !== existingSize) {
          dbg(`Content-Range mismatch (expected start=${existingSize}, got "${cr}") — discarding partial`);
          try {
            fs.unlinkSync(destPath);
          } catch {}
          try {
            fs.unlinkSync(metaPath);
          } catch {}
          response.destroy();
          settle(reject, new Error(`Content-Range mismatch: expected start=${existingSize}, got "${cr}"`));
          return;
        }
      }
      const serverEtag = response.headers.etag || null;
      if (isResume && savedEtag && serverEtag && serverEtag !== savedEtag) {
        dbg(`ETag mismatch on 206 (saved="${savedEtag}", got="${serverEtag}") — discarding partial`);
        try {
          fs.unlinkSync(destPath);
        } catch {}
        try {
          fs.unlinkSync(metaPath);
        } catch {}
        response.destroy();
        settle(reject, new Error(`ETag mismatch on resume: saved="${savedEtag}", got="${serverEtag}"`));
        return;
      }
      if (serverEtag) {
        try {
          fs.writeFileSync(metaPath, JSON.stringify({ etag: serverEtag }), 'utf-8');
        } catch {}
      }

      let downloaded = existingSize;
      const ws = fs.createWriteStream(destPath, { flags: isResume ? 'a' : 'w' });
      activeWs = ws;

      ws.on('error', (err) => settle(reject, err));

      response.on('data', (chunk) => {
        if (settled) return;
        downloaded += chunk.length;
        setProgressBar(asset.size > 0 ? downloaded / asset.size : -1);
        if (!ws.write(chunk)) {
          response.pause();
          ws.once('drain', () => response.resume());
        }
      });

      response.on('end', () => {
        ws.end(() => {
          try {
            fs.unlinkSync(metaPath);
          } catch {}
          settle(resolve, undefined);
        });
      });

      response.on('error', (err) => settle(reject, err));
      response.on('aborted', () => settle(reject, new Error('Download aborted')));
    });

    // 30-minute overall timeout covers both connection and download phases.
    // Without this, a stalled connection (no response, no error) blocks forever.
    dlTimeout = setTimeout(
      () => {
        dbg('Download timeout (30 min)');
        settle(reject, new Error('Download timeout (30 minutes)'));
      },
      timeoutMs || 30 * 60 * 1000,
    );

    request.on('error', (err) => settle(reject, err));
    request.end();
  });
}

/**
 * Spawn the installer with proper elevation.
 * Resolves when the launcher confirms the process started; rejects on failure.
 *
 * Windows: spawn Inno directly; it self-elevates via PrivilegesRequired=admin.
 * macOS: Finder opens the DMG via `open`.
 *
 * @param {Function} spawn — child_process.spawn (injectable for testing)
 * @param {string} platform — 'win32' | 'darwin'
 * @param {Function} dbg — logger
 * @param {string} installerPath — path to .exe or .dmg
 * @param {string|null} logPath — Inno Setup log path (Windows only)
 */
function spawnInstaller(spawn, platform, dbg, installerPath, logPath) {
  return new Promise((resolve, reject) => {
    if (platform === 'win32') {
      const innoArgs = ['/SILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/SP-'];
      if (logPath) innoArgs.push(`/LOG=${logPath}`);
      // Keep every switch in a distinct argv slot. Inno handles UAC itself, preserving
      // the original-user token used by the post-install restart.
      const child = spawn(installerPath, innoArgs, { stdio: 'ignore' });
      child.on('error', (err) => {
        dbg(`Install spawn error: ${err.message}`);
        reject(err);
      });
      child.on('close', (code) => {
        if (code === 0) {
          resolve();
        } else {
          const msg = `Installer launch failed (exit code ${code} — UAC declined?)`;
          dbg(msg);
          reject(new Error(msg));
        }
      });
    } else {
      const child = spawn('open', [installerPath], { stdio: 'ignore' });
      child.on('error', (err) => {
        dbg(`Install spawn error: ${err.message}`);
        reject(err);
      });
      child.on('close', (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`DMG open failed (exit code ${code})`));
        }
      });
    }
  });
}

module.exports = { fetchReleases, downloadAsset, spawnInstaller };
