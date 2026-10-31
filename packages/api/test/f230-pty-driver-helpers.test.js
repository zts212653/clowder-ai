/**
 * F230 Phase B: PtyDriver helper unit tests
 *
 * Tests for exported helper functions that are pure/testable without real tmux.
 *
 * TDD Steps:
 *   Step 7b: isBypassConfirmationScreen — unit tests for bypass menu detection
 *   Step 7c: watchForTranscriptFile ai-title skip — R11 fix (2026-06-11)
 */
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  acquireTranscriptDirWatch,
  isBypassConfirmationScreen,
  watchForTranscriptFile,
} from '../dist/domains/cats/services/agents/providers/pty/pty-utils.js';

// ─── Step 7b: isBypassConfirmationScreen ─────────────────────────────────────
// P1-A fix: PtyDriver.start() detects the --permission-mode bypassPermissions
// confirmation TUI screen and sends Enter to accept. This helper is exported
// for unit testing (pure function — no tmux side effects).

describe('PtyDriver — Step 7b: isBypassConfirmationScreen', () => {
  it('returns true when pane shows bypassPermissions confirmation menu', () => {
    // Real Claude Code 2.1.170 pane content (砚砚 probe 2026-06-10):
    // cursor starts on "1. No, exit"; PtyDriver.start() sends Down+Enter to accept.
    const paneContent = '? Allow Claude to use bypassPermissions mode?\n  ❯ 1. No, exit\n    2. Yes, I accept';
    assert.equal(isBypassConfirmationScreen(paneContent), true, 'detects bypass menu with full text');
  });

  it('returns true when bypassPermissions keyword appears anywhere in pane', () => {
    assert.equal(isBypassConfirmationScreen('bypassPermissions'), true, 'standalone keyword');
    assert.equal(isBypassConfirmationScreen('─ bypassPermissions ─'), true, 'keyword in header');
    assert.equal(
      isBypassConfirmationScreen('You have selected bypassPermissions\n  1. No, exit\n  2. Yes, I accept'),
      true,
      'numbered list variant',
    );
  });

  it('returns false for regular Claude prompt pane (no bypass keyword)', () => {
    assert.equal(isBypassConfirmationScreen('❯ Ready\n\nType your message...'), false, 'normal prompt');
    assert.equal(isBypassConfirmationScreen(''), false, 'empty pane');
    assert.equal(isBypassConfirmationScreen('Claude Code 1.0.0\n\n❯'), false, 'startup screen');
  });

  it('returns false for pane content that mentions accept/exit but not bypassPermissions', () => {
    // Guard: must specifically check for bypassPermissions, not generic yes/no patterns
    assert.equal(
      isBypassConfirmationScreen('Do you want to exit?\n  ❯ No\n  Yes'),
      false,
      'generic exit prompt without bypass keyword',
    );
  });
});

// ─── Step 7c: watchForTranscriptFile ai-title skip (R11 fix) ──────────────────
// Claude writes an ai-title-only metadata file BEFORE the real conversation file.
// watchForTranscriptFile must skip ai-title-only files and wait for the real one.

