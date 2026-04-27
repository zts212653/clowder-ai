/**
 * F118 Phase C — AC-C5: Finally Block Audit Fallback
 *
 * When a generator is force-returned (e.g. AbortController, client disconnect)
 * without the catch block firing, the finally block should write a fallback
 * CAT_ERROR audit entry to ensure no invocation goes unaudited.
 */

import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

let tempDir;
let invokeSingleCat;

describe('F118 finally block audit fallback (AC-C5)', () => {
  before(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'cat-finally-'));
    process.env.AUDIT_LOG_DIR = tempDir;
    const mod = await import('../dist/domains/cats/services/agents/invocation/invoke-single-cat.js');
    invokeSingleCat = mod.invokeSingleCat;
  });

  after(async () => {
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  function makeDeps() {
    let counter = 0;
    return {
      registry: {
        create: () => ({
          invocationId: `inv-finally-${++counter}`,
          callbackToken: `tok-${counter}`,
        }),
        verify: async () => ({ ok: false, reason: 'unknown_invocation' }),
      },
      sessionManager: {
        get: async () => undefined,
        getOrCreate: async () => ({}),
        store: async () => {},
        delete: async () => {},
        resolveWorkingDirectory: () => '/tmp/test',
      },
      threadStore: null,
      apiUrl: 'http://127.0.0.1:3004',
    };
  }

  it('writes fallback CAT_ERROR audit when generator is force-returned mid-stream', async () => {
    // Service that yields text slowly — we'll .return() the generator before it finishes
    let yieldCount = 0;
    const slowService = {
      async *invoke() {
        for (let i = 0; i < 100; i++) {
          yieldCount++;
          yield { type: 'text', catId: 'codex', content: `chunk-${i}`, timestamp: Date.now() };
          // Small delay to simulate streaming
          await new Promise((r) => setTimeout(r, 5));
        }
        yield { type: 'done', catId: 'codex', timestamp: Date.now() };
      },
    };

    const gen = invokeSingleCat(makeDeps(), {
      catId: 'codex',
      service: slowService,
      prompt: 'test-finally',
      userId: 'user1',
      threadId: 'thread-finally',
      isLastCat: true,
    });

    // Consume a few messages then force-return the generator
    const iter = gen[Symbol.asyncIterator]();
    // Read first few messages (invocation_created system_info + some text chunks)
    for (let i = 0; i < 5; i++) {
      await iter.next();
    }
    // Force-return — simulates client disconnect / AbortController
    await iter.return(undefined);

    // Wait for fire-and-forget audit writes
    await new Promise((r) => setTimeout(r, 200));

    // Read audit log and check for fallback CAT_ERROR
    const files = await readdir(tempDir);
    assert.ok(files.length > 0, 'audit log file should exist');

    const auditContent = await readFile(join(tempDir, files[0]), 'utf-8');
    const events = auditContent
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));

    const threadEvents = events.filter((e) => e.threadId === 'thread-finally');
    const catErrors = threadEvents.filter((e) => e.type === 'cat_error');

    assert.ok(catErrors.length > 0, 'should have fallback cat_error audit entry for force-returned generator');
    assert.ok(
      catErrors.some((e) => e.data?.error?.includes('generator_returned')),
      'cat_error should indicate generator was force-returned',
    );
  });

  it('does not double-write audit when catch block already wrote CAT_ERROR', async () => {
    const errorService = {
      async *invoke() {
        yield { type: 'error', catId: 'codex', error: 'CLI crashed', timestamp: Date.now() };
        throw new Error('CLI process exited with code 1');
      },
    };

    const msgs = [];
    try {
      for await (const msg of invokeSingleCat(makeDeps(), {
        catId: 'codex',
        service: errorService,
        prompt: 'test-no-double',
        userId: 'user1',
        threadId: 'thread-no-double',
        isLastCat: true,
      })) {
        msgs.push(msg);
      }
    } catch {
      // May throw if error propagates
    }

    // Wait for fire-and-forget audit writes
    await new Promise((r) => setTimeout(r, 200));

    const files = await readdir(tempDir);
    const auditContent = await readFile(join(tempDir, files[0]), 'utf-8');
    const events = auditContent
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));

    const threadEvents = events.filter((e) => e.threadId === 'thread-no-double');
    const catErrors = threadEvents.filter((e) => e.type === 'cat_error');

    // Should have exactly 1 cat_error (from catch block), not 2
    assert.equal(
      catErrors.length,
      1,
      `should have exactly 1 cat_error (not double-write), got ${catErrors.length}: ${JSON.stringify(catErrors.map((e) => e.data?.error))}`,
    );
  });
});
