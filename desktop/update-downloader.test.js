// F273 Phase B — update-downloader unit tests (TDD)
// Tests: download state machine, journal persistence, digest verification,
//        resume logic, disk space check, cleanup.
// Note: actual HTTP is NOT tested here — net.request is injected/mocked.
//       Integration tests go in Phase E.

const assert = require('node:assert/strict');
const { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, mkdirSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { describe, test, beforeEach, afterEach } = require('node:test');

const {
  JOURNAL_FILENAME,
  readJournal,
  writeJournal,
  clearJournal,
  checkUpgradeResult,
  verifyFileIntegrity,
  updatesDir,
} = require('./update-downloader');

// ── Journal persistence ────────────────────────────────────────────────

describe('journal persistence', () => {
  let tempDir;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(tmpdir(), 'update-journal-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test('writeJournal creates file with all required fields', () => {
    const journalPath = path.join(tempDir, JOURNAL_FILENAME);
    const data = {
      targetVersion: '0.12.0',
      assetId: 201,
      assetName: 'ClowderAI-Setup-0.12.0.exe',
      digest: 'sha256:aaa111',
      installerPath: path.join(tempDir, 'ClowderAI-Setup-0.12.0.exe'),
      logPath: path.join(tempDir, 'install.log'),
      startedAt: '2026-07-07T08:00:00.000Z',
    };
    writeJournal(tempDir, data);
    assert.ok(existsSync(journalPath));
    const persisted = JSON.parse(readFileSync(journalPath, 'utf-8'));
    assert.equal(persisted.targetVersion, '0.12.0');
    assert.equal(persisted.assetId, 201);
    assert.equal(persisted.digest, 'sha256:aaa111');
  });

  test('readJournal returns data when file exists', () => {
    writeJournal(tempDir, {
      targetVersion: '0.12.0',
      assetId: 201,
      assetName: 'ClowderAI-Setup-0.12.0.exe',
      digest: 'sha256:aaa111',
      installerPath: '/fake/path.exe',
      logPath: '/fake/log',
      startedAt: '2026-07-07T08:00:00.000Z',
    });
    const j = readJournal(tempDir);
    assert.notEqual(j, null);
    assert.equal(j.targetVersion, '0.12.0');
  });

  test('readJournal returns null when no journal', () => {
    assert.equal(readJournal(tempDir), null);
  });

  test('readJournal returns null on corrupted JSON', () => {
    const journalPath = path.join(tempDir, JOURNAL_FILENAME);
    writeFileSync(journalPath, '{corrupted!!!');
    assert.equal(readJournal(tempDir), null);
  });

  test('clearJournal removes the file', () => {
    writeJournal(tempDir, {
      targetVersion: '0.12.0',
      assetId: 201,
      assetName: 'test.exe',
      digest: 'sha256:abc',
      installerPath: '/fake',
      logPath: '/fake',
      startedAt: '2026-07-07T08:00:00.000Z',
    });
    assert.ok(existsSync(path.join(tempDir, JOURNAL_FILENAME)));
    clearJournal(tempDir);
    assert.ok(!existsSync(path.join(tempDir, JOURNAL_FILENAME)));
  });

  test('clearJournal is safe when no journal exists', () => {
    // Should not throw
    clearJournal(tempDir);
  });

  test('writeJournal creates updates directory if missing', () => {
    const nested = path.join(tempDir, 'sub', 'updates');
    writeJournal(nested, {
      targetVersion: '0.12.0',
      assetId: 201,
      assetName: 'test.exe',
      digest: 'sha256:abc',
      installerPath: '/fake',
      logPath: '/fake',
      startedAt: '2026-07-07T08:00:00.000Z',
    });
    assert.ok(existsSync(path.join(nested, JOURNAL_FILENAME)));
  });
});

// ── checkUpgradeResult ─────────────────────────────────────────────────

describe('checkUpgradeResult', () => {
  let tempDir;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(tmpdir(), 'upgrade-result-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test('returns "none" when no journal exists', () => {
    assert.equal(checkUpgradeResult(tempDir, '0.11.1'), 'none');
  });

  test('returns "success" when current >= target', () => {
    writeJournal(tempDir, {
      targetVersion: '0.12.0',
      assetId: 201,
      assetName: 'test.exe',
      digest: 'sha256:abc',
      installerPath: '/fake',
      logPath: '/fake',
      startedAt: '2026-07-07T08:00:00.000Z',
    });
    assert.equal(checkUpgradeResult(tempDir, '0.12.0'), 'success');
  });

  test('returns "success" when current > target', () => {
    writeJournal(tempDir, {
      targetVersion: '0.12.0',
      assetId: 201,
      assetName: 'test.exe',
      digest: 'sha256:abc',
      installerPath: '/fake',
      logPath: '/fake',
      startedAt: '2026-07-07T08:00:00.000Z',
    });
    assert.equal(checkUpgradeResult(tempDir, '0.13.0'), 'success');
  });

  test('returns "failed" when current < target', () => {
    writeJournal(tempDir, {
      targetVersion: '0.12.0',
      assetId: 201,
      assetName: 'test.exe',
      digest: 'sha256:abc',
      installerPath: '/fake',
      logPath: '/fake',
      startedAt: '2026-07-07T08:00:00.000Z',
    });
    assert.equal(checkUpgradeResult(tempDir, '0.11.1'), 'failed');
  });
});

// ── verifyFileIntegrity ────────────────────────────────────────────────

describe('verifyFileIntegrity', () => {
  let tempDir;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(tmpdir(), 'verify-integrity-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test('returns true for matching digest and size', async () => {
    const content = Buffer.from('hello world test content for integrity check');
    const filePath = path.join(tempDir, 'test.exe');
    writeFileSync(filePath, content);
    const hash = createHash('sha256').update(content).digest('hex');
    const result = await verifyFileIntegrity(filePath, `sha256:${hash}`, content.length);
    assert.equal(result, true);
  });

  test('returns false for digest mismatch', async () => {
    const content = Buffer.from('hello');
    const filePath = path.join(tempDir, 'bad.exe');
    writeFileSync(filePath, content);
    const result = await verifyFileIntegrity(filePath, 'sha256:0000000000000000', content.length);
    assert.equal(result, false);
  });

  test('returns false for size mismatch', async () => {
    const content = Buffer.from('hello');
    const filePath = path.join(tempDir, 'size.exe');
    writeFileSync(filePath, content);
    const hash = createHash('sha256').update(content).digest('hex');
    // Wrong size
    const result = await verifyFileIntegrity(filePath, `sha256:${hash}`, content.length + 100);
    assert.equal(result, false);
  });

  test('returns false when file does not exist', async () => {
    const result = await verifyFileIntegrity(path.join(tempDir, 'nope.exe'), 'sha256:abc', 100);
    assert.equal(result, false);
  });
});

// ── updatesDir ─────────────────────────────────────────────────────────

describe('updatesDir', () => {
  test('returns {userData}/updates path', () => {
    const result = updatesDir('/fake/userData');
    assert.equal(result, path.join('/fake/userData', 'updates'));
  });
});
