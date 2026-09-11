/**
 * Unit tests for desktop/desktop-instance.js.
 *
 * The instance id is the root of trust for Redis ownership, so the record must
 * survive restarts unchanged and must never silently keep a broken value.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { afterEach, describe, it } = require('node:test');

const {
  INSTANCE_FILE_NAME,
  instanceFilePath,
  isValidInstanceRecord,
  loadOrCreateInstance,
  saveInstance,
} = require('./desktop-instance');

const tmpDirs = [];

function makeUserDataDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-instance-'));
  tmpDirs.push(dir);
  return dir;
}

const fixedDeps = { randomUUID: () => 'generated-id', now: () => '2026-09-10T00:00:00.000Z' };

describe('desktop-instance: path', () => {
  it('places the record under <userDataDir>/data', () => {
    const filePath = instanceFilePath('/tmp/Clowder AI');
    assert.equal(path.basename(filePath), INSTANCE_FILE_NAME);
    assert.equal(path.basename(path.dirname(filePath)), 'data');
  });
});

describe('desktop-instance: record validation', () => {
  it('requires a non-empty string instance id', () => {
    assert.equal(isValidInstanceRecord({ instanceId: 'abc' }), true);
    assert.equal(isValidInstanceRecord({ instanceId: '' }), false);
    assert.equal(isValidInstanceRecord({ instanceId: '   ' }), false);
    assert.equal(isValidInstanceRecord({ instanceId: 42 }), false);
    assert.equal(isValidInstanceRecord({}), false);
    assert.equal(isValidInstanceRecord(null), false);
  });
});

describe('desktop-instance: load or create', () => {
  afterEach(() => {
    while (tmpDirs.length > 0) fs.rmSync(tmpDirs.pop(), { recursive: true, force: true });
  });

  it('creates a fresh record on first run', () => {
    const filePath = instanceFilePath(makeUserDataDir());
    const { record, created, replacedCorrupt } = loadOrCreateInstance({
      filePath,
      appVersion: '0.10.1',
      deps: fixedDeps,
    });

    assert.equal(created, true);
    assert.equal(replacedCorrupt, false);
    assert.equal(record.instanceId, 'generated-id');
    assert.equal(record.appVersion, '0.10.1');
    assert.equal(record.redisPort, null);
  });

  it('returns the SAME instance id on later runs', () => {
    const filePath = instanceFilePath(makeUserDataDir());
    const first = loadOrCreateInstance({ filePath, appVersion: '0.10.1', deps: fixedDeps });
    saveInstance({ filePath, record: first.record });

    const second = loadOrCreateInstance({
      filePath,
      appVersion: '0.11.0',
      deps: { randomUUID: () => 'should-not-be-used', now: fixedDeps.now },
    });

    assert.equal(second.created, false);
    assert.equal(second.record.instanceId, 'generated-id');
    // The stored record wins; a newer app version is not merged into it.
    assert.equal(second.record.appVersion, '0.10.1');
  });

  it('remembers the Redis port so a crashed run is re-adopted', () => {
    const filePath = instanceFilePath(makeUserDataDir());
    const { record } = loadOrCreateInstance({ filePath, deps: fixedDeps });
    saveInstance({ filePath, record: { ...record, redisPort: 53111 } });

    const reloaded = loadOrCreateInstance({ filePath, deps: fixedDeps });
    assert.equal(reloaded.record.redisPort, 53111);
  });

  it('replaces a corrupt record instead of trusting it', () => {
    const filePath = instanceFilePath(makeUserDataDir());
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, '{ this is not json', 'utf8');

    const { record, created, replacedCorrupt } = loadOrCreateInstance({ filePath, deps: fixedDeps });

    assert.equal(created, true);
    assert.equal(replacedCorrupt, true);
    assert.equal(record.instanceId, 'generated-id');
  });

  it('replaces a record whose instance id is unusable', () => {
    const filePath = instanceFilePath(makeUserDataDir());
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify({ instanceId: '   ' }), 'utf8');

    const { record, created, replacedCorrupt } = loadOrCreateInstance({ filePath, deps: fixedDeps });

    assert.equal(created, true);
    assert.equal(replacedCorrupt, true);
    assert.equal(record.instanceId, 'generated-id');
  });
});

describe('desktop-instance: save', () => {
  afterEach(() => {
    while (tmpDirs.length > 0) fs.rmSync(tmpDirs.pop(), { recursive: true, force: true });
  });

  it('creates parent directories and writes parseable JSON', () => {
    const filePath = instanceFilePath(makeUserDataDir());
    assert.equal(fs.existsSync(path.dirname(filePath)), false);

    saveInstance({ filePath, record: { instanceId: 'abc', redisPort: 6399 } });

    assert.equal(JSON.parse(fs.readFileSync(filePath, 'utf8')).instanceId, 'abc');
  });
});
