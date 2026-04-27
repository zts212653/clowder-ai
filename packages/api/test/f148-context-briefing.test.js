// @ts-check
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

const { formatContextBriefing, buildBriefingMessage } = await import(
  '../dist/domains/cats/services/agents/routing/format-briefing.js'
);

describe('F148 Phase E: formatContextBriefing (AC-E3 + AC-E4)', () => {
  test('returns summary with all counts (AC-E3)', () => {
    const coverageMap = {
      omitted: {
        count: 22,
        timeRange: { from: 1712000000000, to: 1712003600000 },
        participants: ['opus', 'codex'],
      },
      burst: { count: 8, timeRange: { from: 1712003600000, to: 1712004000000 } },
      anchorIds: ['a1', 'a2', 'a3'],
      threadMemory: { available: true, sessionsIncorporated: 5 },
      retrievalHints: ['search_evidence("redis")'],
    };
    const result = formatContextBriefing(coverageMap);
    // One-line summary must include key counts
    assert.ok(result.summary.includes('8'), 'summary should include burst count (看到)');
    assert.ok(result.summary.includes('22'), 'summary should include omitted count (省略)');
    assert.ok(result.summary.includes('3'), 'summary should include anchor count');
    assert.ok(result.summary.includes('5'), 'summary should include session count');
    // Rich block
    assert.equal(result.richBlock.type, 'context-briefing');
    assert.deepEqual(result.richBlock.coverageMap, coverageMap);
  });

  test('handles zero omitted gracefully', () => {
    const coverageMap = {
      omitted: { count: 0, timeRange: { from: 0, to: 0 }, participants: [] },
      burst: { count: 5, timeRange: { from: 1712003600000, to: 1712004000000 } },
      anchorIds: [],
      threadMemory: null,
      retrievalHints: [],
    };
    const result = formatContextBriefing(coverageMap);
    assert.ok(result.summary.includes('5'), 'burst count present');
    assert.ok(result.summary.includes('0'), 'omitted count present');
    assert.strictEqual(result.richBlock.threadMemorySummary, undefined);
  });

  test('includes threadMemorySummary when provided', () => {
    const coverageMap = {
      omitted: { count: 10, timeRange: { from: 1712000000000, to: 1712003600000 }, participants: ['opus'] },
      burst: { count: 4, timeRange: { from: 1712003600000, to: 1712004000000 } },
      anchorIds: ['a1'],
      threadMemory: { available: true, sessionsIncorporated: 3 },
      retrievalHints: [],
    };
    const threadMemorySummary = 'Session #1: Created routes.ts. Modified index.ts.';
    const result = formatContextBriefing(coverageMap, threadMemorySummary);
    assert.equal(result.richBlock.threadMemorySummary, threadMemorySummary);
  });

  test('includes anchorSummaries when provided', () => {
    const coverageMap = {
      omitted: { count: 15, timeRange: { from: 1712000000000, to: 1712003600000 }, participants: ['opus'] },
      burst: { count: 6, timeRange: { from: 1712003600000, to: 1712004000000 } },
      anchorIds: ['a1', 'a2'],
      threadMemory: null,
      retrievalHints: [],
    };
    const anchorSummaries = ['[Thread opener] discussed Redis config', '[Anchor] decided on cluster mode'];
    const result = formatContextBriefing(coverageMap, undefined, anchorSummaries);
    assert.deepEqual(result.richBlock.anchorSummaries, anchorSummaries);
  });

  test('summary includes evidence count from retrievalHints', () => {
    const coverageMap = {
      omitted: { count: 20, timeRange: { from: 1712000000000, to: 1712003600000 }, participants: [] },
      burst: { count: 4, timeRange: { from: 1712003600000, to: 1712004000000 } },
      anchorIds: [],
      threadMemory: null,
      retrievalHints: ['search_evidence("redis")', 'search_evidence("deploy")'],
    };
    const result = formatContextBriefing(coverageMap);
    assert.ok(result.summary.includes('2'), 'summary should include evidence/hint count');
  });
});

