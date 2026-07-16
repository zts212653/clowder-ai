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

function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(predicate, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return predicate();
}

function processTreeScript(markerPath) {
  return [
    'const{spawn}=require("node:child_process");',
    'const{writeFileSync}=require("node:fs");',
    'const child=spawn(process.execPath,["-e","setInterval(()=>{},100)"],{stdio:"inherit"});',
    `writeFileSync(${JSON.stringify(markerPath)},String(child.pid));`,
    'setInterval(()=>{},100);',
  ].join('');
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

  test('rejects command output above the 512 KiB buffer cap', async () => {
    const audit = [];
    const tools = await buildToolRegistry(tmpDir, {
      nativeToolLevel: 'L2',
      commandKillGraceMs: 50,
      commandPolicy: [
        {
          binary: process.execPath,
          allowedFlags: ['-e'],
          allowedArgPatterns: ['^process\\.stdout\\.write'],
        },
      ],
      audit: (event) => audit.push(event),
    });
    const run = findTool(tools, 'run_command');

    await assert.rejects(() =>
      run.execute({ binary: process.execPath, args: ['-e', 'process.stdout.write("x".repeat(512*1024+1))'] }),
    );
    assert.equal(audit.at(-1).outcome, 'error');
    assert.match(audit.at(-1).rejectReason, /maxBuffer length exceeded/);
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
      // The parent process spawns a long-lived grandchild that inherits its
      // stdio. The timeout must terminate the whole process tree, not merely
      // close the direct child's pipes and orphan the grandchild.
      const marker = join(tmpDir, 'timeout-grandchild.pid');
      rmSync(marker, { force: true });
      let grandchildPid;
      const start = Date.now();
      try {
        await assert.rejects(
          () => run.execute({ binary: process.execPath, args: ['-e', processTreeScript(marker)] }),
          /timed out/,
        );
        const elapsed = Date.now() - start;
        assert.ok(elapsed < 1_000, `Elapsed ${elapsed}ms — expected < 1000ms`);
        assert.ok(await waitFor(() => existsSync(marker)), 'grandchild PID marker was not created');
        grandchildPid = Number.parseInt(readFileSync(marker, 'utf-8'), 10);
        assert.ok(Number.isSafeInteger(grandchildPid) && grandchildPid > 0, 'invalid grandchild PID');
        assert.ok(
          await waitFor(() => !isPidAlive(grandchildPid)),
          `grandchild ${grandchildPid} survived command timeout`,
        );
      } finally {
        if (grandchildPid && isPidAlive(grandchildPid)) {
          process.kill(grandchildPid, 'SIGKILL');
        }
      }
    },
  );

  test('invocation abort terminates an active run_command process tree promptly', async () => {
    const controller = new AbortController();
    const tools = await buildToolRegistry(tmpDir, {
      nativeToolLevel: 'L2',
      signal: controller.signal,
      commandTimeoutMs: 1_000,
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
    const marker = join(tmpDir, 'abort-grandchild.pid');
    rmSync(marker, { force: true });
    let grandchildPid;
    const runPromise = run.execute({ binary: process.execPath, args: ['-e', processTreeScript(marker)] });

    try {
      assert.ok(await waitFor(() => existsSync(marker)), 'grandchild PID marker was not created');
      grandchildPid = Number.parseInt(readFileSync(marker, 'utf-8'), 10);
      assert.ok(Number.isSafeInteger(grandchildPid) && grandchildPid > 0, 'invalid grandchild PID');

      const abortStarted = Date.now();
      controller.abort();
      await assert.rejects(runPromise, (err) => err?.name === 'AbortError');
      assert.ok(Date.now() - abortStarted < 500, 'aborted run_command did not settle promptly');
      assert.ok(
        await waitFor(() => !isPidAlive(grandchildPid)),
        `grandchild ${grandchildPid} survived invocation abort`,
      );
    } finally {
      controller.abort();
      await runPromise.catch(() => undefined);
      if (grandchildPid && isPidAlive(grandchildPid)) {
        process.kill(grandchildPid, 'SIGKILL');
      }
    }
  });
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

  test('symlinked parent aliases share the same CAS lock', { skip: process.platform === 'win32' }, async () => {
    const tools = await buildToolRegistry(tmpDir, { nativeToolLevel: 'L1' });
    const patch = findTool(tools, 'patch_file');
    const realDir = join(tmpDir, 'cas-real');
    const linkDir = join(tmpDir, 'cas-link');
    mkdirSync(realDir, { recursive: true });
    rmSync(linkDir, { force: true });
    symlinkSync(realDir, linkDir, 'dir');
    writeFileSync(join(realDir, 'shared.txt'), 'alpha beta gamma');
    const initialHash = sha256('alpha beta gamma').slice(0, 12);

    const results = await Promise.allSettled([
      patch.execute({ path: 'cas-real/shared.txt', old_text: 'alpha', new_text: 'ALPHA', expected_hash: initialHash }),
      patch.execute({ path: 'cas-link/shared.txt', old_text: 'beta', new_text: 'BETA', expected_hash: initialHash }),
    ]);

    const fulfilled = results.filter((result) => result.status === 'fulfilled');
    const rejected = results.filter((result) => result.status === 'rejected');
    assert.equal(fulfilled.length, 1, `Expected 1 fulfilled, got ${fulfilled.length}`);
    assert.equal(rejected.length, 1, `Expected 1 rejected, got ${rejected.length}`);
    assert.match(rejected[0].reason.message, /expected_hash mismatch/);
  });
});

describe('tool dispatch cancellation and rejection audit', () => {
  const noInputSchema = {
    name: 'first_tool',
    description: 'test tool',
    input_schema: { type: 'object', properties: {}, required: [] },
  };

  test('aborting between tool calls prevents subsequent tool execution', async () => {
    const controller = new AbortController();
    let secondExecutions = 0;
    const tools = [
      {
        schema: noInputSchema,
        permission: 'allow',
        execute: async () => {
          controller.abort();
          return 'first completed';
        },
      },
      {
        schema: { ...noInputSchema, name: 'second_tool' },
        permission: 'allow',
        execute: async () => {
          secondExecutions++;
          return 'second completed';
        },
      },
    ];

    await assert.rejects(
      () =>
        executeCatAgentTools(
          [
            { id: 'first', type: 'tool_call', name: 'first_tool', input: {} },
            { id: 'second', type: 'tool_call', name: 'second_tool', input: {} },
          ],
          tools,
          { signal: controller.signal },
        ),
      (err) => err?.name === 'AbortError',
    );
    assert.equal(secondExecutions, 0);
  });

  test('unknown tools and schema-invalid inputs emit rejected audit events', async () => {
    const audit = [];
    let executions = 0;
    const tools = [
      {
        schema: {
          name: 'write_file',
          description: 'test tool',
          input_schema: {
            type: 'object',
            properties: { path: { type: 'string' }, content: { type: 'string' } },
            required: ['path', 'content'],
          },
        },
        permission: 'allow',
        execute: async () => {
          executions++;
          return 'unexpected';
        },
      },
    ];

    const results = await executeCatAgentTools(
      [
        { id: 'unknown', type: 'tool_call', name: 'unknown_tool', input: {} },
        { id: 'invalid', type: 'tool_call', name: 'write_file', input: { path: 'x.txt' } },
      ],
      tools,
      { audit: (event) => audit.push(event) },
    );

    assert.deepEqual(
      results.map((result) => result.status),
      ['error', 'error'],
    );
    assert.equal(executions, 0);
    assert.equal(audit.length, 2);
    assert.deepEqual(
      audit.map((event) => [event.tool, event.outcome]),
      [
        ['unknown_tool', 'rejected'],
        ['write_file', 'rejected'],
      ],
    );
    assert.match(audit[0].rejectReason, /unknown tool/);
    assert.match(audit[1].rejectReason, /required field "content" is missing/);
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

describe('audit-after-mutation honesty (commitThenAudit)', () => {
  test('write_file returns success with audit-degraded annotation when audit sink throws', async () => {
    const target = join(tmpDir, 'audit-degraded-write.txt');
    const tools = await buildToolRegistry(tmpDir, {
      nativeToolLevel: 'L1',
      audit: () => {
        throw new Error('audit down');
      },
    });
    const write = findTool(tools, 'write_file');
    assert.ok(write);
    const result = await write.execute({ path: 'audit-degraded-write.txt', content: 'hello' });
    // Mutation committed — result must be success, not an error
    assert.ok(result.includes('Wrote'));
    assert.ok(result.includes('[audit-degraded'));
    // File must exist — the mutation really committed
    const content = readFileSync(target, 'utf-8');
    assert.equal(content, 'hello');
  });

  test('patch_file returns success with audit-degraded annotation when audit sink throws', async () => {
    const target = join(tmpDir, 'audit-degraded-patch.txt');
    writeFileSync(target, 'original', 'utf-8');
    const hash = sha256('original');
    const tools = await buildToolRegistry(tmpDir, {
      nativeToolLevel: 'L1',
      audit: () => {
        throw new Error('audit down');
      },
    });
    const patch = findTool(tools, 'patch_file');
    assert.ok(patch);
    const result = await patch.execute({
      path: 'audit-degraded-patch.txt',
      old_text: 'original',
      new_text: 'patched',
      expected_hash: hash.slice(0, 12),
    });
    assert.ok(result.includes('Patched'));
    assert.ok(result.includes('[audit-degraded'));
    const content = readFileSync(target, 'utf-8');
    assert.equal(content, 'patched');
  });

  test('update_current_task_status returns success with audit-degraded when audit throws', async () => {
    const updates = [];
    const tools = await buildToolRegistry(undefined, {
      nativeToolLevel: 'L1',
      audit: () => {
        throw new Error('audit down');
      },
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
    const result = await update.execute({ status: 'done' });
    assert.ok(result.includes('Updated current task'));
    assert.ok(result.includes('[audit-degraded'));
    // Mutation committed
    assert.deepEqual(updates, [{ status: 'done' }]);
  });

  test('run_command returns success with audit-degraded annotation when audit sink throws', async () => {
    let auditCallCount = 0;
    const tools = await buildToolRegistry(tmpDir, {
      nativeToolLevel: 'L2',
      commandPolicy: [{ binary: 'env' }],
      audit: () => {
        auditCallCount++;
        // Only throw on the success audit (after command completes),
        // not on the policy-resolved audit or other pre-execution audits.
        if (auditCallCount > 0) throw new Error('audit down');
      },
    });
    const run = findTool(tools, 'run_command');
    assert.ok(run);
    const result = await run.execute({ binary: 'env', args: [] });
    // Command already executed — result must be success, not an error
    assert.ok(typeof result === 'string' && result.length > 0, 'command output must be present');
    assert.ok(result.includes('[audit-degraded'), 'must annotate audit degradation');
  });
});

// ── Non-regular file rejection (FIFO/device safety) ──
// POSIX-only: mkfifo is not available on Windows.
// Bounded-failure: each tool call races against a short deadline so that
// a guard regression (readFile blocking on FIFO) produces a deterministic
// test failure rather than hanging CI until the job timeout.
const IS_POSIX = process.platform !== 'win32';
const FIFO_DEADLINE_MS = 5_000;

/** Race a promise against a deadline — rejects with a clear message on timeout. */
function withFifoDeadline(promise, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label}: blocked >${FIFO_DEADLINE_MS}ms — !isFile() guard likely regressed`)),
      FIFO_DEADLINE_MS,
    );
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

describe('F1: non-regular file rejection', { skip: !IS_POSIX && 'POSIX-only (mkfifo)' }, () => {
  let fifoPath;

  before(async () => {
    fifoPath = join(tmpDir, 'test-fifo');
    const { execFileSync } = await import('node:child_process');
    try {
      execFileSync('mkfifo', [fifoPath]);
    } catch {
      // If mkfifo not available, tests will be skipped via the POSIX guard
    }
  });

  after(() => {
    try {
      rmSync(fifoPath, { force: true });
    } catch {
      /* best-effort */
    }
  });

  test('write_file rejects FIFO target without blocking', async () => {
    const tools = await buildToolRegistry(tmpDir, { nativeToolLevel: 'L1' });
    const write = findTool(tools, 'write_file');
    assert.ok(write);
    await assert.rejects(
      () =>
        withFifoDeadline(
          write.execute({ path: 'test-fifo', content: 'should not write' }),
          'write_file FIFO rejection',
        ),
      (err) => err.message.includes('non-regular file'),
    );
  });

  test('patch_file rejects FIFO target without blocking', async () => {
    const tools = await buildToolRegistry(tmpDir, { nativeToolLevel: 'L1' });
    const patch = findTool(tools, 'patch_file');
    assert.ok(patch);
    await assert.rejects(
      () =>
        withFifoDeadline(
          patch.execute({ path: 'test-fifo', old_text: 'x', new_text: 'y', expected_hash: 'abcdef01' }),
          'patch_file FIFO rejection',
        ),
      (err) => err.message.includes('non-regular file'),
    );
  });
});
