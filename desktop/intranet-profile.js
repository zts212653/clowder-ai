const fs = require('node:fs');
const path = require('node:path');

const KEYS = [
  'CAT_CAFE_TRUSTED_HOST_COMPATIBILITY',
  'CAT_CAFE_WINDOWS_ACP_BOOTSTRAP_MODE',
  'CAT_CAFE_ACP_BOOTSTRAP_CONFIG_AUDIT_MODE',
  'AUDIT_LOG_DIR',
];

/** This edition owns its defaults; persisted owner overrides are read-only and survive program replacement. */
function intranetApiEnvironment(userDataDir, inherited = process.env) {
  const file = path.join(userDataDir, 'intranet-host.json');
  let saved = {};
  try {
    saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!saved || typeof saved !== 'object' || Array.isArray(saved)) throw new Error('Invalid intranet Host settings');
    for (const [key, value] of Object.entries(saved)) {
      if (!KEYS.includes(key) || typeof value !== 'string') throw new Error(`Invalid intranet Host setting: ${key}`);
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const configured = Object.fromEntries(
    KEYS.filter((key) => inherited[key] !== undefined).map((key) => [key, inherited[key]]),
  );
  Object.assign(configured, saved);
  const legacy = configured.CAT_CAFE_TRUSTED_HOST_COMPATIBILITY ?? '1';
  const bootstrap = configured.CAT_CAFE_WINDOWS_ACP_BOOTSTRAP_MODE ?? (legacy === '1' ? 'trusted-host' : 'strict');
  const audit =
    configured.CAT_CAFE_ACP_BOOTSTRAP_CONFIG_AUDIT_MODE ?? (legacy === '1' ? 'warn-bootstrap-root' : 'required');
  if (!['strict', 'trusted-host'].includes(bootstrap) || !['required', 'warn-bootstrap-root'].includes(audit))
    throw new Error('Invalid intranet ACP policy in intranet-host.json or deployment environment');
  const auditDir = configured.AUDIT_LOG_DIR ?? path.join(userDataDir, 'data', 'audit-logs');
  if (!auditDir.trim()) throw new Error('AUDIT_LOG_DIR must not be empty');
  return {
    CAT_CAFE_INTRANET_EDITION: '1',
    CAT_CAFE_TRUSTED_HOST_COMPATIBILITY: legacy,
    CAT_CAFE_WINDOWS_ACP_BOOTSTRAP_MODE: bootstrap,
    CAT_CAFE_ACP_BOOTSTRAP_CONFIG_AUDIT_MODE: audit,
    AUDIT_LOG_DIR: auditDir,
  };
}
function prepareIntranetAppData(app, userDataDir, isolated) {
  if (isolated) return;
  const directory = path.join(userDataDir, 'electron');
  fs.mkdirSync(directory, { recursive: true });
  app.setPath('userData', directory);
}
module.exports = { intranetApiEnvironment, prepareIntranetAppData };
