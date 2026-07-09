// F258: Desktop In-App Update — HTTP transport layer
//
// Separated from update-manager.js for file-size compliance (350 line limit).
// Uses Electron's `net` module for system proxy support.
// Resume: Range + If-Range; discard partial on ETag mismatch (spec §2).

'use strict';

const fs = require('node:fs');

const GITHUB_OWNER = 'zts212653';
const GITHUB_REPO = 'clowder-ai';
const RELEASES_URL = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases?per_page=10`;

/**
 * Fetch releases from GitHub API. Returns null on 304 / error.
 * @param {object} net — Electron net module
 * @param {string} appVersion — for User-Agent
 * @param {string|null} etag — If-None-Match
 * @returns {Promise<{ data: Array, etag: string|null } | null>}
 */
function fetchReleases(net, appVersion, etag) {
  return new Promise((resolve) => {
    try {
      const request = net.request(RELEASES_URL);
      request.setHeader('Accept', 'application/vnd.github+json');
      request.setHeader('User-Agent', `ClowderAI/${appVersion}`);
      if (etag) request.setHeader('If-None-Match', etag);

      let body = '';
      request.on('response', (response) => {
        if (response.statusCode === 304) {
          resolve(null);
          return;
        }
        if (response.statusCode !== 200) {
          resolve(null);
          return;
        }
        const newEtag = response.headers.etag || null;
        response.on('data', (chunk) => {
          body += chunk.toString();
        });
        response.on('end', () => {
          try {
            resolve({ data: JSON.parse(body), etag: newEtag });
          } catch {
            resolve(null);
          }
        });
      });
      request.on('error', () => resolve(null));
      request.end();
    } catch {
      resolve(null);
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
function downloadAsset(net, asset, destPath, appVersion, setProgressBar, dbg) {
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

    const request = net.request(url);
    request.setHeader('User-Agent', `ClowderAI/${appVersion}`);
    if (existingSize > 0 && savedEtag) {
      request.setHeader('Range', `bytes=${existingSize}-`);
      request.setHeader('If-Range', savedEtag);
    }

    request.on('response', (response) => {
      let isResume = response.statusCode === 206;
      if (response.statusCode !== 200 && !isResume) {
        reject(new Error(`HTTP ${response.statusCode}`));
        return;
      }
      // 200 with existing partial = server doesn't support resume or ETag changed
      if (!isResume && existingSize > 0) {
        dbg('Resume rejected — restarting download');
        existingSize = 0;
      }
      // Validate Content-Range on 206: server must resume from our byte offset.
      // Mismatch → discard partial + meta so next attempt starts clean (spec §2).
      // We must NOT consume the truncated 206 body — it's only a suffix.
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
          reject(new Error(`Content-Range mismatch: expected start=${existingSize}, got "${cr}"`));
          return;
        }
      }

      // Validate ETag consistency on 206 resume (spec §2 / AC-4).
      // If the server returns a different ETag, the resource changed — the
      // existing partial is stale and appending would produce a mixed file.
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
        reject(new Error(`ETag mismatch on resume: saved="${savedEtag}", got="${serverEtag}"`));
        return;
      }
      if (serverEtag) {
        try {
          fs.writeFileSync(metaPath, JSON.stringify({ etag: serverEtag }), 'utf-8');
        } catch {}
      }

      let downloaded = existingSize;
      const ws = fs.createWriteStream(destPath, { flags: isResume ? 'a' : 'w' });

      response.on('data', (chunk) => {
        ws.write(chunk);
        downloaded += chunk.length;
        setProgressBar(asset.size > 0 ? downloaded / asset.size : -1);
      });

      response.on('end', () => {
        ws.end(() => {
          try {
            fs.unlinkSync(metaPath);
          } catch {}
          resolve();
        });
      });

      response.on('error', (err) => {
        ws.end();
        reject(err);
      });
    });

    request.on('error', reject);
    request.end();
  });
}

module.exports = { fetchReleases, downloadAsset };
