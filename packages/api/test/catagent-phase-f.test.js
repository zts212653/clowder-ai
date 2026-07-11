/**
 * CatAgent Phase F Tests — Write/Exec Tool Surface
 *
 * Covers F1/F2/F3-min primitives:
 * - nativeToolLevel gates L0/L1/L2 tool registration
 * - resolveCreatePath blocks symlink-parent creation escapes
 * - write_file / patch_file perform bounded, CAS-protected writes with audit
 * - run_command uses structured argv + allowlist-first policy + constrained env
 * - update_current_task_status is a host-native scoped callback tool
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';

const { buildToolRegistry, findTool } = await import(
  '../dist/domains/cats/services/agents/providers/catagent/catagent-read-tools.js'
);
const { CatAgentService, executeCatAgentTools } = await import(
  '../dist/domains/cats/services/agents/providers/catagent/CatAgentService.js'
);
const { resolveCreatePath } = await import('../dist/domains/cats/services/agents/providers/catagent/catagent-tools.js');
const { resetMigrationState } = await import('../dist/config/catalog-accounts.js');

function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}

async function collect(iter) {
  const msgs = [];
  for await (const msg of iter) msgs.push(msg);
  return msgs;
}

function sseEvent(data) {
  return `data: ${JSON.stringify(data)}\n\n`;
}

function sseStream(text) {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
}

function mockDoneResponse() {
  return {
    ok: true,
    headers: new Headers({ 'content-type': 'text/event-stream' }),
    body: sseStream(
      [
        sseEvent({ type: 'message_start', message: { id: 'msg-f', usage: { input_tokens: 1 } } }),
        sseEvent({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
        sseEvent({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } }),
        sseEvent({ type: 'content_block_stop', index: 0 }),
        sseEvent({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } }),
        sseEvent({ type: 'message_stop' }),
      ].join(''),
    ),
  };
}

let tmpDir;
let outsideDir;

before(() => {
  tmpDir = join(tmpdir(), `catagent-f-${Date.now()}`);
  outsideDir = join(tmpdir(), `catagent-f-outside-${Date.now()}`);
  mkdirSync(tmpDir, { recursive: true });
  mkdirSync(outsideDir, { recursive: true });
  writeFileSync(join(tmpDir, 'existing.txt'), 'alpha beta gamma');
  writeFileSync(join(tmpDir, 'dupe.txt'), 'same same');
  mkdirSync(join(tmpDir, '.cat-cafe'), { recursive: true });
  writeFileSync(join(tmpDir, '.cat-cafe', 'accounts.json'), JSON.stringify({ 'test-ant': { authType: 'api_key' } }));
  writeFileSync(join(tmpDir, '.cat-cafe', 'credentials.json'), JSON.stringify({ 'test-ant': { apiKey: 'sk-test-f' } }));
});

after(() => {
  try {
    rmSync(tmpDir, { recursive: true, force: true });
    rmSync(outsideDir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

describe('F1: tiered tool registry', () => {
  test('defaults to L0 read-only tools', async () => {
    const tools = await buildToolRegistry(tmpDir);
    assert.ok(findTool(tools, 'read_file'));
    assert.ok(findTool(tools, 'list_files'));
    assert.equal(findTool(tools, 'write_file'), undefined);
    assert.equal(findTool(tools, 'patch_file'), undefined);
    assert.equal(findTool(tools, 'run_command'), undefined);
  });

  test('L1 registers write_file and patch_file but not run_command', async () => {
    const tools = await buildToolRegistry(tmpDir, { nativeToolLevel: 'L1' });
    assert.ok(findTool(tools, 'write_file'));
    assert.ok(findTool(tools, 'patch_file'));
    assert.equal(findTool(tools, 'run_command'), undefined);
  });

  test('L2 registers run_command and still fails closed with empty policy', async () => {
    const tools = await buildToolRegistry(tmpDir, { nativeToolLevel: 'L2' });
    const run = findTool(tools, 'run_command');
    assert.ok(run);
    await assert.rejects(() => run.execute({ binary: 'git', args: ['status'] }), /No command policy configured/);
  });

  test('service sends tool schemas according to nativeToolLevel', async () => {
    let capturedBody = null;
    const prevFetch = globalThis.fetch;
    const prevEnv = process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT;
    const prevModel = process.env.CAT_OPUS_MODEL;
    process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT = tmpDir;
    process.env.CAT_OPUS_MODEL = 'claude-opus-4-6';
    resetMigrationState();
    globalThis.fetch = async (_url, init) => {
      capturedBody = JSON.parse(init.body);
      return mockDoneResponse();
    };
    try {
      const svc = new CatAgentService({
        catId: 'opus',
        projectRoot: tmpDir,
        catConfig: { accountRef: 'test-ant', nativeToolLevel: 'L1' },
      });
      await collect(svc.invoke('test', { workingDirectory: tmpDir }));
    } finally {
      globalThis.fetch = prevFetch;
      if (prevEnv !== undefined) process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT = prevEnv;
      else delete process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT;
      if (prevModel !== undefined) process.env.CAT_OPUS_MODEL = prevModel;
      else delete process.env.CAT_OPUS_MODEL;
      resetMigrationState();
    }

    const names = capturedBody.tools.map((t) => t.name);
    assert.ok(names.includes('write_file'));
    assert.ok(names.includes('patch_file'));
    assert.ok(!names.includes('run_command'));
  });
});

describe('F1: create-safe write and patch tools', () => {
  test('resolveCreatePath rejects creation through symlink parent escape', async () => {
    const linkPath = join(tmpDir, 'outside-link');
    if (!existsSync(linkPath)) symlinkSync(outsideDir, linkPath);
    await assert.rejects(() => resolveCreatePath(tmpDir, 'outside-link/new.txt'), /Symlink escapes workspace root/);
  });

  test('write_file writes atomically within workspace and audits hashes', async () => {
    const audit = [];
    const tools = await buildToolRegistry(tmpDir, { nativeToolLevel: 'L1', audit: (event) => audit.push(event) });
    const write = findTool(tools, 'write_file');

    const result = await write.execute({ path: 'created.txt', content: 'created content' });

    assert.equal(readFileSync(join(tmpDir, 'created.txt'), 'utf-8'), 'created content');
    assert.ok(result.includes('Wrote'));
    assert.equal(audit.length, 1);
    assert.equal(audit[0].tool, 'write_file');
    assert.equal(audit[0].outcome, 'ok');
    assert.equal(audit[0].path, 'created.txt');
    assert.equal(audit[0].hashBefore, null);
    assert.equal(audit[0].hashAfter, sha256('created content'));
  });

  test('write_file rejects files over 256 KiB', async () => {
    const tools = await buildToolRegistry(tmpDir, { nativeToolLevel: 'L1' });
    const write = findTool(tools, 'write_file');
    await assert.rejects(() => write.execute({ path: 'too-big.txt', content: 'x'.repeat(256 * 1024 + 1) }), /256 KiB/);
  });

  test('patch_file requires expected_hash and unique old_text', async () => {
    const audit = [];
    const tools = await buildToolRegistry(tmpDir, { nativeToolLevel: 'L1', audit: (event) => audit.push(event) });
    const patch = findTool(tools, 'patch_file');

    await assert.rejects(
      () => patch.execute({ path: 'existing.txt', old_text: 'alpha', new_text: 'omega', expected_hash: 'deadbeef' }),
      /expected_hash mismatch/,
    );
    await assert.rejects(
      () =>
        patch.execute({
          path: 'dupe.txt',
          old_text: 'same',
          new_text: 'once',
          expected_hash: sha256('same same').slice(0, 12),
        }),
      /old_text must match exactly once/,
    );

    const before = 'alpha beta gamma';
    const result = await patch.execute({
      path: 'existing.txt',
      old_text: 'beta',
      new_text: 'BETA',
      expected_hash: sha256(before).slice(0, 12),
    });

    assert.equal(readFileSync(join(tmpDir, 'existing.txt'), 'utf-8'), 'alpha BETA gamma');
    assert.ok(result.includes('Patched'));
    assert.equal(audit.at(-1).tool, 'patch_file');
    assert.equal(audit.at(-1).hashBefore, sha256(before));
    assert.equal(audit.at(-1).hashAfter, sha256('alpha BETA gamma'));
  });

  test('patch_file treats overlapping old_text matches as non-unique', async () => {
    const tools = await buildToolRegistry(tmpDir, { nativeToolLevel: 'L1' });
    const patch = findTool(tools, 'patch_file');
    writeFileSync(join(tmpDir, 'overlap.txt'), 'aaa');

    await assert.rejects(
      () =>
        patch.execute({
          path: 'overlap.txt',
          old_text: 'aa',
          new_text: 'X',
          expected_hash: sha256('aaa').slice(0, 12),
        }),
      /old_text must match exactly once \(found 2\)/,
    );
  });

  test('patch_file writes replacement text literally when new_text contains dollar sequences', async () => {
    const tools = await buildToolRegistry(tmpDir, { nativeToolLevel: 'L1' });
    const patch = findTool(tools, 'patch_file');
    const replacement = '$$HOME $& $1';
    writeFileSync(join(tmpDir, 'dollar.txt'), 'alpha');

    await patch.execute({
      path: 'dollar.txt',
      old_text: 'alpha',
      new_text: replacement,
      expected_hash: sha256('alpha').slice(0, 12),
    });

    assert.equal(readFileSync(join(tmpDir, 'dollar.txt'), 'utf-8'), replacement);
  });

  test('write_file rejects overwriting an existing file larger than the write cap', async () => {
    const audit = [];
    const tools = await buildToolRegistry(tmpDir, { nativeToolLevel: 'L1', audit: (event) => audit.push(event) });
    const write = findTool(tools, 'write_file');
    // Existing target is huge; the *new* content is tiny (so it clears the new-content cap)
    // — the guard must reject before hashing the multi-hundred-KiB old file.
    writeFileSync(join(tmpDir, 'huge-existing.txt'), 'x'.repeat(256 * 1024 + 10));

    await assert.rejects(
      () => write.execute({ path: 'huge-existing.txt', content: 'small' }),
      /existing file \(\d+ bytes\) exceeds write cap/,
    );
    assert.equal(audit.at(-1).outcome, 'rejected');
    assert.equal(audit.at(-1).tool, 'write_file');
  });

  test('patch_file rejects patching an existing file larger than the write cap', async () => {
    const tools = await buildToolRegistry(tmpDir, { nativeToolLevel: 'L1' });
    const patch = findTool(tools, 'patch_file');
    writeFileSync(join(tmpDir, 'huge-patch.txt'), 'x'.repeat(256 * 1024 + 10));

    await assert.rejects(
      () =>
        patch.execute({
          path: 'huge-patch.txt',
          old_text: 'x',
          new_text: 'y',
          expected_hash: 'deadbeef',
        }),
      /existing file \(\d+ bytes\) exceeds write cap/,
    );
  });

  test(
    'patch_file preserves the existing file mode across the atomic replace',
    { skip: process.platform === 'win32' },
    async () => {
      const tools = await buildToolRegistry(tmpDir, { nativeToolLevel: 'L1' });
      const patch = findTool(tools, 'patch_file');
      const scriptPath = join(tmpDir, 'run.sh');
      const before = '#!/bin/sh\necho hi\n';
      writeFileSync(scriptPath, before);
      chmodSync(scriptPath, 0o755);

      await patch.execute({
        path: 'run.sh',
        old_text: 'hi',
        new_text: 'bye',
        expected_hash: sha256(before).slice(0, 12),
      });

      assert.equal(readFileSync(scriptPath, 'utf-8'), '#!/bin/sh\necho bye\n');
      assert.equal(statSync(scriptPath).mode & 0o777, 0o755, 'executable bit must survive the patch');
    },
  );

  test(
    'write_file preserves the existing file mode when overwriting',
    { skip: process.platform === 'win32' },
    async () => {
      const tools = await buildToolRegistry(tmpDir, { nativeToolLevel: 'L1' });
      const write = findTool(tools, 'write_file');
      const scriptPath = join(tmpDir, 'overwrite.sh');
      writeFileSync(scriptPath, 'old\n');
      chmodSync(scriptPath, 0o750);

      await write.execute({ path: 'overwrite.sh', content: '#!/bin/sh\necho new\n' });

      assert.equal(statSync(scriptPath).mode & 0o777, 0o750, 'mode bits must survive the overwrite');
    },
  );

  test('patch_file rejects symlink targets', { skip: process.platform === 'win32' }, async () => {
    const audit = [];
    const tools = await buildToolRegistry(tmpDir, { nativeToolLevel: 'L1', audit: (event) => audit.push(event) });
    const patch = findTool(tools, 'patch_file');

    // Create a regular file and a symlink pointing to it.
    const realFile = join(tmpDir, 'real-target.txt');
    const linkPath = join(tmpDir, 'link-to-real.txt');
    writeFileSync(realFile, 'hello world');
    if (existsSync(linkPath)) rmSync(linkPath);
    symlinkSync(realFile, linkPath);

    await assert.rejects(
      () =>
        patch.execute({
          path: 'link-to-real.txt',
          old_text: 'hello',
          new_text: 'goodbye',
          expected_hash: sha256('hello world').slice(0, 12),
        }),
      /symlink/i,
    );
    assert.equal(audit.at(-1).outcome, 'rejected');
    assert.equal(audit.at(-1).tool, 'patch_file');
  });
});

describe('F2: run_command policy', () => {
  test('runs only policy-allowed structured argv', async () => {
    const audit = [];
    const tools = await buildToolRegistry(tmpDir, {
      nativeToolLevel: 'L2',
      commandPolicy: [
        {
          binary: process.execPath,
          allowedFlags: ['-e'],
          allowedArgPatterns: ['^console\\.log\\("ok"\\)$'],
        },
      ],
      audit: (event) => audit.push(event),
    });
    const run = findTool(tools, 'run_command');

    const result = await run.execute({ binary: process.execPath, args: ['-e', 'console.log("ok")'] });

    assert.ok(result.includes('exitCode: 0'));
    assert.ok(result.includes('ok'));
    assert.equal(audit[0].tool, 'run_command');
    assert.equal(audit[0].exitCode, 0);
    await assert.rejects(
      () => run.execute({ binary: process.execPath, args: ['-e', 'require("fs").readdirSync(".")'] }),
      /not allowed by command policy/,
    );
  });

  test('does not pass HOME to command env', async () => {
    const tools = await buildToolRegistry(tmpDir, {
      nativeToolLevel: 'L2',
      commandPolicy: [{ binary: 'env' }],
    });
    const run = findTool(tools, 'run_command');

    const result = await run.execute({ binary: 'env', args: [] });

    assert.ok(result.includes('PATH='));
    assert.ok(!result.includes('HOME='), 'HOME must not be present');
  });

  test('kills commands that exceed timeout', async () => {
    const tools = await buildToolRegistry(tmpDir, {
      nativeToolLevel: 'L2',
      commandTimeoutMs: 50,
      commandPolicy: [
        {
          binary: process.execPath,
          allowedFlags: ['-e'],
          allowedArgPatterns: ['^setTimeout'],
        },
      ],
    });
    const run = findTool(tools, 'run_command');

    await assert.rejects(
      () => run.execute({ binary: process.execPath, args: ['-e', 'setTimeout(() => {}, 500)'] }),
      /timed out/,
    );
  });

  test('kills commands that ignore SIGTERM after the grace window', async () => {
    const tools = await buildToolRegistry(tmpDir, {
      nativeToolLevel: 'L2',
      commandTimeoutMs: 50,
      commandKillGraceMs: 50,
      commandPolicy: [
        {
          binary: process.execPath,
          allowedFlags: ['-e'],
          allowedArgPatterns: ['^process\\.on\\("SIGTERM"'],
        },
      ],
    });
    const run = findTool(tools, 'run_command');

    await assert.rejects(
      () =>
        run.execute({
          binary: process.execPath,
          args: ['-e', 'process.on("SIGTERM", () => {}); setInterval(() => {}, 100);'],
        }),
      /timed out/,
    );
  });

  test(
    'timeout returns promptly even when grandchild holds inherited pipes',
    { skip: process.platform === 'win32' },
    async () => {
      const tools = await buildToolRegistry(tmpDir, {
        nativeToolLevel: 'L2',
        commandTimeoutMs: 50,
        commandKillGraceMs: 50,
        commandPolicy: [
          {
            binary: process.execPath,
            allowedFlags: ['-e'],
            allowedArgPatterns: ['^const'],
          },
        ],
      });
      const run = findTool(tools, 'run_command');
      // The parent node process spawns a detached grandchild that inherits
      // stdio and sleeps for 5 seconds. Without pipe cleanup, the execFile
      // callback would hang until the grandchild exits (5s), violating the
      // 50ms timeout contract.
      const script = [
        'const{execFile}=require("child_process");',
        'execFile(process.execPath,["-e","setInterval(()=>{},100)"],{stdio:"inherit"});',
        'setInterval(()=>{},100);',
      ].join('');
      const start = Date.now();
      await assert.rejects(() => run.execute({ binary: process.execPath, args: ['-e', script] }), /timed out/);
      const elapsed = Date.now() - start;
      // Should settle within ~500ms (timeout + grace + OS overhead), not 5+ seconds.
      assert.ok(elapsed < 1000, `Elapsed ${elapsed}ms — expected < 1000ms; pipe cleanup may have failed`);
    },
  );
});

describe('F1: CAS atomicity', () => {
  test('concurrent patches on the same path are serialized by the path lock', async () => {
    const tools = await buildToolRegistry(tmpDir, { nativeToolLevel: 'L1' });
    const patch = findTool(tools, 'patch_file');
    const target = join(tmpDir, 'cas-test.txt');
    writeFileSync(target, 'alpha beta gamma');
    const initialHash = sha256('alpha beta gamma').slice(0, 12);

    // Launch two concurrent patches that both target the same text.
    // Without the lock, both would read the same content and the second
    // rename would silently overwrite the first. With the lock, the second
    // patch should fail with expected_hash mismatch because the first patch
    // changed the file.
    const results = await Promise.allSettled([
      patch.execute({ path: 'cas-test.txt', old_text: 'alpha', new_text: 'ALPHA', expected_hash: initialHash }),
      patch.execute({ path: 'cas-test.txt', old_text: 'beta', new_text: 'BETA', expected_hash: initialHash }),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    // Exactly one should succeed, the other should fail with hash mismatch.
    assert.equal(fulfilled.length, 1, `Expected 1 fulfilled, got ${fulfilled.length}`);
    assert.equal(rejected.length, 1, `Expected 1 rejected, got ${rejected.length}`);
    assert.ok(rejected[0].reason.message.includes('expected_hash mismatch'));
  });
});

describe('F3-min: host-native scoped callback tool', () => {
  test('does not register update_current_task_status without current task scope', async () => {
    const tools = await buildToolRegistry(undefined, { nativeToolLevel: 'L1' });
    assert.equal(findTool(tools, 'update_current_task_status'), undefined);
  });

  test('updates only current task controlled fields and audits changedFields', async () => {
    const updates = [];
    const audit = [];
    const tools = await buildToolRegistry(undefined, {
      nativeToolLevel: 'L1',
      audit: (event) => audit.push(event),
      scopedCallbacks: {
        currentTask: {
          invocationId: 'inv-1',
          currentTaskId: 'task-1',
          updateCurrentTaskStatus: async (patch) => {
            updates.push(patch);
          },
        },
      },
    });
    const update = findTool(tools, 'update_current_task_status');
    assert.ok(update);

    const result = await update.execute({ status: 'doing', progress: 50, summary: 'halfway' });
    assert.ok(result.includes('Updated current task'));
    assert.deepEqual(updates, [{ status: 'doing', progress: 50, summary: 'halfway' }]);
    assert.equal(audit[0].tool, 'update_current_task_status');
    assert.equal(audit[0].invocationId, 'inv-1');
    assert.equal(audit[0].currentTaskId, 'task-1');
    assert.deepEqual(audit[0].changedFields, ['status', 'progress', 'summary']);

    const forbidden = await executeCatAgentTools(
      [{ id: 'tu-forbidden', type: 'tool_use', name: 'update_current_task_status', input: { taskId: 'other' } }],
      tools,
    );
    assert.equal(forbidden[0].status, 'error');
    assert.ok(forbidden[0].content.includes('undeclared field "taskId"'));
  });
});
