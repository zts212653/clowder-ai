/**
 * F203 Phase C — Task 4: CodexAgentService injects L0 via per-call
 * `-c developer_instructions=...` (S4-verified, 砚砚 62b9255e2).
 *
 * The compiled L0 enters the OpenAI `developer` role (higher priority than the
 * user prompt, additive — not replacing Codex's own base instructions) via
 * per-invocation argv, NOT `~/.codex/config.toml` (which would race across
 * @codex / @gpt52 / @spark). fail-closed (generator contract): on compile
 * failure yield error + done + return (mirrors the CLI-not-found path), and
 * codex must not spawn.
 */

import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mock, test } from 'node:test';
import { createCatId } from '@cat-cafe/shared';

const { CodexAgentService } = await import('../dist/domains/cats/services/agents/providers/CodexAgentService.js');

async function collect(iterable) {
  const items = [];
  for await (const item of iterable) items.push(item);
  return items;
}

function createMockProcess() {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const emitter = new EventEmitter();
  const proc = {
    stdout,
    stderr,
    pid: 12345,
    exitCode: null,
    kill: mock.fn(() => true),
    on: (e, l) => {
      emitter.on(e, l);
      return proc;
    },
    once: (e, l) => {
      emitter.once(e, l);
      return proc;
    },
    _emitter: emitter,
  };
  return proc;
}

function emitOk(proc) {
  proc.stdout.write(`${JSON.stringify({ type: 'thread.started', thread_id: 'thr-1' })}\n`);
  proc.stdout.write(
    `${JSON.stringify({ type: 'item.completed', item: { id: 'm1', type: 'agent_message', text: 'ok' } })}\n`,
  );
  proc.stdout.write(`${JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } })}\n`);
  // Defer end + 'exit' past spawnCli's listener attach — invoke() awaits L0
  // compile before spawn, so a sync 'exit' would be lost (see emitCodexEvents).
  setImmediate(() => {
    proc.stdout.end();
    proc._emitter.emit('exit', 0, null);
  });
}

/** Records {catId} and returns a fixed L0 body (no outPath → stdout-mode). */
function fixedL0(body) {
  const fn = async ({ catId }) => {
    fn.calls.push({ catId });
    return body;
  };
  fn.calls = [];
  return fn;
}

test('Task 4: codex argv carries -c developer_instructions=<compiled L0>', async () => {
  const proc = createMockProcess();
  const spawnFn = mock.fn(() => proc);
  const l0CompilerFn = fixedL0('DEV-L0-BODY');
  const service = new CodexAgentService({ spawnFn, catId: createCatId('codex'), l0CompilerFn });

  const promise = collect(service.invoke('hi'));
  emitOk(proc);
  await promise;

  assert.equal(l0CompilerFn.calls.length, 1);
  assert.equal(l0CompilerFn.calls[0].catId, 'codex');

  const args = spawnFn.mock.calls[0].arguments[1];
  assert.ok(args.includes('--config'), 'argv must include --config');
  assert.ok(
    args.includes('developer_instructions="DEV-L0-BODY"'),
    `argv must carry TOML-encoded developer_instructions; got: ${args.join(' ')}`,
  );
});

test('Task 4: per-call argv is cat-scoped (no shared config.toml race)', async () => {
  const mk = (catId) => {
    const proc = createMockProcess();
    const spawnFn = mock.fn(() => proc);
    const l0CompilerFn = fixedL0(`L0-FOR-${catId}`);
    const service = new CodexAgentService({ spawnFn, catId: createCatId(catId), l0CompilerFn });
    return { proc, spawnFn, l0CompilerFn, service };
  };
  const a = mk('codex');
  const b = mk('gpt52');

  const pa = collect(a.service.invoke('hi'));
  emitOk(a.proc);
  await pa;
  const pb = collect(b.service.invoke('hi'));
  emitOk(b.proc);
  await pb;

  assert.equal(a.l0CompilerFn.calls[0].catId, 'codex');
  assert.equal(b.l0CompilerFn.calls[0].catId, 'gpt52');
  assert.ok(a.spawnFn.mock.calls[0].arguments[1].includes('developer_instructions="L0-FOR-codex"'));
  assert.ok(b.spawnFn.mock.calls[0].arguments[1].includes('developer_instructions="L0-FOR-gpt52"'));
});

