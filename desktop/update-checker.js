// F257: Desktop In-App Update — update checker (pure logic, no Electron deps)
//
// Responsibilities:
//   1. Parse & compare semver tags (vX.Y.Z format)
//   2. Select best update target from GitHub Releases API response
//   3. Extract asset four-tuple {id, name, size, digest} per platform
//   4. Persist update settings (autoCheck, skippedVersion, etc.)
//
// Design decisions (from spec):
//   - Feed: GET /repos/{owner}/{repo}/releases?per_page=10
//   - NOT /releases/latest (not a semver selector — Codex review)
//   - Asset digest comes from GitHub API response (not .sha256 sidecar)
//   - Win asset = CatCafe-Setup-{v}.exe (Inno Setup, single arch)
//   - Mac asset = CatCafe-{v}-{arm64|x64}.dmg (per process.arch)

'use strict';

const fs = require('node:fs');
const path = require('node:path');

// ── Semver parsing & comparison ────────────────────────────────────────

const VERSION_RE = /^v?(\d+)\.(\d+)\.(\d+)$/;

/**
 * Parse a version string (with or without 'v' prefix) into components.
 * @param {string} tag — e.g. 'v0.11.1' or '0.11.1'
 * @returns {{ major: number, minor: number, patch: number } | null}
 */
function parseVersion(tag) {
  if (typeof tag !== 'string') return null;
  const m = tag.match(VERSION_RE);
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
}

/**
 * Compare two version strings. Returns positive if a > b, negative if a < b, 0 if equal.
 * @param {string} a
 * @param {string} b
 * @returns {number}
 * @throws {Error} if either version is invalid
 */
function compareSemver(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa) throw new Error(`Invalid version: ${a}`);
  if (!pb) throw new Error(`Invalid version: ${b}`);
  if (pa.major !== pb.major) return pa.major - pb.major;
  if (pa.minor !== pb.minor) return pa.minor - pb.minor;
  return pa.patch - pb.patch;
}

// ── Asset name resolution ──────────────────────────────────────────────

/**
 * Strip 'v' prefix from a version string.
 * @param {string} version
 * @returns {string}
 */
function stripV(version) {
  return version.startsWith('v') ? version.slice(1) : version;
}

/**
 * Get expected asset filename for a given version/platform/arch.
 * Matches electron-builder artifactName + Inno Setup OutputBaseFilename.
 *
 * @param {string} version — e.g. 'v0.12.0' or '0.12.0'
 * @param {'win32' | 'darwin'} platform
 * @param {'arm64' | 'x64'} arch
 * @returns {string}
 */
function resolveAssetName(version, platform, arch) {
  const v = stripV(version);
  if (platform === 'win32') {
    // Inno Setup: OutputBaseFilename=CatCafe-Setup-{#MyAppVersion}
    return `CatCafe-Setup-${v}.exe`;
  }
  // electron-builder: artifactName=CatCafe-${version}-${arch}.${ext}
  return `CatCafe-${v}-${arch}.dmg`;
}

// ── Asset four-tuple extraction ────────────────────────────────────────

/**
 * Extract asset metadata from a GitHub API asset object.
 * Returns null if digest is missing or falsy (integrity cannot be verified).
 * Preserves browser_download_url for the download transport layer.
 *
 * @param {{ id: number, name: string, size: number, digest?: string, browser_download_url?: string }} apiAsset
 * @returns {{ id: number, name: string, size: number, digest: string, browser_download_url: string | null } | null}
 */
function extractAssetQuad(apiAsset) {
  if (!apiAsset || !apiAsset.digest) return null;
  return {
    id: apiAsset.id,
    name: apiAsset.name,
    size: apiAsset.size,
    digest: apiAsset.digest,
    browser_download_url: apiAsset.browser_download_url || null,
  };
}

// ── Update target selection ────────────────────────────────────────────

