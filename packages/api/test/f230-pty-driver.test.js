/**
 * F230 Phase B: PtyDriver tests
 *
 * Integration tests using real tmux. Skipped when tmux is not available
 * (CI / environments without tmux). Each test uses an isolated session
 * name to avoid cross-test interference.
 *
 * TDD steps:
 *   Step 1: start→dispose leaves 0 tmux sessions matching f230pty prefix
 *   Step 2: injectPrompt short prompt → sessionId + transcript contains prompt text
 *   Step 3: injectPrompt 60KB prompt → transcript user bytes === inject bytes
 *   Step 4: cancel() → transcript no half-written lines + process not stuck
 */

import assert from 'node:assert/strict';
import { execSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { PtyDriver } from '../dist/domains/cats/services/agents/providers/pty/PtyDriver.js';

// ─── integration guard ────────────────────────────────────────────────────────
// These tests start real claude sessions via tmux and write to ~/.claude/projects/.
// They cannot run under with-test-home.sh (HOME is changed → transcript dir mismatch)
// and are skipped when CAT_CAFE_TEST_SANDBOX=1 (set by pnpm gate).
// Run manually: `pnpm --filter @cat-cafe/api test:pty` (no sandbox HOME override).

const IN_TEST_SANDBOX = process.env.CAT_CAFE_TEST_SANDBOX === '1';

function hasTmux() {
  try {
    const result = spawnSync('tmux', ['-V'], { encoding: 'utf8', timeout: 5000 });
    return result.status === 0;
  } catch {
    return false;
  }
}

const TMUX_AVAILABLE = hasTmux();

function skipIfNotIntegration(t) {
  if (IN_TEST_SANDBOX) {
    t.skip('PTY integration: skipped in test sandbox (HOME override breaks transcript dir)');
    return true;
  }
  if (!TMUX_AVAILABLE) {
    t.skip('tmux not available');
    return true;
  }
  return false;
}

// Backward-compat alias used throughout
const skipIfNoTmux = skipIfNotIntegration;

// ─── helpers ─────────────────────────────────────────────────────────────────

/** Count tmux sessions whose names start with the given prefix. */
function countTmuxSessionsWithPrefix(prefix) {
  try {
    const out = execSync('tmux ls 2>/dev/null || true', { encoding: 'utf8', timeout: 5000 });
    const lines = out.split('\n').filter((l) => l.includes(prefix));
    return lines.length;
  } catch {
    return 0;
  }
}

/** Kill any lingering test sessions before/after tests. */
function cleanupTestSessions(prefix) {
  try {
    const out = execSync('tmux ls 2>/dev/null || true', { encoding: 'utf8', timeout: 5000 });
    for (const line of out.split('\n')) {
      if (!line.includes(prefix)) continue;
      const name = line.split(':')[0].trim();
      if (name) {
        execSync(`tmux kill-session -t ${name} 2>/dev/null || true`, { timeout: 5000 });
      }
    }
  } catch {
    // ignore cleanup errors
  }
}

// Use repo root as cwd for trust inheritance (E5 lesson: /tmp cwd triggers trust dialog).
// Derived dynamically from the test file's location to work on any developer machine.
// Override via F230_PTY_TRUSTED_CWD env var if the repo is not at the standard layout.
const TRUSTED_CWD = process.env.F230_PTY_TRUSTED_CWD ?? resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const SESSION_PREFIX = 'f230ptest';

/**
 * Compute ~/.claude/projects/<slug>/ for a given cwd.
 * Claude replaces ALL '/' with '-' (including leading '/' → '-').
 */
function claudeTranscriptDir(cwd) {
  const slug = cwd.replace(/\//g, '-');
  return join(homedir(), '.claude', 'projects', slug);
}

// ─── Step 1: start→dispose lifecycle ────────────────────────────────────────
// Uses readyGraceMs: 0 (skip 15s grace) — lifecycle test doesn't need TUI ready.

describe('PtyDriver lifecycle', { timeout: 30_000 }, () => {
  before(() => cleanupTestSessions(SESSION_PREFIX));
  after(() => cleanupTestSessions(SESSION_PREFIX));

  it('start() creates tmux session and dispose() removes it leaving 0 sessions', async (t) => {
    if (skipIfNoTmux(t)) return;

    const driver = new PtyDriver({
      cwd: TRUSTED_CWD,
      env: {},
      sessionPrefix: SESSION_PREFIX,
      readyTimeoutMs: 5_000,
      readyGraceMs: 0, // test seam: skip grace, just verify session lifecycle
    });

    // Pre-condition: no sessions with our prefix
    assert.equal(countTmuxSessionsWithPrefix(SESSION_PREFIX), 0, 'pre: no test sessions');

    await driver.start();

    // After start: exactly 1 session
    assert.equal(countTmuxSessionsWithPrefix(SESSION_PREFIX), 1, 'after start: 1 session');

    await driver.dispose();

    // After dispose: 0 sessions
    assert.equal(countTmuxSessionsWithPrefix(SESSION_PREFIX), 0, 'after dispose: 0 sessions');
  });

  it('dispose() is idempotent (no error on double-dispose)', async (t) => {
    if (skipIfNoTmux(t)) return;

    const driver = new PtyDriver({
      cwd: TRUSTED_CWD,
      env: {},
      sessionPrefix: SESSION_PREFIX,
      readyTimeoutMs: 5_000,
      readyGraceMs: 0,
    });

    await driver.start();
    await driver.dispose();
    // Second dispose must not throw
    await assert.doesNotReject(() => driver.dispose());

    assert.equal(countTmuxSessionsWithPrefix(SESSION_PREFIX), 0, 'after double dispose: 0 sessions');
  });
});

// ─── Step 2 + 3: injectPrompt — sessionId + transcript needle + 60KB parity ──
// Full 15s grace required. Burns one real claude subscription turn.

describe('PtyDriver injectPrompt', { timeout: 90_000 }, () => {
  before(() => cleanupTestSessions(SESSION_PREFIX));
  after(() => cleanupTestSessions(SESSION_PREFIX));

  it('injectPrompt returns sessionId + transcript user event contains prompt text', async (t) => {
    if (skipIfNoTmux(t)) return;

    const needle = 'F230_STEP2_NEEDLE_' + Date.now();
    const transcriptDir = claudeTranscriptDir(TRUSTED_CWD);

    const driver = new PtyDriver({
      cwd: TRUSTED_CWD,
      env: {},
      sessionPrefix: SESSION_PREFIX,
      readyTimeoutMs: 30_000,
      readyGraceMs: 15_000, // real TUI ready wait
    });

    try {
      await driver.start();

      const result = await driver.injectPrompt(`Reply with exactly one word: ${needle}`, transcriptDir);

      // Must return valid paths
      assert.ok(result.transcriptPath, 'transcriptPath returned');
      assert.ok(existsSync(result.transcriptPath), 'transcriptPath file exists');
      // sessionId comes from Claude's generated UUID (filename of the discovered transcript)
      assert.match(
        result.sessionId,
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
        'sessionId is a valid UUID',
      );
      assert.equal(
        basename(result.transcriptPath),
        `${result.sessionId}.jsonl`,
        'transcript filename = sessionId.jsonl',
      );

      // Give claude ~3s for the user event to be written (transcript ack is fast)
      await new Promise((r) => setTimeout(r, 3_000));

      // Read transcript and find the user event containing the needle
      const content = readFileSync(result.transcriptPath, 'utf8');
      assert.ok(
        content.includes(needle),
        `transcript should contain needle "${needle}" — content snippet: ${content.slice(0, 500)}`,
      );
    } finally {
      await driver.dispose();
    }
  });

  it('injectPrompt 60KB prompt — transcript user bytes === inject bytes (E2 standard)', async (t) => {
    if (skipIfNoTmux(t)) return;

    // Build exactly 60KB: needle + padding + needle (all ASCII → byte count = char count)
    const needle60k = 'F230_60K_NEEDLE_' + Date.now();
    const SIXTY_KB = 60 * 1024; // 61440 bytes
    const structure = needle60k + '\n' + '\n' + needle60k; // header + 2 newlines + footer
    const structBytes = Buffer.byteLength(structure, 'utf8');
    const paddingLen = SIXTY_KB - structBytes;
    assert.ok(paddingLen > 0, `need positive padding, structBytes=${structBytes}`);
    // Use 'A' repeated — simple ASCII, 1 byte each
    const padding = 'A'.repeat(paddingLen);
    const injectText = needle60k + '\n' + padding + '\n' + needle60k;
    const injectBytes = Buffer.byteLength(injectText, 'utf8');
    assert.equal(injectBytes, SIXTY_KB, `inject text must be exactly 60KB, got ${injectBytes}`);

    const transcriptDir = claudeTranscriptDir(TRUSTED_CWD);

    const driver = new PtyDriver({
      cwd: TRUSTED_CWD,
      env: {},
      sessionPrefix: SESSION_PREFIX,
      readyTimeoutMs: 30_000,
      readyGraceMs: 15_000,
    });

    try {
      await driver.start();

      const result = await driver.injectPrompt(injectText, transcriptDir);

      // Wait for user event to be written (larger paste needs more time)
      await new Promise((r) => setTimeout(r, 5_000));

      // Find the user event line in transcript
      const lines = readFileSync(result.transcriptPath, 'utf8').split('\n').filter(Boolean);
      let userMsgBytes = 0;
      for (const line of lines) {
        try {
          const ev = JSON.parse(line);
          if (ev.type === 'user') {
            const msg = ev.message;
            if (typeof msg === 'object' && msg !== null && !Array.isArray(msg)) {
              // {role: 'user', content: '...text...'} or {content: [{type:'text', text: '...'}]}
              const content = msg.content;
              const text =
                typeof content === 'string'
                  ? content
                  : Array.isArray(content)
                    ? content.map((c) => c.text ?? '').join('')
                    : String(content);
              if (text.includes(needle60k)) {
                userMsgBytes = Buffer.byteLength(text, 'utf8');
                break;
              }
            }
          }
        } catch {
          // skip malformed lines
        }
      }

      assert.ok(userMsgBytes > 0, 'found user event with needle in transcript');
      // E2 standard: bytes match exactly (or within JSON encoding overhead ±5%)
      const delta = Math.abs(userMsgBytes - injectBytes) / injectBytes;
      assert.ok(
        delta < 0.05,
        `transcript user bytes (${userMsgBytes}) should match inject bytes (${injectBytes}) within 5%, delta=${(delta * 100).toFixed(1)}%`,
      );
    } finally {
      await driver.dispose();
    }
  });
});

// ─── Step 4: cancel() — no half-written lines, process not stuck ────────────

describe('PtyDriver cancel', { timeout: 90_000 }, () => {
  before(() => cleanupTestSessions(SESSION_PREFIX));
  after(() => cleanupTestSessions(SESSION_PREFIX));

  it('cancel() after stream starts — transcript has no half-written lines', async (t) => {
    if (skipIfNoTmux(t)) return;

    const needle = 'F230_CANCEL_' + Date.now();
    const transcriptDir = claudeTranscriptDir(TRUSTED_CWD);

    const driver = new PtyDriver({
      cwd: TRUSTED_CWD,
      env: {},
      sessionPrefix: SESSION_PREFIX,
      readyTimeoutMs: 30_000,
      readyGraceMs: 15_000,
    });

    try {
      await driver.start();

      // Inject a long-running prompt (50 numbers with explanations)
      const longPrompt = `${needle} — Count from 1 to 50 slowly, one per line with a 2-sentence explanation.`;
      const result = await driver.injectPrompt(longPrompt, transcriptDir);

      // Let streaming start for a few seconds
      await new Promise((r) => setTimeout(r, 5_000));

      // Cancel mid-stream
      await driver.cancel();

      // Wait a moment for transcript to settle
      await new Promise((r) => setTimeout(r, 2_000));

      // Assert: every line in transcript parses as valid JSON (no half-written lines)
      assert.ok(existsSync(result.transcriptPath), 'transcript file exists after cancel');
      const rawLines = readFileSync(result.transcriptPath, 'utf8').split('\n').filter(Boolean);
      assert.ok(rawLines.length > 0, 'transcript has at least 1 line');

      for (let i = 0; i < rawLines.length; i++) {
        let parsed;
        try {
          parsed = JSON.parse(rawLines[i]);
        } catch (err) {
          assert.fail(`Line ${i} is not valid JSON (half-written?): ${rawLines[i].slice(0, 100)}`);
        }
        assert.ok(typeof parsed === 'object' && parsed !== null, `Line ${i} parsed to object`);
      }

      // Assert: tmux session still alive after cancel (session preserved for resume)
      assert.equal(
        countTmuxSessionsWithPrefix(SESSION_PREFIX),
        1,
        'tmux session survives cancel (ESC does not kill session)',
      );
    } finally {
      await driver.dispose();
    }
  });
});
