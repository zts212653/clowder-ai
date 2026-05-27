// F212 Phase A — Task 3: buildCliDiagnostics() (AC-A1 + AC-A5 + AC-A6)

import assert from 'node:assert';
import test from 'node:test';
import { buildCliDiagnostics, formatCliStderrForLog } from '../dist/utils/cli-diagnostics.js';

const baseRef = { command: 'codex', exitCode: 1, signal: null, invocationId: 'inv-1' };

test('AC-A5: unknown stderr → no safeExcerpt, publicSummary fallback', () => {
  const d = buildCliDiagnostics({ rawText: 'some weird thing happened', debugRef: baseRef });
  assert.strictEqual(d.reasonCode, undefined);
  assert.strictEqual(d.safeExcerpt, undefined);
  assert.match(d.publicSummary, /未识别/);
  assert.ok(d.publicHint.length > 0);
});

test('AC-A1 + AC-A5: known reasonCode → safeExcerpt filled, publicSummary/Hint reasonable', () => {
  const d = buildCliDiagnostics({
    rawText:
      'APIError: The supported API model names are deepseek-v4-pro or deepseek-v4-flash, but you passed deepseek-v-4.',
    debugRef: baseRef,
  });
  assert.strictEqual(d.reasonCode, 'model_not_found');
  assert.ok(d.safeExcerpt, 'safeExcerpt should be present');
  assert.ok(d.safeExcerpt.includes('deepseek-v4-pro'), `safeExcerpt should include matched line: ${d.safeExcerpt}`);
  assert.match(d.publicSummary, /模型/);
  assert.match(d.publicHint, /模型/);
});

test('AC-A6: panic stack — safeExcerpt strips frame lines if any', () => {
  const rawText = [
    'thread "main" panicked at src/foo.rs:42:9:',
    'assertion failed: x == y',
    'note: model not found in panic context',
    '   0: rust_begin_unwind',
    '             at /rustc/abc/library/std/src/panicking.rs:600:5',
    '   1: core::panicking::panic_fmt',
    '             at /rustc/abc/library/core/src/panicking.rs:64:14',
    '   2: cli::main::h12345abc',
    '             at /home/user/.cargo/registry/src/foo-1.0.0/src/main.rs:42:9',
  ].join('\n');
  const d = buildCliDiagnostics({ rawText, debugRef: baseRef });
  assert.strictEqual(d.reasonCode, 'model_not_found'); // matched by "model not found" line
  // panic surfaced in summary
  assert.match(d.publicSummary, /panic/i);
  // safeExcerpt exists (because reasonCode known) — must NOT contain stack frames
  assert.ok(d.safeExcerpt);
  assert.ok(!d.safeExcerpt.includes('rust_begin_unwind'), 'frame line leaked');
  assert.ok(!d.safeExcerpt.includes('panic_fmt'), 'frame line leaked');
  assert.ok(!d.safeExcerpt.includes('h12345abc'), 'frame line leaked');
  assert.ok(!d.safeExcerpt.includes('.cargo/registry'), 'cargo path leaked');
});

test('AC-A6: panic without classifier match — publicSummary surfaces headline, no safeExcerpt', () => {
  const rawText = [
    'thread "worker" panicked at src/bar.rs:99:1:',
    'completely unknown failure mode',
    '   0: rust_begin_unwind',
    '             at /rustc/abc/library/std/src/panicking.rs:600:5',
  ].join('\n');
  const d = buildCliDiagnostics({ rawText, debugRef: baseRef });
  assert.strictEqual(d.reasonCode, undefined);
  assert.strictEqual(d.safeExcerpt, undefined);
  assert.match(d.publicSummary, /panic/i);
  assert.match(d.publicSummary, /worker/);
});

test('safeExcerpt is sanitized (token redacted)', () => {
  const rawText = '401 Unauthorized: invalid api key sk-AbCdEfGh1234567890IjKlMnOpQrStUv';
  const d = buildCliDiagnostics({ rawText, debugRef: baseRef });
  assert.strictEqual(d.reasonCode, 'auth_failed');
  assert.ok(d.safeExcerpt);
  assert.ok(!d.safeExcerpt.includes('AbCdEfGh1234567890'), 'raw token leaked in safeExcerpt');
  assert.ok(d.safeExcerpt.includes('[TOKEN_REDACTED]'), `expected redaction marker: ${d.safeExcerpt}`);
});

test('OQ-3 accept: safeExcerpt ≤8 lines and ≤1500 chars', () => {
  // 50 long lines matching network_error
  const longLines = Array.from(
    { length: 50 },
    (_, i) => `line ${i}: fetch failed: connect ECONNREFUSED 127.0.0.1:9879 with extra padding text`,
  ).join('\n');
  const d = buildCliDiagnostics({ rawText: longLines, debugRef: baseRef });
  assert.strictEqual(d.reasonCode, 'network_error');
  assert.ok(d.safeExcerpt);
  const lineCount = d.safeExcerpt.split('\n').length;
  assert.ok(lineCount <= 8, `expected ≤8 lines, got ${lineCount}`);
  assert.ok(d.safeExcerpt.length <= 1500, `expected ≤1500 chars, got ${d.safeExcerpt.length}`);
});