/**
 * Select the best update target from a GitHub Releases API response.
 *
 * Algorithm:
 *   1. Filter out draft + prerelease
 *   2. Parse & validate tag_name as semver
 *   3. Sort descending by semver
 *   4. For each candidate (highest first):
 *      a. Skip if <= currentVersion
 *      b. Skip if == skippedVersion (user chose "skip this version")
 *      c. Find the platform-specific asset by name
 *      d. Extract four-tuple; skip if digest missing
 *      e. Return first match (= highest valid)
 *   5. Return null if no valid candidate
 *
 * @param {Array} releases — GitHub API /releases response
 * @param {string} currentVersion — e.g. '0.10.1'
 * @param {'win32' | 'darwin'} platform
 * @param {'arm64' | 'x64'} arch
 * @param {{ skippedVersion?: string | null }} [options]
 * @returns {{ version: string, asset: { id, name, size, digest }, releaseNotes: string } | null}
 */
function selectUpdateTarget(releases, currentVersion, platform, arch, options) {
  const skipped = options?.skippedVersion || null;

  // Step 1-2: filter + parse
  const candidates = [];
  for (const rel of releases) {
    if (rel.draft || rel.prerelease) continue;
    const parsed = parseVersion(rel.tag_name);
    if (!parsed) continue;
    candidates.push({ release: rel, parsed, version: stripV(rel.tag_name) });
  }

  // Step 3: sort descending
  candidates.sort((a, b) => {
    if (a.parsed.major !== b.parsed.major) return b.parsed.major - a.parsed.major;
    if (a.parsed.minor !== b.parsed.minor) return b.parsed.minor - a.parsed.minor;
    return b.parsed.patch - a.parsed.patch;
  });

  // Step 4: find first valid
  for (const c of candidates) {
    // 4a: skip if not newer
    if (compareSemver(c.version, currentVersion) <= 0) continue;
    // 4b: skip if user chose to skip this version
    if (skipped && c.version === stripV(skipped)) continue;
    // 4c: find platform asset
    const expectedName = resolveAssetName(c.version, platform, arch);
    const apiAsset = c.release.assets.find((a) => a.name === expectedName);
    if (!apiAsset) continue;
    // 4d: extract quad (requires digest)
    const quad = extractAssetQuad(apiAsset);
    if (!quad) continue;
    // 4e: found!
    return {
      version: c.version,
      asset: quad,
      releaseNotes: c.release.body || '',
    };
  }

  return null;
}

// ── Settings persistence ───────────────────────────────────────────────

const DEFAULT_SETTINGS = {
  autoCheck: true,
  skippedVersion: null,
  lastCheckAt: null,
  etag: null,
};

/**
 * Load update settings from disk. Returns defaults on missing/corrupt file.
 * @param {string} settingsPath — absolute path to update-settings.json
 * @returns {{ autoCheck: boolean, skippedVersion: string|null, lastCheckAt: string|null, etag: string|null }}
 */
function loadSettings(settingsPath) {
  try {
    const raw = fs.readFileSync(settingsPath, 'utf-8');
    const parsed = JSON.parse(raw);
    return {
      autoCheck: typeof parsed.autoCheck === 'boolean' ? parsed.autoCheck : DEFAULT_SETTINGS.autoCheck,
      skippedVersion: parsed.skippedVersion ?? DEFAULT_SETTINGS.skippedVersion,
      lastCheckAt: parsed.lastCheckAt ?? DEFAULT_SETTINGS.lastCheckAt,
      etag: parsed.etag ?? DEFAULT_SETTINGS.etag,
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

/**
 * Save update settings to disk. Creates parent directory if needed.
 * @param {string} settingsPath
 * @param {{ autoCheck: boolean, skippedVersion: string|null, lastCheckAt: string|null, etag: string|null }} settings
 */
function saveSettings(settingsPath, settings) {
  const dir = path.dirname(settingsPath);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf-8');
}

module.exports = {
  parseVersion,
  compareSemver,
  resolveAssetName,
  extractAssetQuad,
  selectUpdateTarget,
  loadSettings,
  saveSettings,
};
