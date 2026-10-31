/**
 * F230 Phase B: end-to-end PTY smoke test (B-hook adapted)
 *
 * Exercises ClaudeInteractivePtyCarrierService with a real claude interactive
 * session via tmux. Validates:
 *   - session_init is yielded with a real sessionId (UUID)
 *   - at least one text message is yielded
 *   - done is yielded (usage degraded — hooks carry no token data)
 *   - done.metadata.entrypoint === 'cli' (AC-B1 billing identity guard)
 *   - no zombie tmux session after invocation
 *
 * Usage (from repo root):
 *   node packages/api/scripts/f230-pty-smoke.mjs
 *
 * Env:
 *   CAT_OPUS_MODEL=claude-opus-4-8   (or set via cat-catalog.json)
 *   ANTHROPIC_PROFILE_MODE=subscription (default)
 *
 * Takes ~30-60s: TUI startup 10-15s + claude response + cleanup.
 *
 * F230 follow-up ②: adapted from transcript-based to hook-sidecar-based.
 * - Removed 2.1.170 pin — hooks work on any claude version
 * - AC-B1 reads entrypoint from done.metadata (sidecar-enriched)
 * - AC-B4 downgraded to informational (verified by unit test + CLI flag)
 * - Usage assertion downgraded (hooks carry no token data)
 */

import { execSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const distRoot = resolve(__dirname, '../dist');

// Set model so getCatModel('opus') resolves without full cat-catalog bootstrap
process.env.CAT_OPUS_MODEL ??= 'claude-opus-4-8';

// ─── imports (after env setup) ────────────────────────────────────────────────

const { ClaudeInteractivePtyCarrierService } = await import(
  `${distRoot}/domains/cats/services/agents/providers/ClaudeInteractivePtyCarrierService.js`
);

// ─── helpers ──────────────────────────────────────────────────────────────────

function countTmuxSessionsWithPrefix(prefix) {
  try {
    const out = execSync('tmux ls 2>/dev/null || true', { encoding: 'utf8', timeout: 5000 });
    return out.split('\n').filter((l) => l.includes(prefix)).length;
  } catch {
    return 0;
  }
}

function hasTmux() {
  try {
    execSync('tmux -V', { encoding: 'utf8', timeout: 5000, stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

// ─── main ─────────────────────────────────────────────────────────────────────

if (!hasTmux()) {
  console.error('❌ tmux not available — cannot run PTY smoke test');
  process.exit(1);
}

// D6 constraint: independent cwd to isolate the smoke's transcript directory.
//
// TRUST CONSTRAINT (E5 lesson): /tmp dirs are NOT trusted by Claude Code — they
// trigger a "Do you trust files in this directory?" dialog that blocks the TUI
// before the prompt is sent. Claude must be invoked from a TRUSTED directory.
//
// Solution: use the worktree root (already trusted — devs run `claude` here).
const SMOKE_CWD = resolve(__dirname, '../../..');
console.log(`🔍 smoke cwd (trusted worktree root): ${SMOKE_CWD}`);
console.log('🚀 Starting F230 PTY smoke test (B-hook adapted)...');

// B-hook: no version pin needed — hooks work on any claude version.
// The capture script injects CLAUDE_CODE_ENTRYPOINT from env, and the carrier
// surfaces it in done.metadata.entrypoint (F230 follow-up ①).
const carrier = new ClaudeInteractivePtyCarrierService({
  cwd: SMOKE_CWD,
  pollIntervalMs: 500,
  terminalTimeoutMs: 5 * 60 * 1_000,
});

const results = {
  sessionInit: null,
  texts: [],
  done: null,
  errors: [],
};

const startMs = Date.now();
console.log('📡 Invoking carrier...');

try {
  for await (const msg of carrier.invoke('Reply with exactly: F230_SMOKE_OK')) {
    const elapsed = ((Date.now() - startMs) / 1000).toFixed(1);
    process.stdout.write(`  [${elapsed}s] ${msg.type}`);

    switch (msg.type) {
      case 'session_init':
        results.sessionInit = msg;
        process.stdout.write(` sessionId=${msg.sessionId}\n`);
        break;
      case 'text':
        results.texts.push(msg);
        process.stdout.write(` "${(msg.content ?? '').slice(0, 60)}"\n`);
        break;
      case 'done':
        results.done = msg;
        process.stdout.write(` isFinal=${msg.isFinal} entrypoint=${msg.metadata?.entrypoint ?? '?'}\n`);
        break;
      case 'error':
        results.errors.push(msg);
        process.stdout.write(` error="${msg.error}"\n`);
        break;
      case 'system_info':
        process.stdout.write(` (${(msg.content ?? '').slice(0, 80)})\n`);
        break;
      default:
        process.stdout.write('\n');
    }
  }
} catch (err) {
  console.error('❌ Generator threw:', err.message);
  process.exit(1);
}

const elapsedSec = ((Date.now() - startMs) / 1000).toFixed(1);
console.log(`\n⏱  Total: ${elapsedSec}s`);

// ─── assertions ────────────────────────────────────────────────────────────────

let pass = true;

function check(label, condition, detail) {
  if (condition) {
    console.log(`  ✅ ${label}`);
  } else {
    console.error(`  ❌ ${label}${detail ? `: ${detail}` : ''}`);
    pass = false;
  }
}

function info(label, detail) {
  console.log(`  ℹ️  ${label}${detail ? `: ${detail}` : ''}`);
}

console.log('\n📋 Smoke assertions:');

check('session_init yielded', results.sessionInit != null);
check(
  'sessionId looks like UUID',
  results.sessionInit?.sessionId &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(results.sessionInit.sessionId),
  `got: ${results.sessionInit?.sessionId}`,
);
check('at least 1 text message', results.texts.length > 0, `got ${results.texts.length} texts`);
check('done yielded', results.done != null);
check('done.isFinal === true', results.done?.isFinal === true);

// Usage: degraded assertion — hooks carry no token data (accepted degradation KD-7).
// Only check that usage object exists (may be empty), not that outputTokens > 0.
check(
  'done.metadata.usage present (degraded — hooks carry no token data)',
  results.done?.metadata?.usage != null,
  `usage = ${JSON.stringify(results.done?.metadata?.usage)}`,
);

check('no errors', results.errors.length === 0, results.errors.map((e) => e.error).join('; '));
check(
  'no zombie tmux sessions (f230pty prefix)',
  countTmuxSessionsWithPrefix('f230pty') === 0,
  `found ${countTmuxSessionsWithPrefix('f230pty')} lingering sessions`,
);

// AC-B1: entrypoint from hook sidecar via done.metadata (F230 follow-up ①).
// The capture script injects $CLAUDE_CODE_ENTRYPOINT into each hook event JSON.
// Interactive claude sets this to 'cli' — billing identity proof.
const entrypoint = results.done?.metadata?.entrypoint;
check(
  'AC-B1: entrypoint=cli in done.metadata (billing identity guard)',
  entrypoint === 'cli',
  `got entrypoint=${entrypoint ?? 'NOT FOUND'} from done.metadata`,
);

// AC-B4: permission mode bypass — verified by CLI flag (--permission-mode bypassPermissions)
// and unit test Step 3 (f230-interactive-pty-carrier.test.js). Hook events don't carry
// a dedicated permission_mode field, so this is informational in the smoke test.
info('AC-B4 (permissionMode=bypassPermissions)', 'verified by CLI flag + unit test Step 3');

// AC-B3: MCP config shape (validated by unit test Step 6)
// The standalone smoke does NOT pass callbackEnv, so MCP config is not injected here.
info('AC-B3 (MCP config)', 'gated on callbackEnv — validated by unit test Step 6');

if (pass) {
  console.log('\n🎉 F230 PTY smoke test PASS');
  process.exit(0);
} else {
  console.error('\n💥 F230 PTY smoke test FAIL');
  process.exit(1);
}