describe('watchForTranscriptFile — Step 7c: ai-title skip (R11 fix)', () => {
  /** Make a temp dir for each test; return cleanup fn and dir path */
  const makeDir = () => {
    const dir = join(tmpdir(), `f230-test-${process.pid}-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
  };

  it('resolves with a normal (non-ai-title) new .jsonl file immediately', async () => {
    const { dir, cleanup } = makeDir();
    try {
      const existingFiles = new Set();
      const watch$ = watchForTranscriptFile(dir, existingFiles, 2000);
      // Write a real conversation file (starts with a non-ai-title event)
      const real = join(dir, 'aaaa1111-0000-0000-0000-000000000000.jsonl');
      writeFileSync(real, '{"type":"user","message":{"role":"user","content":"hi"}}\n');
      const result = await watch$;
      assert.equal(result, real, 'resolves with the real conversation file');
    } finally {
      cleanup();
    }
  });

  it('skips ai-title-only file and resolves when real conversation file appears', async () => {
    const { dir, cleanup } = makeDir();
    try {
      const existingFiles = new Set();
      const watch$ = watchForTranscriptFile(dir, existingFiles, 3000);

      // Write ai-title-only file first (Claude's metadata file)
      const aiTitle = join(dir, '32d8ac9c-0000-0000-0000-000000000000.jsonl');
      writeFileSync(
        aiTitle,
        '{"type":"ai-title","aiTitle":"Smoke test","sessionId":"32d8ac9c-0000-0000-0000-000000000000"}\n',
      );

      // Small delay, then write the real conversation file
      await new Promise((r) => setTimeout(r, 50));
      const real = join(dir, '3e9d3f9f-0000-0000-0000-000000000000.jsonl');
      writeFileSync(real, '{"type":"user","message":{"role":"user","content":"Reply with F230_SMOKE_OK"}}\n');

      const result = await watch$;
      assert.equal(result, real, 'resolves with real conversation file, not ai-title file');
      assert.notEqual(result, aiTitle, 'does not resolve with ai-title-only file');
    } finally {
      cleanup();
    }
  });

  it('resolves with ai-title file when conversation events are appended to it', async () => {
    const { dir, cleanup } = makeDir();
    try {
      const existingFiles = new Set();
      const watch$ = watchForTranscriptFile(dir, existingFiles, 3000);

      // Write ai-title-only file first
      const file = join(dir, 'bbbb2222-0000-0000-0000-000000000000.jsonl');
      writeFileSync(file, '{"type":"ai-title","aiTitle":"Test","sessionId":"bbbb2222"}\n');

      // Small delay, then append conversation events to THE SAME file
      await new Promise((r) => setTimeout(r, 50));
      const { appendFileSync } = await import('node:fs');
      appendFileSync(file, '{"type":"user","message":{"role":"user","content":"hi"}}\n');

      const result = await watch$;
      assert.equal(result, file, 'resolves with the ai-title file once conversation events are appended');
    } finally {
      cleanup();
    }
  });

  it('rejects after timeoutMs when no non-ai-title file appears', async () => {
    const { dir, cleanup } = makeDir();
    try {
      const existingFiles = new Set();
      const watch$ = watchForTranscriptFile(dir, existingFiles, 200);

      // Write only an ai-title file (no real conversation follows)
      writeFileSync(join(dir, 'metadata.jsonl'), '{"type":"ai-title","aiTitle":"noop"}\n');

      await assert.rejects(watch$, /no new transcript file appeared/, 'rejects after timeout');
    } finally {
      cleanup();
    }
  });

  // ─── Step 7g: partial/empty file safety (P2 cloud review fix) ─────────────────
  // Cloud P2: when Claude opens a .jsonl file but hasn't flushed the first JSON line
  // yet (empty file) or is mid-write (partial JSON), isAiTitleOnly() returned false
  // and watchForTranscriptFile resolved immediately with that path as a "real" transcript.
  // Fix: treat empty/unreadable files as "defer" (same as ai-title-only), not "real".

  it('defers an empty .jsonl file — does not resolve until content is written', async () => {
    const { dir, cleanup } = makeDir();
    try {
      const existingFiles = new Set();
      const watch$ = watchForTranscriptFile(dir, existingFiles, 3000);

      // Create an empty file (Claude opened the fd but hasn't written yet)
      const emptyFile = join(dir, 'cccc3333-0000-0000-0000-000000000000.jsonl');
      writeFileSync(emptyFile, ''); // empty

      // Small delay, then write the real conversation to a different file
      await new Promise((r) => setTimeout(r, 50));
      const real = join(dir, 'dddd4444-0000-0000-0000-000000000000.jsonl');
      writeFileSync(real, '{"type":"user","message":{"role":"user","content":"hi"}}\n');

      const result = await watch$;
      assert.equal(result, real, 'resolves with real file, not the empty file');
      assert.notEqual(result, emptyFile, 'must not resolve with empty file');
    } finally {
      cleanup();
    }
  });

  it('defers a partially-written .jsonl file — does not resolve until full JSON line', async () => {
    const { dir, cleanup } = makeDir();
    try {
      const existingFiles = new Set();
      const watch$ = watchForTranscriptFile(dir, existingFiles, 3000);

      // Create a file with partial JSON (mid-write by Claude)
      const partialFile = join(dir, 'eeee5555-0000-0000-0000-000000000000.jsonl');
      writeFileSync(partialFile, '{"type":"ai-title","aiTit'); // truncated, no closing brace

      // Small delay, then write the real conversation to a different file
      await new Promise((r) => setTimeout(r, 50));
      const real = join(dir, 'ffff6666-0000-0000-0000-000000000000.jsonl');
      writeFileSync(real, '{"type":"user","message":{"role":"user","content":"hi"}}\n');

      const result = await watch$;
      assert.equal(result, real, 'resolves with real file, not the partial-JSON file');
      assert.notEqual(result, partialFile, 'must not resolve with partially-written file');
    } finally {
      cleanup();
    }
  });
});

// Step 7d (resolveGitProjectDir) was removed (F230 diagnostic 2026-06-11):
// The original hypothesis that Claude routes transcripts to git-common-dir
// was WRONG — Claude uses the actual CWD slug for its transcript directory.
// resolveGitProjectDir has been removed from pty-utils.ts.

// ─── Step 7e: acquireTranscriptDirWatch — async queue serialization ─────────────
// Two concurrent PtyDriver.injectPrompt calls on the same transcriptDir would race
// to claim each other's new .jsonl files. acquireTranscriptDirWatch serializes
// access via a module-level async queue: the second caller AWAITS the first to
// release, then proceeds. Both callers complete in order — neither is rejected.
//
// Cloud P1 fix (F230 B-min): changed from fail-fast Set (second caller got error+done)
// to async queue (second caller waits, then runs independently with its own transcript).

describe('acquireTranscriptDirWatch — Step 7e: async queue serialization', () => {
  it('resolves to a release function and allows re-acquire after release', async () => {
    const dir = '/tmp/f230-test-concurrent-guard';
    const release = await acquireTranscriptDirWatch(dir);
    assert.equal(typeof release, 'function', 'resolves to a release function');
    release(); // dir is now free
    // Should be acquirable again after release
    const release2 = await acquireTranscriptDirWatch(dir);
    assert.equal(typeof release2, 'function', 're-acquire after release works');
    release2();
  });

  it('second concurrent acquire on same dir waits until first releases', async () => {
    const dir = '/tmp/f230-test-concurrent-guard-dup';
    const release = await acquireTranscriptDirWatch(dir);

    let secondAcquired = false;
    const secondAcquireP = acquireTranscriptDirWatch(dir).then((rel) => {
      secondAcquired = true;
      rel();
    });

    // While first holds: second must still be waiting
    await new Promise((r) => setImmediate(r));
    assert.equal(secondAcquired, false, 'second acquire must not complete while first holds');

    // Release first holder
    release();
    await secondAcquireP;
    assert.equal(secondAcquired, true, 'second acquire completes after first releases');
  });

  it('allows concurrent acquires on different dirs', async () => {
    const dirA = '/tmp/f230-test-concurrent-guard-a';
    const dirB = '/tmp/f230-test-concurrent-guard-b';
    const [releaseA, releaseB] = await Promise.all([acquireTranscriptDirWatch(dirA), acquireTranscriptDirWatch(dirB)]);
    // Both acquired without waiting — different dirs are independent
    releaseA();
    releaseB();
  });
});

// ─── Step 7f: guard acquired before paste — ordering invariant ─────────────────
// PtyDriver awaits acquireTranscriptDirWatch as the FIRST async operation in
// injectPrompt (before any tmux calls). A concurrent same-dir caller WAITS at
// this await point — it does not proceed to paste or send Enter until it has
// acquired the queue slot. This preserves the "no ghost prompt" invariant:
// the second caller cannot submit a prompt before the first has finished.

describe('acquireTranscriptDirWatch — Step 7f: guard acquired before paste (ordering invariant)', () => {
  it('second concurrent caller does not reach tmux before acquiring the queue slot', async () => {
    // Simulate PtyDriver: await acquireTranscriptDirWatch FIRST, THEN call tmux.
    // The second caller must not reach the tmux call until it acquires.
    const dir = '/tmp/f230-guard-before-paste';
    const release = await acquireTranscriptDirWatch(dir);

    let tmuxCalled = false;
    let guardAcquired = false;
    const simulatePasteSequence = async () => {
      await acquireTranscriptDirWatch(dir); // waits here — tmuxCalled stays false
      guardAcquired = true;
      tmuxCalled = true; // only reached after guard is acquired
    };

    const secondCaller = simulatePasteSequence();

    // While first holds: second must not have reached tmux
    await new Promise((r) => setImmediate(r));
    assert.equal(tmuxCalled, false, 'second caller must not issue tmux before acquiring guard');
    assert.equal(guardAcquired, false, 'second caller must not be past guard yet');

    // Release first holder
    release();
    await secondCaller;

    assert.equal(tmuxCalled, true, 'tmux was called once guard was acquired');
    assert.equal(guardAcquired, true, 'guard acquired before any tmux call');
  });

  it('finally always releases even when guarded section throws', async () => {
    const dir = '/tmp/f230-guard-finally-release';
    let released = false;
    try {
      const innerRelease = await acquireTranscriptDirWatch(dir);
      try {
        throw new Error('simulated tmux error');
      } finally {
        innerRelease();
        released = true;
      }
    } catch {
      // expected
    }
    assert.equal(released, true, 'release must be called even when guarded section throws');
    // dir must be free again so the next caller can acquire it
    const release2 = await acquireTranscriptDirWatch(dir);
    release2();
  });
});
