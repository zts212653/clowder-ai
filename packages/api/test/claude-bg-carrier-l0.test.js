/**
 * F203 Phase C — Task 3: ClaudeBgCarrierService injects L0 via
 * `--system-prompt-file` (compression-immune native system role).
 *
 * The non-pack identity/家规 moves out of the user-message prepend (Task 2)
 * into the native system prompt. This test asserts the bg carrier compiles
 * per-cat L0 to a temp file and passes `--system-prompt-file <path>` to the
 * spawned `claude --bg`, and is fail-closed when compile fails.
 */

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { test } from 'node:test';
import { createCatId } from '@cat-cafe/shared';
import {
  CarrierError,
  ClaudeBgCarrierService,
} from '../dist/domains/cats/services/agents/providers/ClaudeBgCarrierService.js';

/** Fake spawn capturing args; emits a valid `backgrounded · <id>` line. */
function buildArgCapturingSpawn() {
  const fn = function fakeSpawn(cmd, args, opts) {
    const stdinWrites = [];
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    // Capture stdin writes (#840 R2: prompt streams via stdin, not argv).
    child.stdin = {
      write: (chunk) => {
        stdinWrites.push(typeof chunk === 'string' ? chunk : chunk.toString());
        return true;
      },
      end: () => {},
      on: () => child.stdin,
    };
    fn.calls.push({ cmd, args, opts, stdinWrites });
    setImmediate(() => {
      child.stdout.emit('data', Buffer.from('Starting background service…\nbackgrounded · abcd1234\n'));
      child.emit('close', 0);
    });
    return child;
  };
  fn.calls = [];
  return fn;
}

/** Fake L0 compiler: records the call + writes content to outPath. */
function buildFakeL0Compiler(content = 'COMPILED-L0-FOR-CAT') {
  const fn = async ({ catId, outPath }) => {
    fn.calls.push({ catId, outPath });
    if (outPath) writeFileSync(outPath, content, 'utf8');
    return content;
  };
  fn.calls = [];
  return fn;
}

test('Task 3: bg carrier passes --system-prompt-file with compiled L0 path', async () => {
  const spawnFn = buildArgCapturingSpawn();
  const l0CompilerFn = buildFakeL0Compiler('你是 布偶猫... L0 BODY');
  const service = new ClaudeBgCarrierService({
    catId: createCatId('opus-47'),
    spawnFn,
    model: 'claude-test-model',
    l0CompilerFn,
  });
  await service.startJob('hi');

  // L0 compiler invoked for this cat with an outPath
  assert.equal(l0CompilerFn.calls.length, 1);
  assert.equal(l0CompilerFn.calls[0].catId, 'opus-47');
  const l0Path = l0CompilerFn.calls[0].outPath;
  assert.ok(l0Path && l0Path.length > 0, 'compiler called with an outPath');

  // claude --bg spawned with --system-prompt-file <that path>
  const claudeCall = spawnFn.calls.find((c) => c.args.includes('--bg'));
  assert.ok(claudeCall, 'claude --bg was spawned');
  const flagIdx = claudeCall.args.indexOf('--system-prompt-file');
  assert.ok(flagIdx >= 0, `--system-prompt-file present in argv: ${claudeCall.args.join(' ')}`);
  assert.equal(claudeCall.args[flagIdx + 1], l0Path);
});

test('Task 3 parity: bg carrier appends pack-only systemPrompt via file (#840)', async () => {
  const spawnFn = buildArgCapturingSpawn();
  const l0CompilerFn = buildFakeL0Compiler('COMPILED-L0-FOR-OPUS');
  const service = new ClaudeBgCarrierService({
    catId: createCatId('opus-47'),
    spawnFn,
    model: 'claude-test-model',
    l0CompilerFn,
  });
  await service.startJob('hi', { systemPrompt: 'PACK-ONLY-BLOCK' });

  const claudeCall = spawnFn.calls.find((c) => c.args.includes('--bg'));
  assert.ok(claudeCall, 'claude --bg was spawned');

  // #840: inline --append-system-prompt would trigger ENAMETOOLONG on large
  // briefings. The bg carrier must route through --append-system-prompt-file
  // for parity with `-p` carrier (mirrors L0 file pattern).
  assert.ok(!claudeCall.args.includes('--append-system-prompt'), 'inline append flag must not be used');
  const appendFileIdx = claudeCall.args.indexOf('--append-system-prompt-file');
  assert.ok(
    appendFileIdx >= 0,
    `--append-system-prompt-file present in argv: ${claudeCall.args.filter((a) => a.startsWith('--')).join(' ')}`,
  );
  const appendPath = claudeCall.args[appendFileIdx + 1];
  assert.ok(typeof appendPath === 'string' && appendPath.length > 0);
  // bg carrier leaves the file on disk (per L0 pattern — daemon may read it
  // lazily on resume; OS reclaims tmp).
  assert.ok(existsSync(appendPath), 'append-prompt file written to disk');
  assert.equal(readFileSync(appendPath, 'utf8'), 'PACK-ONLY-BLOCK');
});

