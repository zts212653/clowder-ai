// One-launch consent for the desktop memory-store fallback.
//
// The launcher must never decide on its own to run the API without Redis:
// storage guards treat in-memory mode as an explicit degraded choice. When the
// user picks "use temporary memory for this launch" in the startup failure
// dialog, the consent is written here and consumed exactly once by the next
// ServiceManager startup. The file is deleted on read, so the next ordinary
// launch fails closed again.
const fs = require('node:fs');
const path = require('node:path');

const CONSENT_FILE = 'startup-memory-fallback.once';

function consentPath(userDataRoot) {
  return path.join(userDataRoot, CONSENT_FILE);
}

function requestMemoryFallbackOnce(userDataRoot) {
  fs.mkdirSync(userDataRoot, { recursive: true });
  fs.writeFileSync(
    consentPath(userDataRoot),
    `${JSON.stringify({ scope: 'single-launch', requestedAt: new Date().toISOString() })}\n`,
  );
}

/** Best effort: an unreadable consent must stay invalid even if it survives. */
function neutralizeConsent(file) {
  try {
    fs.truncateSync(file, 0);
  } catch {}
}

/**
 * Returns true only when a valid one-launch consent existed AND was consumed.
 * Single use is the whole contract: when the file cannot be removed, this
 * launch must not be authorized, otherwise every later Redis failure would
 * silently inherit the same consent instead of asking again.
 */
function consumeMemoryFallbackConsent(userDataRoot) {
  const file = consentPath(userDataRoot);
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return false;
  }
  try {
    fs.rmSync(file, { force: true });
  } catch {
    neutralizeConsent(file);
    return false;
  }
  if (fs.existsSync(file)) {
    neutralizeConsent(file);
    return false;
  }
  try {
    return JSON.parse(raw)?.scope === 'single-launch';
  } catch {
    return false;
  }
}

/** Drop a consent that must never take effect (for example an isolated instance). */
function discardMemoryFallbackConsent(userDataRoot) {
  try {
    fs.rmSync(consentPath(userDataRoot), { force: true });
  } catch {}
}

module.exports = {
  requestMemoryFallbackOnce,
  consumeMemoryFallbackConsent,
  discardMemoryFallbackConsent,
  consentPath,
  CONSENT_FILE,
};