test('debugRef present with exitCode/signal/command/invocationId', () => {
  const d = buildCliDiagnostics({ rawText: 'spawn ENOENT', debugRef: baseRef });
  assert.strictEqual(d.debugRef.command, 'codex');
  assert.strictEqual(d.debugRef.exitCode, 1);
  assert.strictEqual(d.debugRef.signal, null);
  assert.strictEqual(d.debugRef.invocationId, 'inv-1');
});

test('debugRef works without invocationId', () => {
  const d = buildCliDiagnostics({
    rawText: 'spawn ENOENT',
    debugRef: { command: 'gemini', exitCode: 1, signal: null },
  });
  assert.strictEqual(d.debugRef.command, 'gemini');
  assert.strictEqual(d.debugRef.invocationId, undefined);
});

test('empty rawText → unknown with reasonable defaults', () => {
  const d = buildCliDiagnostics({ rawText: '', debugRef: baseRef });
  assert.strictEqual(d.reasonCode, undefined);
  assert.strictEqual(d.safeExcerpt, undefined);
  assert.match(d.publicSummary, /未识别|CLI/);
  assert.ok(d.publicHint.length > 0);
});

// =============================================================================
// formatCliStderrForLog — AC-A7 / OQ-2 gate + sanitize (砚砚 review BLOCKED P1-1 fix)
// =============================================================================

test('AC-A7: formatCliStderrForLog returns null when LOG_CLI_STDERR is unset', () => {
  const env = {}; // LOG_CLI_STDERR absent
  assert.strictEqual(formatCliStderrForLog('Error: something bad\n', env), null);
});

test('AC-A7: formatCliStderrForLog returns null when LOG_CLI_STDERR != "1"', () => {
  assert.strictEqual(formatCliStderrForLog('Error\n', { LOG_CLI_STDERR: '0' }), null);
  assert.strictEqual(formatCliStderrForLog('Error\n', { LOG_CLI_STDERR: 'true' }), null);
  assert.strictEqual(formatCliStderrForLog('Error\n', { LOG_CLI_STDERR: 'yes' }), null);
});

test('AC-A7: formatCliStderrForLog returns null for empty / whitespace stderr even when enabled', () => {
  const env = { LOG_CLI_STDERR: '1' };
  assert.strictEqual(formatCliStderrForLog('', env), null);
  assert.strictEqual(formatCliStderrForLog('   \n\t  ', env), null);
});

test('AC-A7 + OQ-2: formatCliStderrForLog sanitizes content when enabled', () => {
  const env = { LOG_CLI_STDERR: '1' };
  const input = 'invalid api key sk-AbCdEfGh1234567890IjKlMnOpQr at /home/user/foo.ts';
  const out = formatCliStderrForLog(input, env);
  assert.ok(out, 'should return string when enabled');
  assert.ok(!out.includes('sk-AbCdEfGh1234567890'), 'token must be redacted');
  assert.ok(out.includes('[TOKEN_REDACTED]'));
});

test('AC-A7: formatCliStderrForLog truncates to last 1000 chars after sanitize (KD-2)', () => {
  const env = { LOG_CLI_STDERR: '1' };
  const longInput = 'A'.repeat(2000) + '\nfinal error line';
  const out = formatCliStderrForLog(longInput, env);
  assert.ok(out);
  assert.ok(out.length <= 1000);
  // The trailing part is preserved (last 1000 chars)
  assert.ok(out.includes('final error line'), 'tail content should be preserved');
});

test('all 9 reasonCodes produce non-empty publicSummary + publicHint', () => {
  const cases = [
    ['Invalid `signature` in `thinking` block: foo', 'invalid_thinking_signature'],
    ['no rollout found', 'missing_rollout'],
    ['model not found', 'model_not_found'],
    ['401 Unauthorized', 'auth_failed'],
    ['429 Too Many Requests', 'quota_exceeded'],
    ['fetch failed: ECONNREFUSED', 'network_error'],
    ['Error loading config.toml: invalid transport', 'invalid_config'],
    ['spawn ENOENT', 'spawn_failed'],
    ['context length exceeded', 'context_window_exceeded'],
  ];
  for (const [input, expectedCode] of cases) {
    const d = buildCliDiagnostics({ rawText: input, debugRef: baseRef });
    assert.strictEqual(d.reasonCode, expectedCode, `${input} → ${expectedCode}`);
    assert.ok(d.publicSummary && d.publicSummary.length > 0, `${expectedCode}: empty publicSummary`);
    assert.ok(d.publicHint && d.publicHint.length > 0, `${expectedCode}: empty publicHint`);
  }
});
