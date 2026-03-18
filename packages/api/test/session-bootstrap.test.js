/**
 * SessionBootstrap Tests — F24 Phase E
 * Tests for bootstrap context injection when a cat starts Session #2+.
 *
 * IMPORTANT: SessionChainStore uses 0-based seq (first session = seq 0).
 * Bootstrap displays 1-based for humans (seq 0 → "Session #1", seq 1 → "Session #2").
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildSessionBootstrap } from '../dist/domains/cats/services/session/SessionBootstrap.js';

// --- Mock SessionChainStore ---

function createMockSessionChainStore(sessions = []) {
  return {
    getActive(catId, threadId) {
      return sessions.find((s) => s.catId === catId && s.threadId === threadId && s.status === 'active') ?? null;
    },
    getChain(catId, threadId) {
      return sessions.filter((s) => s.catId === catId && s.threadId === threadId).sort((a, b) => a.seq - b.seq);
    },
  };
}

// --- Mock TranscriptReader ---

function createMockTranscriptReader(digests = {}) {
  return {
    async readDigest(sessionId) {
      return digests[sessionId] ?? null;
    },
  };
}

// --- Mock TaskStore (F065) ---

function createMockTaskStore(tasks = []) {
  return {
    async listByThread(threadId) {
      return tasks.filter((t) => t.threadId === threadId);
    },
  };
}

describe('SessionBootstrap', () => {
  describe('buildSessionBootstrap', () => {
    it('returns null for first session (seq=0, no prior context)', async () => {
      const store = createMockSessionChainStore([
        { id: 'sess-0', catId: 'opus', threadId: 'thread-1', status: 'active', seq: 0 },
      ]);
      const reader = createMockTranscriptReader();

      const result = await buildSessionBootstrap(
        { sessionChainStore: store, transcriptReader: reader },
        'opus',
        'thread-1',
      );
      assert.equal(result, null);
    });

    it('returns bootstrap when no active session but sealed sessions exist (post-seal gap)', async () => {
      // P1-2 fix: after seal, active pointer is cleared but bootstrap should still work
      const store = createMockSessionChainStore([
        { id: 'sess-0', catId: 'opus', threadId: 'thread-1', status: 'sealed', seq: 0 },
      ]);
      const reader = createMockTranscriptReader();

      const result = await buildSessionBootstrap(
        { sessionChainStore: store, transcriptReader: reader },
        'opus',
        'thread-1',
      );
      assert.ok(result);
      assert.ok(result.text.includes('Session #2')); // next session after 1 sealed
      assert.ok(result.text.includes('1 previous session(s) are sealed'));
    });

    it('returns bootstrap with identity for second session (seq=1 → display #2)', async () => {
      const store = createMockSessionChainStore([
        { id: 'sess-0', catId: 'opus', threadId: 'thread-1', status: 'sealed', seq: 0 },
        { id: 'sess-1', catId: 'opus', threadId: 'thread-1', status: 'active', seq: 1 },
      ]);
      const reader = createMockTranscriptReader();

      const result = await buildSessionBootstrap(
        { sessionChainStore: store, transcriptReader: reader },
        'opus',
        'thread-1',
      );

      assert.ok(result);
      assert.equal(result.sessionSeq, 1); // raw 0-based seq
      assert.ok(result.text.includes('Session #2')); // display is 1-based
      assert.ok(result.text.includes('1 previous session(s) are sealed'));
    });

    it('includes previous session digest when available', async () => {
      const store = createMockSessionChainStore([
        { id: 'sess-0', catId: 'opus', threadId: 'thread-1', status: 'sealed', seq: 0 },
        { id: 'sess-1', catId: 'opus', threadId: 'thread-1', status: 'active', seq: 1 },
      ]);
      const reader = createMockTranscriptReader({
        'sess-0': {
          v: 1,
          sessionId: 'sess-0',
          threadId: 'thread-1',
          catId: 'opus',
          seq: 0,
          time: { createdAt: 1000000, sealedAt: 1060000 },
          invocations: [{ toolNames: ['Write', 'Edit'] }],
          filesTouched: [
            { path: 'src/index.ts', ops: ['edit'] },
            { path: 'src/new.ts', ops: ['create'] },
          ],
          errors: [],
        },
      });

      const result = await buildSessionBootstrap(
        { sessionChainStore: store, transcriptReader: reader },
        'opus',
        'thread-1',
      );

      assert.ok(result);
      assert.equal(result.hasDigest, true);
      assert.ok(result.text.includes('[Previous Session Summary]'));
      assert.ok(result.text.includes('Write, Edit'));
      assert.ok(result.text.includes('src/index.ts'));
      assert.ok(result.text.includes('src/new.ts'));
    });

    it('includes MCP tool recall instructions', async () => {
      const store = createMockSessionChainStore([
        { id: 'sess-0', catId: 'opus', threadId: 'thread-1', status: 'sealed', seq: 0 },
        { id: 'sess-1', catId: 'opus', threadId: 'thread-1', status: 'active', seq: 1 },
      ]);
      const reader = createMockTranscriptReader();

      const result = await buildSessionBootstrap(
        { sessionChainStore: store, transcriptReader: reader },
        'opus',
        'thread-1',
      );

      assert.ok(result);
      assert.ok(result.text.includes('cat_cafe_search_evidence'));
      assert.ok(result.text.includes('cat_cafe_read_session_digest'));
      assert.ok(result.text.includes('cat_cafe_read_session_events'));
      assert.ok(result.text.includes('Do NOT guess'));
    });

    it('handles digest read failure gracefully (still returns identity + tools)', async () => {
      const store = createMockSessionChainStore([
        { id: 'sess-0', catId: 'opus', threadId: 'thread-1', status: 'sealed', seq: 0 },
        { id: 'sess-1', catId: 'opus', threadId: 'thread-1', status: 'active', seq: 1 },
      ]);
      const reader = {
        async readDigest() {
          throw new Error('disk error');
        },
      };

      const result = await buildSessionBootstrap(
        { sessionChainStore: store, transcriptReader: reader },
        'opus',
        'thread-1',
      );

      assert.ok(result);
      assert.equal(result.hasDigest, false);
      assert.ok(result.text.includes('Session #2')); // seq=1 → display #2
      assert.ok(result.text.includes('cat_cafe_search_evidence')); // tools still present
    });

    it('correctly counts sealed sessions for Session #3+ (seq=2)', async () => {
      const store = createMockSessionChainStore([
        { id: 'sess-0', catId: 'opus', threadId: 'thread-1', status: 'sealed', seq: 0 },
        { id: 'sess-1', catId: 'opus', threadId: 'thread-1', status: 'sealed', seq: 1 },
        { id: 'sess-2', catId: 'opus', threadId: 'thread-1', status: 'active', seq: 2 },
      ]);
      const reader = createMockTranscriptReader();

      const result = await buildSessionBootstrap(
        { sessionChainStore: store, transcriptReader: reader },
        'opus',
        'thread-1',
      );

      assert.ok(result);
      assert.equal(result.sessionSeq, 2); // raw 0-based
      assert.ok(result.text.includes('Session #3')); // display 1-based
      assert.ok(result.text.includes('3 total sessions'));
      assert.ok(result.text.includes('2 previous session(s) are sealed'));
    });

    it('includes error count when digest has errors', async () => {
      const store = createMockSessionChainStore([
        { id: 'sess-0', catId: 'opus', threadId: 'thread-1', status: 'sealed', seq: 0 },
        { id: 'sess-1', catId: 'opus', threadId: 'thread-1', status: 'active', seq: 1 },
      ]);
      const reader = createMockTranscriptReader({
        'sess-0': {
          v: 1,
          sessionId: 'sess-0',
          threadId: 'thread-1',
          catId: 'opus',
          seq: 0,
          time: { createdAt: 1000000, sealedAt: 1300000 },
          invocations: [],
          filesTouched: [],
          errors: [
            { at: 1100000, message: 'Build failed: missing module' },
            { at: 1200000, message: 'Test assertion error' },
          ],
        },
      });

      const result = await buildSessionBootstrap(
        { sessionChainStore: store, transcriptReader: reader },
        'opus',
        'thread-1',
      );

      assert.ok(result);
      assert.ok(result.text.includes('Errors encountered: 2'));
      assert.ok(result.text.includes('Build failed'));
    });

    it('uses sealing session as previous when most recent is sealing (R6 P1-2)', async () => {
      // When sess-1 is sealing (not yet sealed), bootstrap should use sess-1's digest,
      // not fall back to sess-0's stale digest
      const store = createMockSessionChainStore([
        { id: 'sess-0', catId: 'opus', threadId: 'thread-1', status: 'sealed', seq: 0 },
        { id: 'sess-1', catId: 'opus', threadId: 'thread-1', status: 'sealing', seq: 1 },
      ]);
      const readDigestCalls = [];
      const reader = {
        async readDigest(sessionId) {
          readDigestCalls.push(sessionId);
          return null;
        },
      };

      const result = await buildSessionBootstrap(
        { sessionChainStore: store, transcriptReader: reader },
        'opus',
        'thread-1',
      );

      assert.ok(result);
      // Should read sess-1 (sealing) digest, not sess-0 (sealed)
      assert.deepEqual(readDigestCalls, ['sess-1']);
      // 2 sessions completed (sealed + sealing)
      assert.ok(result.text.includes('2 previous session(s) are sealed'));
    });

    it('only reads digest from previous seq (seq-1), not older sessions', async () => {
      const readDigestCalls = [];
      const store = createMockSessionChainStore([
        { id: 'sess-0', catId: 'opus', threadId: 'thread-1', status: 'sealed', seq: 0 },
        { id: 'sess-1', catId: 'opus', threadId: 'thread-1', status: 'sealed', seq: 1 },
        { id: 'sess-2', catId: 'opus', threadId: 'thread-1', status: 'active', seq: 2 },
      ]);
      const reader = {
        async readDigest(sessionId) {
          readDigestCalls.push(sessionId);
          return null;
        },
      };

      await buildSessionBootstrap({ sessionChainStore: store, transcriptReader: reader }, 'opus', 'thread-1');

      // Should only read sess-1 digest (the most recent sealed session)
      assert.deepEqual(readDigestCalls, ['sess-1']);
    });

    // --- F065 Task Snapshot Tests ---

    it('includes task snapshot when taskStore is provided and tasks exist', async () => {
      const store = createMockSessionChainStore([
        { id: 'sess-0', catId: 'opus', threadId: 'thread-1', status: 'sealed', seq: 0 },
        { id: 'sess-1', catId: 'opus', threadId: 'thread-1', status: 'active', seq: 1 },
      ]);
      const reader = createMockTranscriptReader();
      const taskStore = createMockTaskStore([
        {
          id: 't1',
          threadId: 'thread-1',
          title: 'Build feature',
          ownerCatId: 'opus',
          status: 'doing',
          why: '',
          createdBy: 'user',
          createdAt: 1000,
          updatedAt: 2000,
        },
        {
          id: 't2',
          threadId: 'thread-1',
          title: 'Write tests',
          ownerCatId: 'opus',
          status: 'todo',
          why: '',
          createdBy: 'user',
          createdAt: 1000,
          updatedAt: 2000,
        },
      ]);

      const result = await buildSessionBootstrap(
        { sessionChainStore: store, transcriptReader: reader, taskStore },
        'opus',
        'thread-1',
      );

      assert.ok(result);
      assert.equal(result.hasTaskSnapshot, true);
      assert.ok(result.text.includes('[Task Snapshot'));
      assert.ok(result.text.includes('Build feature'));
      assert.ok(result.text.includes('1 doing'));
    });

    it('omits task snapshot when no tasks exist', async () => {
      const store = createMockSessionChainStore([
        { id: 'sess-0', catId: 'opus', threadId: 'thread-1', status: 'sealed', seq: 0 },
        { id: 'sess-1', catId: 'opus', threadId: 'thread-1', status: 'active', seq: 1 },
      ]);
      const reader = createMockTranscriptReader();
      const taskStore = createMockTaskStore([]);

      const result = await buildSessionBootstrap(
        { sessionChainStore: store, transcriptReader: reader, taskStore },
        'opus',
        'thread-1',
      );

      assert.ok(result);
      assert.equal(result.hasTaskSnapshot, false);
      assert.ok(!result.text.includes('[Task Snapshot'));
    });

    it('omits task snapshot when taskStore is not provided (backward compat)', async () => {
      const store = createMockSessionChainStore([
        { id: 'sess-0', catId: 'opus', threadId: 'thread-1', status: 'sealed', seq: 0 },
        { id: 'sess-1', catId: 'opus', threadId: 'thread-1', status: 'active', seq: 1 },
      ]);
      const reader = createMockTranscriptReader();

      const result = await buildSessionBootstrap(
        { sessionChainStore: store, transcriptReader: reader },
        'opus',
        'thread-1',
      );

      assert.ok(result);
      assert.equal(result.hasTaskSnapshot, false);
    });

    it('task snapshot handles taskStore error gracefully', async () => {
      const store = createMockSessionChainStore([
        { id: 'sess-0', catId: 'opus', threadId: 'thread-1', status: 'sealed', seq: 0 },
        { id: 'sess-1', catId: 'opus', threadId: 'thread-1', status: 'active', seq: 1 },
      ]);
      const reader = createMockTranscriptReader();
      const taskStore = {
        async listByThread() {
          throw new Error('redis down');
        },
      };

      const result = await buildSessionBootstrap(
        { sessionChainStore: store, transcriptReader: reader, taskStore },
        'opus',
        'thread-1',
      );

      assert.ok(result);
      assert.equal(result.hasTaskSnapshot, false);
      assert.ok(result.text.includes('Session #2')); // still works
    });

    // --- F065 MCP Tool Guidance Tests ---

    it('includes read_invocation_detail and view=handoff in tool guidance', async () => {
      const store = createMockSessionChainStore([
        { id: 'sess-0', catId: 'opus', threadId: 'thread-1', status: 'sealed', seq: 0 },
        { id: 'sess-1', catId: 'opus', threadId: 'thread-1', status: 'active', seq: 1 },
      ]);
      const reader = createMockTranscriptReader();

      const result = await buildSessionBootstrap(
        { sessionChainStore: store, transcriptReader: reader },
        'opus',
        'thread-1',
      );

      assert.ok(result);
      assert.ok(result.text.includes('cat_cafe_read_invocation_detail'));
      assert.ok(result.text.includes('view=handoff'));
    });

    // --- F065 Token Cap Regression Tests (AC-5) ---

    it('drops task snapshot before digest when token cap triggers (R5 P1-1)', async () => {
      const store = createMockSessionChainStore([
        { id: 'sess-0', catId: 'opus', threadId: 'thread-1', status: 'sealed', seq: 0 },
        { id: 'sess-1', catId: 'opus', threadId: 'thread-1', status: 'active', seq: 1 },
      ]);
      // 50 unique tools with 40-char padding → digest ≈ 1657 tokens (fits in 1864 budget alone)
      // Combined with task snapshot ≈ 1889 tokens (exceeds 1864 budget → task dropped first)
      const longToolDigest = {
        v: 1,
        sessionId: 'sess-0',
        threadId: 'thread-1',
        catId: 'opus',
        seq: 0,
        time: { createdAt: 1000000, sealedAt: 1060000 },
        invocations: [
          {
            toolNames: Array.from({ length: 50 }, (_, i) => `tool_cap_${'w'.repeat(40)}_${i}`),
          },
        ],
        filesTouched: Array.from({ length: 15 }, (_, i) => ({
          path: `src/${'nested/'.repeat(6)}file-${i}.ts`,
          ops: ['edit'],
        })),
        errors: [],
      };
      const reader = createMockTranscriptReader({ 'sess-0': longToolDigest });
      const tasks = Array.from({ length: 8 }, (_, i) => ({
        id: `t${i}`,
        threadId: 'thread-1',
        title: `Task ${i}: ${'DescriptionWord '.repeat(20)}`,
        ownerCatId: 'opus',
        status: 'doing',
        why: '',
        createdBy: 'user',
        createdAt: 1000,
        updatedAt: 2000,
      }));
      const taskStore = createMockTaskStore(tasks);

      const result = await buildSessionBootstrap(
        { sessionChainStore: store, transcriptReader: reader, taskStore },
        'opus',
        'thread-1',
      );

      assert.ok(result);
      // Task snapshot should be dropped first (lower priority)
      assert.equal(result.hasTaskSnapshot, false, 'task snapshot should be dropped first');
      // Digest should survive (higher priority than task)
      assert.equal(result.hasDigest, true, 'digest should survive when task is dropped');
      // Tools section must survive cap
      assert.ok(result.text.includes('cat_cafe_read_invocation_detail'), 'tools guidance must survive cap');
      assert.ok(result.text.includes('view=handoff'), 'view=handoff must survive cap');
      // Identity must survive
      assert.ok(result.text.includes('Session #2'), 'identity must survive cap');
    });

    it('enforces token cap — output <= MAX_BOOTSTRAP_TOKENS (2000)', async () => {
      const store = createMockSessionChainStore([
        { id: 'sess-0', catId: 'opus', threadId: 'thread-1', status: 'sealed', seq: 0 },
        { id: 'sess-1', catId: 'opus', threadId: 'thread-1', status: 'active', seq: 1 },
      ]);
      // 100 unique tools with 60-char padding → digest ≈ 2800+ tokens (exceeds budget alone)
      // Both digest and task should be dropped, leaving only identity + tools ≈ 213 tokens
      const hugeDigest = {
        v: 1,
        sessionId: 'sess-0',
        threadId: 'thread-1',
        catId: 'opus',
        seq: 0,
        time: { createdAt: 1000000, sealedAt: 1060000 },
        invocations: [
          {
            toolNames: Array.from({ length: 100 }, (_, i) => `MassiveTool_${'z'.repeat(60)}_${i}`),
          },
        ],
        filesTouched: Array.from({ length: 15 }, (_, i) => ({
          path: `src/${'deep/'.repeat(10)}module-${i}.ts`,
          ops: ['edit'],
        })),
        errors: Array.from({ length: 3 }, (_, i) => ({
          at: 1100000 + i * 1000,
          message: `Error ${i}: ${'W'.repeat(195)}`,
        })),
      };
      const reader = createMockTranscriptReader({ 'sess-0': hugeDigest });
      const tasks = Array.from({ length: 8 }, (_, i) => ({
        id: `t${i}`,
        threadId: 'thread-1',
        title: `Big task ${i} ${'Q'.repeat(60)}`,
        ownerCatId: 'opus',
        status: 'doing',
        why: '',
        createdBy: 'user',
        createdAt: 1000,
        updatedAt: 2000,
      }));
      const taskStore = createMockTaskStore(tasks);

      const { estimateTokens } = await import('../dist/utils/token-counter.js');

      const result = await buildSessionBootstrap(
        { sessionChainStore: store, transcriptReader: reader, taskStore },
        'opus',
        'thread-1',
      );

      assert.ok(result);
      const tokens = estimateTokens(result.text);
      assert.ok(tokens <= 2000, `Expected <= 2000 tokens, got ${tokens}`);
      // Both variable sections dropped when digest alone exceeds budget
      assert.equal(result.hasDigest, false, 'digest should be dropped when it alone exceeds budget');
      assert.equal(result.hasTaskSnapshot, false, 'task should be dropped when digest exceeds budget');
      // Tools section always survives
      assert.ok(result.text.includes('cat_cafe_read_invocation_detail'));
    });
  });
});
