// F212 Phase A — Task 3: buildCliDiagnostics() (AC-A1 + AC-A5 + AC-A6)

import assert from 'node:assert';
import test from 'node:test';
import { buildCliDiagnostics, formatCliStderrForLog } from '../dist/utils/cli-diagnostics.js';
import { maybeCollectStreamError } from '../dist/utils/cli-spawn.js';

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

// ── F212 Phase D: result-error diagnostic completeness ──

test('AC-D1: collects the REAL opus-4.8 tool-call-parse result event (subtype:success + is_error:true)', () => {
  const sink = [];
  const structured = [];
  // Exact shape from 7 real opus-4.8 archive samples (2026-05-29, e.g. bb299eb0 / 0d2d46b1):
  //   { type:'result', subtype:'success', is_error:true, result:'...could not be parsed...', errors:null }
  // The error flag is `is_error:true` — subtype stays 'success' (counter-intuitive), cause text is in
  // `result`, errors[] is null. The original `subtype!=='success'` guard MISSED this (subtype IS
  // 'success'); this fixture is the regression anchor proving the is_error-based fix works.
  maybeCollectStreamError(
    {
      type: 'result',
      subtype: 'success',
      is_error: true,
      result: "The model's tool call could not be parsed (retry also failed).",
      errors: null,
    },
    sink,
    structured,
  );
  assert.ok(
    sink.join('\n').includes('could not be parsed'),
    'CC cause (from result field) reaches sink for classification',
  );
  assert.ok(structured.join('\n').includes('could not be parsed'), 'friendly CC cause reaches structuredSink');
});

test('AC-D1: does NOT collect a genuine success (is_error:false); still collects type=error (AC-A8 regression)', () => {
  // Genuine completion: subtype success + is_error:false + real result → must NOT be treated as error
  // (guards the is_error-based condition against false positives on normal completions).
  const okSink = [];
  maybeCollectStreamError(
    { type: 'result', subtype: 'success', is_error: false, result: 'task completed fine' },
    okSink,
  );
  assert.strictEqual(okSink.length, 0, 'genuine success (is_error:false) not collected — no false positive');
  // AC-A8 regression: classic type=error events still collected
  const errSink = [];
  maybeCollectStreamError({ type: 'error', error: { message: '401 Unauthorized' } }, errSink);
  assert.ok(errSink.join('\n').includes('401'), 'type=error still collected (AC-A8 regression)');
});

// Cloud codex re-review on da1f81763 P1 fix: structuredSink (which becomes user-visible via
// AC-D3 cc_structured channel) MUST be gated on the isResultError path. Otherwise any unclassified
// type='error' event's explicitParts (arbitrary provider stderr-like content) leak into
// `Claude Code 报告：...` + safeExcerpt, violating KD-1/AC-A9. Result events with is_error:true
// remain the only "safe structured source" admitted to structuredSink.
test('P1 KD-1: maybeCollectStreamError does NOT leak unclassified type=error into structuredSink', () => {
  const sink = [];
  const structured = [];
  // Arbitrary unclassified provider error — not from CC result-error format, MUST stay hidden
  maybeCollectStreamError(
    { type: 'error', error: { message: 'Some arbitrary unclassified stderr-like content from provider X' } },
    sink,
    structured,
  );
  // AC-A8: still collected to regular sink for classifier scanning
  assert.ok(sink.join('\n').includes('arbitrary unclassified'), 'type=error reaches regular sink (AC-A8 work)');
  // P1 fix: MUST NOT push to structuredSink — structuredSink is the cc_structured channel,
  // only result events with is_error:true are admitted (isResultError gate)
  assert.strictEqual(
    structured.length,
    0,
    'KD-1/AC-A9 red line: unclassified type=error MUST NOT leak to structuredSink (cloud codex P1 fix)',
  );
});

