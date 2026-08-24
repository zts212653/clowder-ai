import { describe, expect, it } from 'vitest';
import {
  buildInvocationTimelineRows,
  rankInvocationSummariesForRecall,
  reconcileInvocationSummary,
} from '../invocation-trajectory-model';

function rawEvent(eventNo: number, event: Record<string, unknown>) {
  return {
    v: 1,
    t: 1_000 + eventNo,
    threadId: 'thread-f299',
    catId: 'codex-sol',
    sessionId: 'session-f299',
    invocationId: 'inv-large',
    eventNo,
    event,
  };
}

describe('F299 invocation trajectory primary projection', () => {
  it('folds the 923-event production shape into at most 15 first-screen rows', () => {
    const events = [];
    let eventNo = 0;
    events.push(rawEvent(eventNo++, { type: 'session_init', sessionId: 'cli-1' }));
    for (let i = 0; i < 870; i += 1) events.push(rawEvent(eventNo++, { type: 'status', content: `step ${i}` }));
    for (let i = 0; i < 23; i += 1) {
      events.push(rawEvent(eventNo++, { type: 'tool_use', toolName: `Tool${i}`, toolUseId: `tool-${i}` }));
      events.push(
        rawEvent(eventNo++, {
          type: 'tool_result',
          toolName: `Tool${i}`,
          toolUseId: `tool-${i}`,
          toolResultStatus: 'ok',
        }),
      );
    }
    for (let i = 0; i < 5; i += 1) events.push(rawEvent(eventNo++, { type: 'text', content: `message ${i}` }));
    events.push(rawEvent(eventNo++, { type: 'done' }));

    expect(events).toHaveLength(923);
    const projection = buildInvocationTimelineRows(events);
    expect(projection.visibleRows.length).toBeLessThanOrEqual(15);
    expect(projection.visibleRows.find((row) => row.kind === 'status-group')).toMatchObject({ count: 870 });
    expect(projection.totalEffectiveRows).toBeGreaterThan(projection.visibleRows.length);
    expect(projection.hiddenRowCount).toBeGreaterThan(0);
  });

  it('pairs tool use and result into one effective row', () => {
    const projection = buildInvocationTimelineRows([
      rawEvent(0, { type: 'tool_use', toolName: 'Read', toolUseId: 'tool-1', toolInput: { path: 'a.ts' } }),
      rawEvent(1, { type: 'tool_result', toolName: 'Read', toolUseId: 'tool-1', content: 'ok' }),
      rawEvent(2, { type: 'done' }),
    ]);
    expect(projection.allRows.filter((row) => row.kind === 'tool')).toHaveLength(1);
    expect(projection.allRows.find((row) => row.kind === 'tool')).toMatchObject({ toolName: 'Read', result: 'ok' });
  });

  it('consumes each unmatched tool only once even when a result has no display content', () => {
    const projection = buildInvocationTimelineRows([
      rawEvent(0, { type: 'tool_use', toolName: 'Read' }),
      rawEvent(1, { type: 'tool_result', toolName: 'Read' }),
      rawEvent(2, { type: 'tool_result', toolName: 'Read', content: 'second result' }),
    ]);
    expect(projection.allRows.filter((row) => row.kind === 'tool')).toHaveLength(2);
  });

  it('uses typed result provenance to complete an initially unknown tool without guessing invalid statuses', () => {
    const projection = buildInvocationTimelineRows([
      rawEvent(0, { type: 'tool_use', toolUseId: 'tool-typed' }),
      rawEvent(1, {
        type: 'tool_result',
        toolUseId: 'tool-typed',
        toolName: 'connector_action',
        toolSource: 'plugin_connector',
        toolChannel: 'final',
        toolResultStatus: 'success-ish',
        content: 'finished',
      }),
      rawEvent(2, { type: 'tool_result', toolName: 'legacy_action', is_error: false, content: 'ok' }),
    ]);

    expect(projection.allRows.filter((row) => row.kind === 'tool')).toEqual([
      expect.objectContaining({
        toolName: 'connector_action',
        source: 'plugin_connector',
        channel: 'final',
        resultStatus: 'unknown',
      }),
      expect.objectContaining({ toolName: 'legacy_action', resultStatus: 'ok' }),
    ]);
  });

  it('projects six honest semantic roles instead of a uniform MESSAGE row', () => {
    const projection = buildInvocationTimelineRows([
      rawEvent(0, { type: 'user', content: 'owner asks' }),
      rawEvent(1, { type: 'text', content: 'first ', textMode: 'append' }),
      rawEvent(2, { type: 'assistant', content: 'draft', textMode: 'replace' }),
      rawEvent(3, { type: 'text', content: ' answer', textMode: 'append' }),
      rawEvent(4, { type: 'system', content: 'runtime policy' }),
      rawEvent(5, { type: 'context', content: 'thread context' }),
      rawEvent(6, {
        type: 'tool_use',
        toolName: 'cat_cafe_get_thread_context',
        toolUseId: 'tool-semantic',
        toolSource: 'mcp',
        toolChannel: 'commentary',
      }),
      rawEvent(7, {
        type: 'tool_result',
        toolUseId: 'tool-semantic',
        toolResultStatus: 'ok',
        content: 'read complete',
      }),
      rawEvent(8, { type: 'error', error: 'provider failed' }),
    ]);

    expect(projection.allRows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'message', role: 'user', content: 'owner asks' }),
        expect.objectContaining({
          kind: 'message',
          role: 'assistant',
          content: 'draft answer',
          fragmentCount: 3,
          appendCount: 2,
          replaceCount: 1,
        }),
        expect.objectContaining({ kind: 'message', role: 'system', content: 'runtime policy' }),
        expect.objectContaining({ kind: 'message', role: 'context', content: 'thread context' }),
        expect.objectContaining({
          kind: 'tool',
          toolName: 'cat_cafe_get_thread_context',
          source: 'mcp',
          channel: 'commentary',
          resultStatus: 'ok',
        }),
        expect.objectContaining({ kind: 'error', content: 'provider failed' }),
      ]),
    );
  });

  it('never merges assistant fragments across tool, error, or turn boundaries and leaves Raw untouched', () => {
    const events = [
      rawEvent(0, { type: 'text', content: 'before tool' }),
      rawEvent(1, { type: 'tool_use', toolName: 'Read' }),
      rawEvent(2, { type: 'text', content: 'after tool' }),
      rawEvent(3, { type: 'error', error: 'boundary' }),
      rawEvent(4, { type: 'text', content: 'after error' }),
      rawEvent(5, { type: 'done' }),
      rawEvent(6, { type: 'text', content: 'after turn' }),
    ];
    const projection = buildInvocationTimelineRows(events);
    const assistantRows = projection.allRows.filter(
      (row): row is Extract<(typeof projection.allRows)[number], { kind: 'message' }> =>
        row.kind === 'message' && row.role === 'assistant',
    );

    expect(assistantRows.map((row) => row.content)).toEqual(['before tool', 'after tool', 'after error', 'after turn']);
    expect(events.map((event) => event.eventNo)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(events[0]?.event.content).toBe('before tool');
  });

  it('keeps head, tail, and late anomalies visible while folding the middle in place', () => {
    const events = Array.from({ length: 150 }, (_, index) =>
      index === 120
        ? rawEvent(index, {
            type: 'tool_result',
            toolName: 'command_execution',
            toolResultStatus: 'error',
            content: 'exit 1',
          })
        : rawEvent(index, { type: 'tool_use', toolName: `Tool${index}` }),
    );
    events.push(rawEvent(150, { type: 'done' }));

    const projection = buildInvocationTimelineRows(events, 15);

    expect(projection.visibleRows).toHaveLength(15);
    expect(projection.visibleRows[0]?.id).toBe('tool-0');
    expect(projection.visibleRows).toContainEqual(
      expect.objectContaining({ kind: 'tool', resultStatus: 'error', result: 'exit 1' }),
    );
    expect(projection.visibleRows.at(-1)).toMatchObject({ kind: 'terminal', content: 'done' });
    expect(projection.visibleRows).toContainEqual(
      expect.objectContaining({ kind: 'overflow', count: expect.any(Number), types: expect.any(Object) }),
    );
  });

  it('keeps header/list counts monotonic when detail already contains tools and messages', () => {
    const list = {
      invocationId: 'inv-counts',
      threadId: 'thread-f299',
      sessionId: 'session-f299',
      sessionSeq: 0,
      sessionStatus: 'active' as const,
      catId: 'codex-sol',
      status: 'running' as const,
      startedAt: 1_000,
      durationMs: 0,
      eventCount: 0,
      statusEventCount: 0,
      toolUseCount: 0,
      toolResultCount: 0,
      messageCount: 0,
      errorCount: 0,
      toolNames: [],
      keyMessages: [],
    };
    const detail = {
      ...list,
      durationMs: 20,
      eventCount: 3,
      toolUseCount: 1,
      toolResultCount: 1,
      messageCount: 1,
      toolNames: ['command_execution'],
      keyMessages: ['done'],
    };

    expect(reconcileInvocationSummary(list, detail)).toMatchObject({
      eventCount: 3,
      toolUseCount: 1,
      toolResultCount: 1,
      messageCount: 1,
      toolNames: ['command_execution'],
    });
  });

  it('puts abnormal recent invocations before healthy ones without exceeding three', () => {
    const ranked = rankInvocationSummariesForRecall([
      { invocationId: 'done-new', status: 'done', startedAt: 300 },
      { invocationId: 'timeout-old', status: 'timeout', startedAt: 100 },
      { invocationId: 'error-new', status: 'error', startedAt: 200 },
      { invocationId: 'done-old', status: 'done', startedAt: 50 },
    ]);
    expect(ranked.map((item) => item.invocationId)).toEqual(['error-new', 'timeout-old', 'done-new']);
  });
});
