// Persisted desktop instance identity.
//
// The instance id is what makes Redis ownership provable: this app writes it as
// the marker value into the Redis it starts, and only adopts a Redis whose
// marker matches. It also remembers the Redis port the instance last used, so a
// crashed run (Redis still alive on a non-default port) is re-adopted instead of
// spawning a second Redis against the same data directory.
//
// fs / randomUUID / clock are injectable so the whole module is unit-tested
// without touching a real user data directory.

const crypto = require('node:crypto');
const fsDefault = require('node:fs');
const path = require('node:path');

const INSTANCE_FILE_NAME = 'desktop-instance.json';

/** Absolute path of the instance record inside a user data directory. */
function instanceFilePath(userDataDir) {
  return path.join(userDataDir, 'data', INSTANCE_FILE_NAME);
}

/** A usable record needs a non-empty instance id. */
function isValidInstanceRecord(record) {
  return (
    Boolean(record) &&
    typeof record === 'object' &&
    typeof record.instanceId === 'string' &&
    record.instanceId.trim().length > 0
  );
}

/**
 * Load the persisted instance record, creating a fresh one when it is missing
 * or corrupt. A corrupt record is replaced rather than repaired: a wrong id
 * would make ownership checks silently fail and orphan the existing database.
 *
 * @returns {{ record: object, created: boolean, replacedCorrupt: boolean }}
 */
function loadOrCreateInstance({ filePath, appVersion = null, deps = {} }) {
  const fs = deps.fs || fsDefault;
  const randomUUID = deps.randomUUID || crypto.randomUUID;
  const now = deps.now || (() => new Date().toISOString());

  let replacedCorrupt = false;
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (isValidInstanceRecord(parsed)) {
      return { record: parsed, created: false, replacedCorrupt: false };
    }
    replacedCorrupt = true;
  } catch (error) {
    // ENOENT means "first run"; anything else means the file is unusable.
    replacedCorrupt = Boolean(error) && error.code !== 'ENOENT';
  }

  const record = {
    instanceId: randomUUID(),
    redisPort: null,
    appVersion,
    createdAt: now(),
  };
  return { record, created: true, replacedCorrupt };
}

/** Persist the instance record, creating parent directories as needed. */
function saveInstance({ filePath, record, deps = {} }) {
  const fs = deps.fs || fsDefault;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
}

module.exports = {
  INSTANCE_FILE_NAME,
  instanceFilePath,
  isValidInstanceRecord,
  loadOrCreateInstance,
  saveInstance,
};
