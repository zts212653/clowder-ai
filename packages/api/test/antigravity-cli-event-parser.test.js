import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, test } from 'node:test';

const { classifyAntigravityCliPlainText } = await import(
  '../dist/domains/cats/services/agents/providers/antigravity-cli-event-parser.js'
);

const FIXTURE_DIR = [
  resolve(process.cwd(), 'docs', 'features', 'assets', 'F210'),
  resolve(process.cwd(), '..', '..', 'docs', 'features', 'assets', 'F210'),
].find((path) => existsSync(path));

assert.ok(FIXTURE_DIR, 'F210 fixture directory must exist from repo root or packages/api cwd');

function readFixture(name) {
  return readFileSync(resolve(FIXTURE_DIR, name), 'utf8');
}

function extractBlock(fixture, label) {
  const marker = `${label}:\n`;
  const start = fixture.indexOf(marker);
  assert.notEqual(start, -1, `missing ${label} block`);
  const bodyStart = start + marker.length;
  const bodyEnd = fixture.indexOf('\n\n', bodyStart);
  const raw = fixture.slice(bodyStart, bodyEnd === -1 ? undefined : bodyEnd).trimEnd();
  return raw === '(empty)' ? '' : raw;
}

function extractErrorLogLines(fixture) {
  return fixture
    .split('\n')
    .filter((line) => line.startsWith('E... '))
    .join('\n');
}

describe('Antigravity CLI plain text parser', () => {
  test('maps the F210 success fixture to one final text message', () => {
    const stdout = extractBlock(readFixture('agy-real-home-print-success.txt'), 'stdout');

    const result = classifyAntigravityCliPlainText({ stdout, stderr: '', resumed: false });

    assert.deepEqual(result, { kind: 'text', content: 'CAT_CAFE_AGY_HEADLESS_OK' });
  });

  test('marks resumed F210 stdout as replace because AGY replays prior assistant text', () => {
    const stdout = extractBlock(readFixture('agy-conversation-resume.txt'), 'stdout');

    const result = classifyAntigravityCliPlainText({ stdout, stderr: '', resumed: true });

    assert.equal(result.kind, 'text');
    assert.equal(result.content, 'CAT_CAFE_AGY_HEADLESS_OK\nAGY_RESUME_OK');
    assert.equal(result.textMode, 'replace');
  });

  test('strips fresh conversation warning before surfacing final text', () => {
    const result = classifyAntigravityCliPlainText({
      stdout: 'Warning: conversation "agy-live-smoke" not found.\nCAT_CAFE_AGY_E2E_OK\n',
      stderr: '',
      resumed: false,
    });

    assert.deepEqual(result, { kind: 'text', content: 'CAT_CAFE_AGY_E2E_OK' });
  });

  test('classifies the F210 stdout timeout fixture as provider error despite exit 0', () => {
    const stdout = extractBlock(readFixture('agy-print-timeout.txt'), 'stdout');

    const result = classifyAntigravityCliPlainText({ stdout, stderr: '', resumed: false });

    assert.equal(result.kind, 'error');
    assert.equal(result.errorKind, 'timeout');
    assert.match(result.error, /timeout|超时/i);
  });

  test('classifies F210 missing-model diagnostics as onboarding error', () => {
    const stderr = extractErrorLogLines(readFixture('agy-real-home-no-default-model.txt'));

    const result = classifyAntigravityCliPlainText({ stdout: '', stderr, resumed: false });

    assert.equal(result.kind, 'error');
    assert.equal(result.errorKind, 'missing_model');
    assert.match(result.error, /\/model/);
  });

  test('keeps normal model-authored Error-prefixed text as text', () => {
    const result = classifyAntigravityCliPlainText({
      stdout: 'Error: this is quoted model output, not a CLI failure.\n',
      stderr: '',
      resumed: false,
    });

    assert.deepEqual(result, {
      kind: 'text',
      content: 'Error: this is quoted model output, not a CLI failure.',
    });
  });
});