test('AC-D2: tool_call_parse_failed classified + safeExcerpt surfaces CC cause + excerptSource=classifier', () => {
  const d = buildCliDiagnostics({
    rawText: "The model's tool call could not be parsed (retry also failed).",
    debugRef: baseRef,
  });
  assert.strictEqual(d.reasonCode, 'tool_call_parse_failed');
  assert.ok(d.publicSummary.includes('工具调用'), `summary mentions tool call: ${d.publicSummary}`);
  assert.ok(d.safeExcerpt?.includes('could not be parsed'), 'safeExcerpt surfaces CC cause');
  // Phase D P2 fix (cloud codex 2026-05-29): classifier-known path tags excerptSource
  assert.strictEqual(d.excerptSource, 'classifier', 'classifier-known path tags excerptSource');
});

test('AC-D3: unknown reasonCode + structuredErrorText → "Claude Code 报告：<cause>", not 未识别 + excerptSource=cc_structured', () => {
  const d = buildCliDiagnostics({
    rawText: 'some unclassifiable noise',
    structuredErrorText: 'Agent error (error_during_execution): something CC-specific went wrong',
    debugRef: baseRef,
  });
  assert.strictEqual(d.reasonCode, undefined, 'still unclassified');
  assert.ok(d.publicSummary.startsWith('Claude Code 报告：'), `attributes to CC: ${d.publicSummary}`);
  assert.ok(!d.publicSummary.includes('未识别'), 'must NOT say 未识别 when CC gave a cause');
  assert.ok(d.safeExcerpt?.includes('error_during_execution'), 'CC structured error surfaced in safeExcerpt');
  // Phase D P2 fix (cloud codex 2026-05-29): AC-D3 path tags excerptSource so frontend
  // KNOWN_EXCERPT_SOURCES admits the excerpt for disclosure rendering
  assert.strictEqual(d.excerptSource, 'cc_structured', 'AC-D3 path tags excerptSource for frontend whitelist');
});

test('AC-D3: truly unknown (no structuredErrorText) → keeps KD-1 no-safeExcerpt + 未识别 + no excerptSource', () => {
  const d = buildCliDiagnostics({ rawText: 'random noise no cause', debugRef: baseRef });
  assert.strictEqual(d.reasonCode, undefined);
  assert.strictEqual(d.safeExcerpt, undefined, 'KD-1: no safeExcerpt for truly unknown');
  assert.ok(d.publicSummary.includes('未识别'), 'truly unknown keeps 未识别');
  // Phase D P2 fix: no safeExcerpt → no excerptSource (frontend membership check will fail closed)
  assert.strictEqual(d.excerptSource, undefined, 'truly unknown: no excerptSource (fail-closed)');
});

// F212 Phase E — server_overloaded provider-neutral invariant (cloud codex R2 P2 on adf26db37):
// classifier is shared by spawnCli for all CLI providers (claude / codex / gemini / antigravity).
// REASON_TEXT.server_overloaded MUST stay provider-neutral — hard-coding a specific brand
// misdiagnoses non-that-brand failures and sends users to the wrong status page. The regex is
// intentionally broad (generic 529 / "Server is busy" patterns) so the text must follow suit.
test('server_overloaded: REASON_TEXT MUST be provider-neutral (cloud codex R2 P2 on adf26db37)', () => {
  const d = buildCliDiagnostics({
    rawText: 'API Error: Server is temporarily limiting requests (not your usage limit) · Rate limited',
    debugRef: baseRef,
  });
  assert.strictEqual(d.reasonCode, 'server_overloaded');
  // Single-provider brand mentions in summary are misleading. Status-page list in hint is OK
  // because it explicitly enumerates ALL major providers (Anthropic / OpenAI / Google / DeepSeek)
  // so the user picks the right one — that pattern is provider-aware, not provider-locked.
  const PROVIDER_BRANDS = ['Anthropic', 'OpenAI', 'Google', 'DeepSeek', 'Gemini', 'Claude'];
  for (const brand of PROVIDER_BRANDS) {
    assert.ok(
      !d.publicSummary.includes(brand),
      `server_overloaded summary must be provider-neutral, found brand "${brand}": ${d.publicSummary}`,
    );
  }
  // Hint may enumerate providers (status-page list) but must not single one out as THE cause
  // — checked by ensuring the hint doesn't say "是 <brand> 服务器" exclusively (i.e. mentions
  // the diagnosis is NOT tied to one brand).
  const exclusiveBrandPattern = new RegExp(`是\\s*(${PROVIDER_BRANDS.join('|')})\\s*服务`, 'i');
  assert.ok(
    !exclusiveBrandPattern.test(d.publicHint),
    `server_overloaded hint must not attribute cause to a single provider brand: ${d.publicHint}`,
  );
});

