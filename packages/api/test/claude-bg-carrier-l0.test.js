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
import { writeFileSync } from 'node:fs';
import { test } from 'node:test';
import { createCatId } from '@cat-cafe/shared';
import {
  CarrierError,
  ClaudeBgCarrierService,
} from '../dist/domains/cats/services/agents/providers/ClaudeBgCarrierService.js';

/** Fake spawn capturing args; emits a valid `backgrounded · <id>` line. */
function buildArgCapturingSpawn() {
  const fn = function fakeSpawn(cmd, args, opts) {
    fn.calls.push({ cmd, args, opts });
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
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