describe('F148 Phase E: buildBriefingMessage (AC-E1)', () => {
  const baseCoverageMap = {
    omitted: {
      count: 22,
      timeRange: { from: 1712000000000, to: 1712003600000 },
      participants: ['opus', 'codex'],
    },
    burst: { count: 8, timeRange: { from: 1712003600000, to: 1712004000000 } },
    anchorIds: ['a1', 'a2', 'a3'],
    threadMemory: { available: true, sessionsIncorporated: 5 },
    retrievalHints: ['search_evidence("redis")'],
  };

  test('returns AppendMessageInput with origin=briefing', () => {
    const msg = buildBriefingMessage(baseCoverageMap, 'thread-1');
    assert.equal(msg.origin, 'briefing', 'must have origin=briefing');
    assert.equal(msg.catId, null, 'briefing is system-generated, catId=null');
    assert.equal(msg.userId, 'system', 'userId should be system');
    assert.equal(msg.threadId, 'thread-1');
    assert.ok(msg.content.includes('真相源'), 'content is the navigation summary');
  });

  test('has rich block with card kind', () => {
    const msg = buildBriefingMessage(baseCoverageMap, 'thread-1');
    assert.ok(msg.extra?.rich?.blocks?.length > 0, 'should have rich blocks');
    const card = msg.extra.rich.blocks[0];
    assert.equal(card.kind, 'card', 'rich block should be a card');
    assert.equal(card.tone, 'info', 'should use info tone');
    assert.ok(card.title.includes('真相源'), 'card title should be the navigation summary');
  });

  test('card bodyMarkdown includes expanded details when threadMemory provided', () => {
    const msg = buildBriefingMessage(baseCoverageMap, 'thread-1', {
      threadMemorySummary: 'Session #1: Created routes.ts.',
    });
    const card = msg.extra.rich.blocks[0];
    assert.ok(card.bodyMarkdown, 'should have bodyMarkdown');
    assert.ok(card.bodyMarkdown.includes('opus'), 'participants in body');
    assert.ok(card.bodyMarkdown.includes('Session #1'), 'threadMemory in body');
  });

  test('card fields include coverage data', () => {
    const msg = buildBriefingMessage(baseCoverageMap, 'thread-1');
    const card = msg.extra.rich.blocks[0];
    assert.ok(card.fields?.length > 0, 'should have fields');
    // Check key fields exist
    const labels = card.fields.map((f) => f.label);
    assert.ok(labels.includes('传球'), 'should have baton field');
    assert.ok(labels.includes('真相源'), 'should have truth source field');
    assert.ok(labels.includes('下一步'), 'should have next step field');
  });

  test('VG-2: bodyMarkdown includes retrieval hints when present', () => {
    const mapWithHints = {
      ...baseCoverageMap,
      retrievalHints: ['ADR-005: Redis Key Prefix', 'F088: Chat Gateway'],
    };
    const msg = buildBriefingMessage(mapWithHints, 'thread-1');
    const card = msg.extra.rich.blocks[0];
    assert.ok(card.bodyMarkdown, 'should have bodyMarkdown');
    assert.ok(card.bodyMarkdown.includes('ADR-005'), 'should include first evidence title');
    assert.ok(card.bodyMarkdown.includes('F088'), 'should include second evidence title');
  });

  test('VG-2: bodyMarkdown omits evidence section when retrievalHints empty', () => {
    const mapNoHints = {
      ...baseCoverageMap,
      retrievalHints: [],
    };
    const msg = buildBriefingMessage(mapNoHints, 'thread-1');
    const card = msg.extra.rich.blocks[0];
    // bodyMarkdown should exist (has participants etc.) but no evidence section
    if (card.bodyMarkdown) {
      assert.ok(!card.bodyMarkdown.includes('证据'), 'no evidence section when empty');
    }
  });

  test('VG-3: bodyMarkdown includes key decisions when threadMemory has decisions', () => {
    const mapWithDecisions = {
      ...baseCoverageMap,
      threadMemory: {
        available: true,
        sessionsIncorporated: 3,
        decisions: ['用方案B', '不用cheap model摘要'],
        openQuestions: ['burst gap阈值待实验'],
      },
    };
    const msg = buildBriefingMessage(mapWithDecisions, 'thread-1');
    const card = msg.extra.rich.blocks[0];
    assert.ok(card.bodyMarkdown, 'should have bodyMarkdown');
    assert.ok(card.bodyMarkdown.includes('关键决策'), 'should have decisions section');
    assert.ok(card.bodyMarkdown.includes('用方案B'), 'should include first decision');
    assert.ok(card.bodyMarkdown.includes('不用cheap model'), 'should include second decision');
    assert.ok(card.bodyMarkdown.includes('待决问题'), 'should have open questions section');
    assert.ok(card.bodyMarkdown.includes('burst gap'), 'should include open question');
  });

  test('VG-3: bodyMarkdown omits decisions section when no decisions', () => {
    const mapNoDecisions = {
      ...baseCoverageMap,
      threadMemory: { available: true, sessionsIncorporated: 2 },
    };
    const msg = buildBriefingMessage(mapNoDecisions, 'thread-1');
    const card = msg.extra.rich.blocks[0];
    if (card.bodyMarkdown) {
      assert.ok(!card.bodyMarkdown.includes('关键决策'), 'no decisions section when empty');
    }
  });

  test('VG-3: decisions capped at 3 in briefing display', () => {
    const mapManyDecisions = {
      ...baseCoverageMap,
      threadMemory: {
        available: true,
        sessionsIncorporated: 5,
        decisions: ['决策1', '决策2', '决策3', '决策4', '决策5'],
        openQuestions: ['Q1', 'Q2', 'Q3'],
      },
    };
    const msg = buildBriefingMessage(mapManyDecisions, 'thread-1');
    const card = msg.extra.rich.blocks[0];
    assert.ok(card.bodyMarkdown);
    // Count "- 决策" occurrences — should be 3 (capped)
    const decisionLines = card.bodyMarkdown.split('\n').filter((l) => l.startsWith('- 决策'));
    assert.equal(decisionLines.length, 3, `expected 3 decisions in display, got ${decisionLines.length}`);
    // Count "- Q" occurrences — should be 2 (capped)
    const questionLines = card.bodyMarkdown.split('\n').filter((l) => l.startsWith('- Q'));
    assert.equal(questionLines.length, 2, `expected 2 questions in display, got ${questionLines.length}`);
  });

  test('searchSuggestions rendered as actionable hints in bodyMarkdown', () => {
    const mapWithSearch = {
      ...baseCoverageMap,
      searchSuggestions: ['search_evidence("redis config", threadId="t1")', 'search_evidence("deployment")'],
    };
    const msg = buildBriefingMessage(mapWithSearch, 'thread-1');
    const card = msg.extra.rich.blocks[0];
    assert.ok(card.bodyMarkdown, 'should have bodyMarkdown');
    assert.ok(card.bodyMarkdown.includes('深入搜索'), 'should have search suggestions section');
    assert.ok(card.bodyMarkdown.includes('redis config'), 'should include first suggestion');
    assert.ok(card.bodyMarkdown.includes('deployment'), 'should include second suggestion');
  });

  test('searchSuggestions with backticks/newlines are escaped (Cloud-R1-P2)', () => {
    const mapWithDirty = {
      ...baseCoverageMap,
      searchSuggestions: ['has `backtick` inside', 'has\nnewline'],
    };
    const msg = buildBriefingMessage(mapWithDirty, 'thread-1');
    const card = msg.extra.rich.blocks[0];
    assert.ok(card.bodyMarkdown.includes('深入搜索'), 'section should exist');
    // backticks inside must not break the inline code fence
    assert.ok(!card.bodyMarkdown.includes('`has `backtick'), 'raw backtick must be escaped');
    // newlines must be stripped so each suggestion stays on one line
    const searchSection = card.bodyMarkdown.split('**深入搜索**:')[1];
    const lines = searchSection
      .trim()
      .split('\n')
      .filter((l) => l.startsWith('- '));
    assert.equal(lines.length, 2, 'each suggestion should be exactly one line');
  });

  test('searchSuggestions with backslashes/quotes are sanitized (Cloud-R2-P2)', () => {
    const mapWithSpecial = {
      ...baseCoverageMap,
      searchSuggestions: ['search_evidence("My \\"Redis\\" notes")', 'path\\to\\thing'],
    };
    const msg = buildBriefingMessage(mapWithSpecial, 'thread-1');
    const card = msg.extra.rich.blocks[0];
    const searchSection = card.bodyMarkdown.split('**深入搜索**:')[1];
    // backslashes must be stripped so copy-paste doesn't break
    assert.ok(!searchSection.includes('\\'), 'backslashes must be sanitized');
    const lines = searchSection
      .trim()
      .split('\n')
      .filter((l) => l.startsWith('- '));
    assert.equal(lines.length, 2, 'each suggestion should be exactly one line');
  });

  test('searchSuggestions omitted when empty', () => {
    const msg = buildBriefingMessage(baseCoverageMap, 'thread-1');
    const card = msg.extra.rich.blocks[0];
    if (card.bodyMarkdown) {
      assert.ok(!card.bodyMarkdown.includes('深入搜索'), 'no search section when no suggestions');
    }
  });
});