test('Task 4 fail-closed: L0 compile failure → error + done, codex not spawned', async () => {
  const proc = createMockProcess();
  const spawnFn = mock.fn(() => proc);
  const failing = async () => {
    throw new Error('L0 compile exited code=2 for codex: boom');
  };
  const service = new CodexAgentService({ spawnFn, catId: createCatId('codex'), l0CompilerFn: failing });

  const msgs = await collect(service.invoke('hi'));

  const err = msgs.find((m) => m.type === 'error');
  assert.ok(err, 'must yield an error message when L0 compile fails');
  assert.match(String(err.error), /L0 compile|boom/);
  assert.ok(
    msgs.some((m) => m.type === 'done'),
    'must yield done after error (routing completion contract)',
  );
  assert.equal(spawnFn.mock.calls.length, 0, 'codex must not spawn when L0 compile fails (fail-closed)');
});

// F203 Phase C — 砚砚 review P1 regression guard.
// userConfigArgs dedup() previously SKIPPED the system-injected
// `--config developer_instructions=<L0>` whenever userConfigKeys contained
// `developer_instructions` — meaning any cliConfigArgs entry like
// `--config developer_instructions="USER"` silently replaced the entire L0.
// That breaks fail-closed (L0 = identity/家规 invariant, not user-configurable).
// Fix: treat `developer_instructions` as a reserved system key and strip it
// from userConfigArgs before dedup; system L0 always wins.
test('Task 4 reserved key: cliConfigArgs CANNOT override system developer_instructions (L0)', async () => {
  const proc = createMockProcess();
  const spawnFn = mock.fn(() => proc);
  const l0CompilerFn = fixedL0('SYSTEM-L0-CONTENT');
  const service = new CodexAgentService({ spawnFn, catId: createCatId('codex'), l0CompilerFn });

  const promise = collect(
    service.invoke('hi', {
      // user tries to override the system L0 via cliConfigArgs
      cliConfigArgs: ['--config developer_instructions="USER-OVERRIDE"'],
    }),
  );
  emitOk(proc);
  await promise;

  const args = spawnFn.mock.calls[0].arguments[1];
  assert.ok(
    args.includes('developer_instructions="SYSTEM-L0-CONTENT"'),
    `system L0 must remain in argv; got: ${args.join(' ')}`,
  );
  assert.ok(
    !args.includes('developer_instructions="USER-OVERRIDE"'),
    'user cliConfigArgs must NOT override system developer_instructions (fail-closed reserved key)',
  );
});

// 云端 Codex P1-cloud-2 regression: stripReservedSystemConfigs originally
// only matched the long `--config` form, so `-c developer_instructions=…`
// (the documented short alias `-c, --config <key=value>`) bypassed the
// reserved-key guard and silently overrode the L0. Strip must cover both.
test('Task 4 reserved key: short-form `-c` cannot override system developer_instructions either', async () => {
  const proc = createMockProcess();
  const spawnFn = mock.fn(() => proc);
  const l0CompilerFn = fixedL0('SYSTEM-L0-CONTENT');
  const service = new CodexAgentService({ spawnFn, catId: createCatId('codex'), l0CompilerFn });

  const promise = collect(
    service.invoke('hi', {
      // Same attack via the `-c` short alias instead of `--config`.
      cliConfigArgs: ['-c developer_instructions="USER-OVERRIDE-SHORT"'],
    }),
  );
  emitOk(proc);
  await promise;

  const args = spawnFn.mock.calls[0].arguments[1];
  assert.ok(
    args.includes('developer_instructions="SYSTEM-L0-CONTENT"'),
    `system L0 must remain; got: ${args.join(' ')}`,
  );
  assert.ok(
    !args.includes('developer_instructions="USER-OVERRIDE-SHORT"'),
    '`-c` short-form override must be stripped same as `--config`',
  );
});