// F212 Phase E (@gpt52 BLOCKED + cloud codex R1 P2 both caught the same finding on 1386ceb62):
// CliDiagnosticsPanel renders publicSummary/publicHint inside a <span> verbatim — no markdown
// parser. Any `**bold**` or `[link](url)` in REASON_TEXT will leak raw syntax to users, defeating
// the panel's体感 goal. This invariant test locks the constraint so future REASON_TEXT additions
// can't reintroduce markdown without a corresponding rich-text renderer.
test('REASON_TEXT invariant: publicSummary + publicHint MUST be plain text (no markdown syntax)', () => {
  // Build a diagnostics for each known reasonCode by feeding raw text the classifier will hit,
  // then assert no markdown bold/link patterns leak via publicSummary / publicHint.
  const cases = [
    { rawText: 'Invalid `signature` in `thinking` block', expectedCode: 'invalid_thinking_signature' },
    { rawText: 'no rollout found', expectedCode: 'missing_rollout' },
    { rawText: 'Unknown model: foo', expectedCode: 'model_not_found' },
    { rawText: '401 Unauthorized', expectedCode: 'auth_failed' },
    { rawText: '429 Too Many Requests', expectedCode: 'quota_exceeded' },
    { rawText: 'fetch failed: ECONNREFUSED', expectedCode: 'network_error' },
    { rawText: 'Error loading config.toml: invalid transport', expectedCode: 'invalid_config' },
    { rawText: 'Error: spawn ENOENT', expectedCode: 'spawn_failed' },
    { rawText: 'context length exceeded', expectedCode: 'context_window_exceeded' },
    {
      rawText: "The model's tool call could not be parsed (retry also failed)",
      expectedCode: 'tool_call_parse_failed',
    },
    {
      rawText: 'Server is temporarily limiting requests (not your usage limit)',
      expectedCode: 'server_overloaded',
    },
  ];
  // Markdown patterns that leak as raw syntax in plain-text <span> rendering
  const MARKDOWN_BOLD = /\*\*[^*]+\*\*/;
  const MARKDOWN_LINK = /\[[^\]]+\]\(https?:[^)]+\)/;
  for (const { rawText, expectedCode } of cases) {
    const d = buildCliDiagnostics({ rawText, debugRef: baseRef });
    assert.strictEqual(d.reasonCode, expectedCode, `classify "${rawText.slice(0, 40)}"`);
    assert.ok(
      !MARKDOWN_BOLD.test(d.publicSummary),
      `${expectedCode}: publicSummary leaks **bold** markdown: ${d.publicSummary}`,
    );
    assert.ok(
      !MARKDOWN_LINK.test(d.publicSummary),
      `${expectedCode}: publicSummary leaks [link](url) markdown: ${d.publicSummary}`,
    );
    assert.ok(
      !MARKDOWN_BOLD.test(d.publicHint),
      `${expectedCode}: publicHint leaks **bold** markdown: ${d.publicHint}`,
    );
    assert.ok(
      !MARKDOWN_LINK.test(d.publicHint),
      `${expectedCode}: publicHint leaks [link](url) markdown: ${d.publicHint}`,
    );
  }
});