describe('F148 Phase F: Briefing card navigation context (AC-F5)', () => {
  const baseCoverageMap = {
    omitted: {
      count: 22,
      timeRange: { from: 1712000000000, to: 1712003600000 },
      participants: ['opus', 'codex'],
    },
    burst: { count: 8, timeRange: { from: 1712003600000, to: 1712004000000 } },
    anchorIds: ['a1'],
    threadMemory: null,
    retrievalHints: [],
  };

  test('AC-F5: bodyMarkdown includes baton info when provided', () => {
    const msg = buildBriefingMessage(baseCoverageMap, 'thread-1', {
      baton: {
        fromMessageId: 'm5',
        fromSpeaker: 'codex',
        fromSpeakerDisplay: 'codex',
        timestamp: 1712004000000,
        mentionExcerpt: '帮我看看这个 PR',
        staleHoldWarning: false,
      },
    });
    const card = msg.extra.rich.blocks[0];
    assert.ok(card.bodyMarkdown, 'should have bodyMarkdown');
    assert.ok(card.bodyMarkdown.includes('传球'), 'should have baton section');
    assert.ok(card.bodyMarkdown.includes('codex'), 'should include speaker');
    assert.ok(card.bodyMarkdown.includes('帮我看看'), 'should include excerpt');
  });

  test('AC-F5: bodyMarkdown includes stale hold warning', () => {
    const msg = buildBriefingMessage(baseCoverageMap, 'thread-1', {
      baton: {
        fromMessageId: 'm5',
        fromSpeaker: 'codex',
        fromSpeakerDisplay: 'codex',
        timestamp: 1712004000000,
        mentionExcerpt: '看看',
        staleHoldWarning: true,
      },
    });
    const card = msg.extra.rich.blocks[0];
    assert.ok(card.bodyMarkdown.includes('⚠️'), 'should include warning emoji');
    assert.ok(card.bodyMarkdown.includes('别动'), 'should mention hold');
  });

  test('AC-F5: bodyMarkdown includes active tasks when provided', () => {
    const msg = buildBriefingMessage(baseCoverageMap, 'thread-1', {
      activeTasks: [
        { id: 't1', title: 'Fix Redis bug', status: 'in-progress', ownerCatId: 'opus' },
        { id: 't2', title: 'Deploy v2', status: 'todo', ownerCatId: null },
      ],
    });
    const card = msg.extra.rich.blocks[0];
    assert.ok(card.bodyMarkdown, 'should have bodyMarkdown');
    assert.ok(card.bodyMarkdown.includes('活跃任务'), 'should have tasks section');
    assert.ok(card.bodyMarkdown.includes('Fix Redis'), 'should include first task');
    assert.ok(card.bodyMarkdown.includes('未分配'), 'null owner shows as 未分配');
  });

  test('AC-F5: omits navigation sections when no baton/tasks', () => {
    const msg = buildBriefingMessage(baseCoverageMap, 'thread-1', {});
    const card = msg.extra.rich.blocks[0];
    if (card.bodyMarkdown) {
      assert.ok(!card.bodyMarkdown.includes('传球'), 'no baton section');
      assert.ok(!card.bodyMarkdown.includes('活跃任务'), 'no tasks section');
    }
  });
});
