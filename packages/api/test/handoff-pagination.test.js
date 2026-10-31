/**
 * Handoff Pagination Tests — P0 bug fix
 *
 * Bug: GET /api/sessions/:id/events?view=handoff paginates raw events FIRST,
 * then formats each page into invocation summaries. A single invocation
 * spanning >50 raw events gets split across pages, producing contradictory
 * partial summaries (page 1 shows inv-A with 0 tools, page 2 shows inv-A
 * again with different tools).
 *
 * Fix: For handoff view, read ALL events → group into invocation summaries →
 * paginate by raw-event budget (complete invocations only).
 * The external cursor remains a genuine raw eventNo — same as raw/chat views.
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';

describe('handoff view pagination', () => {
  let tmpDir;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'handoff-pagination-test-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  async function loadModules() {
    const { TranscriptWriter } = await import('../dist/domains/cats/services/session/TranscriptWriter.js');
    const { TranscriptReader } = await import('../dist/domains/cats/services/session/TranscriptReader.js');
    const { formatEventsHandoff } = await import('../dist/domains/cats/services/session/TranscriptFormatter.js');
    return { TranscriptWriter, TranscriptReader, formatEventsHandoff };
  }

  const SESSION_INFO = {
    sessionId: 'sess-handoff-page',
    threadId: 'thread-hp',
    catId: 'opus',
    cliSessionId: 'cli-hp',
    seq: 0,
  };

  /**
   * Creates a session with two invocations:
   * - inv-A: 60 events (text events 0-54, tool_use at 55, tool_result at 56, text 57-59)
   * - inv-B: 10 events (text 0-7, tool_use at 8, tool_result at 9)
   *
   * Total: 70 events. With default limit=50, page 1 only sees inv-A events 0-49
   * (missing the tool_use at event 55), and page 2 sees inv-A events 50-59 + inv-B.
   */
  async function createMultiInvocationSession(modules) {
    const { TranscriptWriter, TranscriptReader } = modules;
    const writer = new TranscriptWriter({ dataDir: tmpDir });
    const reader = new TranscriptReader({ dataDir: tmpDir });

    // Invocation A: 60 events
    for (let i = 0; i < 60; i++) {
      if (i === 55) {
        writer.appendEvent(
          SESSION_INFO,
          { type: 'tool_use', name: 'Edit', input: { file_path: '/src/app.ts' } },
          'inv-A',
        );
      } else if (i === 56) {
        writer.appendEvent(SESSION_INFO, { type: 'tool_result', content: 'File edited' }, 'inv-A');
      } else {
        writer.appendEvent(
          SESSION_INFO,
          { type: 'text', content: [{ type: 'text', text: `inv-A message ${i}` }] },
          'inv-A',
        );
      }
    }

    // Invocation B: 10 events
    for (let i = 0; i < 10; i++) {
      if (i === 8) {
        writer.appendEvent(
          SESSION_INFO,
          { type: 'tool_use', name: 'Read', input: { file_path: '/src/lib.ts' } },
          'inv-B',
        );
      } else if (i === 9) {
        writer.appendEvent(SESSION_INFO, { type: 'tool_result', content: 'File read' }, 'inv-B');
      } else {
        writer.appendEvent(
          SESSION_INFO,
          { type: 'text', content: [{ type: 'text', text: `inv-B message ${i}` }] },
          'inv-B',
        );
      }
    }

    await writer.flush(SESSION_INFO, { createdAt: 1000, sealedAt: 2000 });

    return { writer, reader };
  }

  describe('bug reproduction: raw-event pagination splits invocations', () => {
    test('page 1 of raw events produces partial inv-A summary missing tool calls', async () => {
      const modules = await loadModules();
      const { reader, formatEventsHandoff } = {
        ...(await createMultiInvocationSession(modules)),
        formatEventsHandoff: modules.formatEventsHandoff,
      };

      // Simulate current (buggy) behavior: paginate raw events first
      const page1 = await reader.readEvents('sess-handoff-page', 'thread-hp', 'opus', undefined, 50);
      const summaries1 = formatEventsHandoff(page1.events);

      // Bug: inv-A appears with only 50 events and NO tool calls (Edit is at event 55)
      const invA_page1 = summaries1.find((s) => s.invocationId === 'inv-A');
      assert.ok(invA_page1, 'inv-A should appear in page 1');
      assert.equal(invA_page1.eventCount, 50, 'Only first 50 events of inv-A seen');
      assert.equal(invA_page1.toolCalls.length, 0, 'BUG: Edit tool call is missing (at event 55)');

      // Page 2 shows inv-A AGAIN with the remaining events
      const page2 = await reader.readEvents('sess-handoff-page', 'thread-hp', 'opus', page1.nextCursor, 50);
      const summaries2 = formatEventsHandoff(page2.events);
      const invA_page2 = summaries2.find((s) => s.invocationId === 'inv-A');
      assert.ok(invA_page2, 'BUG: inv-A appears AGAIN in page 2 — contradictory summary');
      assert.deepEqual(invA_page2.toolCalls, ['Edit'], 'Page 2 shows Edit but page 1 did not');
    });
  });

  describe('fix: readEventsHandoff paginates complete invocations', () => {
    test('each invocation appears exactly once with complete data', async () => {
      const modules = await loadModules();
      const { reader } = await createMultiInvocationSession(modules);

      // New method: reads all events, groups by invocation, paginates by event budget.
      // limit=100 is large enough to fit all 70 events in one page.
      const result = await reader.readEventsHandoff(
        'sess-handoff-page',
        'thread-hp',
        'opus',
        undefined,
        100, // event budget: fits both invocations (70 total events)
      );

      assert.equal(result.invocations.length, 2, 'Should have exactly 2 invocations');
      assert.equal(result.total, 70, 'Total should be raw event count');

      const invA = result.invocations.find((s) => s.invocationId === 'inv-A');
      assert.ok(invA, 'inv-A should be present');
      assert.equal(invA.eventCount, 60, 'inv-A should have all 60 events');
      assert.deepEqual(invA.toolCalls, ['Edit'], 'inv-A should include Edit tool call');

      const invB = result.invocations.find((s) => s.invocationId === 'inv-B');
      assert.ok(invB, 'inv-B should be present');
      assert.equal(invB.eventCount, 10, 'inv-B should have all 10 events');
      assert.deepEqual(invB.toolCalls, ['Read'], 'inv-B should include Read tool call');
    });

    test('paginates by raw-event budget with genuine eventNo cursor', async () => {
      const modules = await loadModules();
      const { reader } = await createMultiInvocationSession(modules);

      // limit=50 event budget: inv-A has 60 events → overflows but at least 1 complete summary
      const page1 = await reader.readEventsHandoff('sess-handoff-page', 'thread-hp', 'opus', undefined, 50);

      assert.equal(page1.invocations.length, 1, 'Page 1 should have 1 invocation (inv-A overflows budget)');
      assert.equal(page1.invocations[0].invocationId, 'inv-A', 'First invocation should be inv-A');
      assert.equal(page1.invocations[0].eventCount, 60, 'inv-A complete with 60 events');
      assert.deepEqual(page1.invocations[0].toolCalls, ['Edit']);
      assert.ok(page1.nextCursor, 'Should have nextCursor for page 2');
      assert.equal(page1.nextCursor.eventNo, 60, 'nextCursor.eventNo = first eventNo of inv-B');
      assert.equal(page1.total, 70, 'Total is raw event count');

      // Page 2 with cursor from page 1
      const page2 = await reader.readEventsHandoff('sess-handoff-page', 'thread-hp', 'opus', page1.nextCursor, 50);

      assert.equal(page2.invocations.length, 1, 'Page 2 should have 1 invocation');
      assert.equal(page2.invocations[0].invocationId, 'inv-B', 'Second invocation should be inv-B');
      assert.equal(page2.invocations[0].eventCount, 10);
      assert.deepEqual(page2.invocations[0].toolCalls, ['Read']);
      assert.equal(page2.nextCursor, undefined, 'No more pages');
      assert.equal(page2.total, 70);
    });

    test('mid-invocation cursor returns the containing invocation (regression)', async () => {
      const modules = await loadModules();
      const { reader } = await createMultiInvocationSession(modules);

      // cursor=55 falls inside inv-A (events 0-59).
      // Must return complete inv-A, NOT skip to inv-B (firstEventNo=60).
      const result = await reader.readEventsHandoff('sess-handoff-page', 'thread-hp', 'opus', { eventNo: 55 }, 50);

      assert.equal(result.invocations.length, 1, 'Should return inv-A (contains cursor eventNo 55)');
      assert.equal(result.invocations[0].invocationId, 'inv-A');
      assert.equal(result.invocations[0].eventCount, 60, 'inv-A complete with all 60 events');
      assert.deepEqual(result.invocations[0].toolCalls, ['Edit']);
      assert.ok(result.nextCursor, 'Should have nextCursor for inv-B');
      assert.equal(result.nextCursor.eventNo, 60, 'nextCursor points to inv-B firstEventNo');
      assert.equal(result.total, 70);
    });

    test('returns empty for nonexistent session', async () => {
      const modules = await loadModules();
      const reader = new modules.TranscriptReader({ dataDir: tmpDir });

      const result = await reader.readEventsHandoff('nonexistent', 'thread-hp', 'opus');
      assert.equal(result.invocations.length, 0);
      assert.equal(result.total, 0);
    });
  });
});