test('#840: bg carrier handles long systemPrompt without inlining into argv', async () => {
  const spawnFn = buildArgCapturingSpawn();
  const l0CompilerFn = buildFakeL0Compiler('COMPILED-L0-FOR-OPUS');
  const service = new ClaudeBgCarrierService({
    catId: createCatId('opus-47'),
    spawnFn,
    model: 'claude-test-model',
    l0CompilerFn,
  });

  // Simulate A2A briefing payload large enough to risk ENAMETOOLONG when
  // inlined into argv (Windows CreateProcess limit is 32,767 chars).
  const longPayload = `## pack briefing\n${'C:\\Users\\Administrator\\claude\\projects\\D--clowder-ai-packages-api\\memory\\MEMORY.md\n'.repeat(500)}`;
  await service.startJob('hi', { systemPrompt: longPayload });

  const claudeCall = spawnFn.calls.find((c) => c.args.includes('--bg'));
  assert.ok(claudeCall);
  // Long payload must never appear inline as an argv element.
  assert.ok(!claudeCall.args.includes(longPayload), 'long systemPrompt must not be inlined');
  const appendFileIdx = claudeCall.args.indexOf('--append-system-prompt-file');
  assert.ok(appendFileIdx >= 0);
  const appendPath = claudeCall.args[appendFileIdx + 1];
  assert.equal(readFileSync(appendPath, 'utf8'), longPayload);
});

test('#840 R2: bg carrier streams main prompt via stdin, not argv', async () => {
  const spawnFn = buildArgCapturingSpawn();
  const l0CompilerFn = buildFakeL0Compiler('COMPILED-L0-FOR-OPUS');
  const service = new ClaudeBgCarrierService({
    catId: createCatId('opus-47'),
    spawnFn,
    model: 'claude-test-model',
    l0CompilerFn,
  });

  // Simulate the long-prompt scenario 砚砚 probed: 50KB main prompt that
  // would push CreateProcess past Windows' 32K argv cap.
  const longPrompt = `## A2A briefing\n${'x'.repeat(50000)}`;
  await service.startJob(longPrompt);

  const claudeCall = spawnFn.calls.find((c) => c.args.includes('--bg'));
  assert.ok(claudeCall);

  // Prompt must NEVER appear as an argv element.
  assert.ok(
    !claudeCall.args.some((a) => typeof a === 'string' && a.length > 1000),
    `no argv element should be larger than 1KB; offenders: ${claudeCall.args
      .filter((a) => typeof a === 'string' && a.length > 1000)
      .map((a) => a.slice(0, 40))
      .join(' / ')}`,
  );
  assert.ok(!claudeCall.args.includes(longPrompt));

  // --bg flag still present, but no positional prompt after it.
  const bgIdx = claudeCall.args.indexOf('--bg');
  assert.ok(bgIdx >= 0);
  assert.notEqual(claudeCall.args[bgIdx + 1], longPrompt, 'token after --bg must not be the prompt');

  // Prompt content arrives via stdin.
  assert.ok(claudeCall.stdinWrites.length >= 1, 'stdin received at least one write');
  const stdinContent = claudeCall.stdinWrites.join('');
  assert.equal(stdinContent, longPrompt, 'stdin equals the full prompt');

  // Spawn stdio must allow stdin to be a pipe (not 'ignore').
  assert.deepEqual(claudeCall.opts.stdio, ['pipe', 'pipe', 'pipe'], 'stdio[0] is pipe so stdin works');
});

test('Task 3 fail-closed: L0 compile failure rejects startJob with CarrierError', async () => {
  const spawnFn = buildArgCapturingSpawn();
  const failingCompiler = async () => {
    throw new Error('L0 compile exited code=2 for opus-47: unknown catId');
  };
  const service = new ClaudeBgCarrierService({
    catId: createCatId('opus-47'),
    spawnFn,
    model: 'claude-test-model',
    l0CompilerFn: failingCompiler,
  });
  await assert.rejects(
    () => service.startJob('hi'),
    (err) => {
      assert.ok(err instanceof CarrierError, `expected CarrierError, got ${err?.constructor?.name}`);
      assert.match(err.message, /L0 compile|opus-47/);
      return true;
    },
  );
  // claude must NOT have been spawned when L0 compile failed
  assert.equal(
    spawnFn.calls.filter((c) => c.args.includes('--bg')).length,
    0,
    'claude --bg must not spawn when L0 compile fails (fail-closed)',
  );
});
