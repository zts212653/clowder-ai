/**
 * #857 regression: buildCliDiagnostics surfaces a sanitized safeExcerpt for
 * truly unknown CLI errors when rawText is available (excerptSource='unknown_raw').
 *
 * Security invariants:
 * - Secret tokens in rawText are redacted by sanitizeCliStderr
 * - excerptSource is 'unknown_raw' (admitted by frontend KNOWN_EXCERPT_SOURCES)
 * - Missing rawText → no safeExcerpt (fail-closed)
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const { buildCliDiagnostics } = await import('../dist/utils/cli-diagnostics.js');

const debugRef = { command: 'test-cli', exitCode: 1, exitSignal: undefined, durationMs: 100 };

describe('buildCliDiagnostics — unknown_raw excerpt (#857)', () => {
  it('surfaces sanitized rawText as safeExcerpt with source unknown_raw', () => {
    const result = buildCliDiagnostics({
      rawText: 'Error: could not connect to server',
      debugRef,
    });
    assert.equal(result.excerptSource, 'unknown_raw');
    assert.ok(result.safeExcerpt);
    assert.ok(result.safeExcerpt.includes('could not connect to server'));
  });

  it('redacts secrets in rawText before surfacing', () => {
    const result = buildCliDiagnostics({
      rawText: 'Auth failed: api_key="sk-ant-api03-xxxxxxxxxxxxxxxxx" invalid',
      debugRef,
    });
    assert.equal(result.excerptSource, 'unknown_raw');
    assert.ok(result.safeExcerpt);
    assert.ok(!result.safeExcerpt.includes('sk-ant-api03'), 'token should be redacted');
    assert.ok(result.safeExcerpt.includes('[TOKEN_REDACTED]'));
  });

  // R3 P1 fix: non-HOME absolute paths (e.g. /srv, /workspace, D:\work) must be
  // redacted by redactNonHomePaths — sanitizeCliStderr alone only covers HOME paths.
  it('redacts non-HOME Unix paths in rawText (#857 R3 P1)', () => {
    const result = buildCliDiagnostics({
      rawText: 'Failed to open /srv/app/config/secrets.json: ENOENT',
      debugRef,
    });
    assert.equal(result.excerptSource, 'unknown_raw');
    assert.ok(result.safeExcerpt);
    assert.ok(!result.safeExcerpt.includes('/srv/app'), 'non-HOME Unix path should be redacted');
    assert.ok(result.safeExcerpt.includes('[PATH_REDACTED]'));
  });

  it('redacts non-HOME Windows paths in rawText (#857 R3 P1)', () => {
    const result = buildCliDiagnostics({
      rawText: 'Cannot find D:\\work\\project\\credentials.txt',
      debugRef,
    });
    assert.equal(result.excerptSource, 'unknown_raw');
    assert.ok(result.safeExcerpt);
    assert.ok(!result.safeExcerpt.includes('D:\\work'), 'non-HOME Windows path should be redacted');
    assert.ok(result.safeExcerpt.includes('[PATH_REDACTED]'));
  });

  it('redacts /workspace and /var/lib paths in rawText (#857 R3 P1)', () => {
    const result = buildCliDiagnostics({
      rawText: 'Error at /workspace/build/output/binary and /var/lib/data/db.sqlite',
      debugRef,
    });
    assert.equal(result.excerptSource, 'unknown_raw');
    assert.ok(result.safeExcerpt);
    assert.ok(!result.safeExcerpt.includes('/workspace/build'), '/workspace path should be redacted');
    assert.ok(!result.safeExcerpt.includes('/var/lib/data'), '/var/lib path should be redacted');
  });

  it('omits safeExcerpt when rawText is empty (fail-closed)', () => {
    const result = buildCliDiagnostics({
      rawText: '',
      debugRef,
    });
    assert.equal(result.safeExcerpt, undefined);
    assert.equal(result.excerptSource, undefined);
  });

  it('omits safeExcerpt when rawText is whitespace-only', () => {
    const result = buildCliDiagnostics({
      rawText: '   \n  ',
      debugRef,
    });
    assert.equal(result.safeExcerpt, undefined);
    assert.equal(result.excerptSource, undefined);
  });
});
