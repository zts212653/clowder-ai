import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const { buildBriefingMessage, formatContextBriefing } = await import(
  '../dist/domains/cats/services/agents/routing/format-briefing.js'
);

/** Minimal CoverageMap for tests */
function makeCoverage(overrides = {}) {
  return {
    omitted: {
      count: 42,
      timeRange: { from: Date.now() - 3600000, to: Date.now() - 1800000 },
      participants: ['砚砚', '宪宪'],
    },
    burst: { count: 5, timeRange: { from: Date.now() - 1800000, to: Date.now() } },
    anchorIds: ['a1'],
    threadMemory: { available: true, sessionsIncorporated: 3, decisions: [], openQuestions: [] },
    recallPointer: { candidateCount: 1 },
    searchSuggestions: ['search_evidence("legacy body hint")'],
    semanticSearchTerms: ['F148'],
    ...overrides,
  };
}

describe('briefing card — actual inputs and optional missing-material reads', () => {
  it('adds a receiver and display projection while preserving every input, memory and task', () => {
    const source = {
      fromMessageId: 'input-one',
      fromSpeakerDisplay: '砚砚',
      timestamp: 1000,
      sourceThreadId: 'original-thread',
      sourceMessageId: 'original-message',
    };
    const options = {
      receiverCatId: 'kimi',
      receiverDisplayName: '墨墨',
      sources: [source],
      threadMemorySummary: '已提供的线程记忆',
      anchorSummaries: ['已提供的锚点'],
      activeTasks: [{ id: 't', title: '保留活跃任务', status: 'doing', ownerCatId: 'codex61-sol' }],
      rankedSources: [
        {
          type: 'feature-doc',
          label: '菜单说明',
          ref: 'docs/menu.md',
          provenance: 'canonical',
          directiveEligible: true,
        },
        { type: 'pr', label: '候选不能变依据', ref: '#999', provenance: 'recency' },
      ],
    };
    const card = buildBriefingMessage(makeCoverage(), 'thread-demo', options).extra.rich.blocks[0];
    const display = card.meta.contextDisplay;
    assert.equal(card.meta.receiverCatId, 'kimi');
    assert.equal(card.meta.receiverDisplayName, '墨墨');
    assert.equal(card.meta.coverageSummary, '近期消息 5 条 · 历史略过 42 条');
    assert.deepEqual(
      display.inputs.map(({ time, ...input }) => input),
      [
        {
          fromMessageId: source.fromMessageId,
          from: source.fromSpeakerDisplay,
          sourceThreadId: source.sourceThreadId,
          sourceMessageId: source.sourceMessageId,
        },
      ],
    );
    assert.ok(display.inputs[0].time);
    assert.equal(display.handoff, undefined, 'route provenance cannot become a handoff claim');
    assert.deepEqual(display.sources, [{ type: 'feature-doc', label: '菜单说明', ref: 'docs/menu.md' }]);
    assert.match(display.coverage, /看到 5 条.*省略 42 条.*记忆 3 sessions/);
    assert.match(display.detailsMarkdown, /已提供的线程记忆/);
    assert.match(display.detailsMarkdown, /已提供的锚点/);
    assert.match(display.detailsMarkdown, /保留活跃任务/);
    assert.doesNotMatch(display.detailsMarkdown, /input-one|菜单说明|候选不能变依据/);
    assert.match(card.bodyMarkdown, /input-one/);
    assert.match(card.bodyMarkdown, /菜单说明/);
  });

  it('does not invent sender, receiver or handoff excerpt when route provenance is missing', () => {
    const card = buildBriefingMessage(makeCoverage(), 'thread-demo').extra.rich.blocks[0];
    assert.equal(card.meta.receiverCatId, undefined);
    assert.equal(card.meta.receiverDisplayName, undefined);
    assert.deepEqual(card.meta.contextDisplay.inputs, []);
    assert.equal(card.meta.contextDisplay.handoff, undefined);
  });

  it('complete context without sources has no invented handoff or next action', () => {
    const coverage = makeCoverage({
      omitted: { count: 0, timeRange: { from: 0, to: 0 }, participants: [] },
      searchSuggestions: [],
      recallPointer: { candidateCount: 0 },
    });
    const result = buildBriefingMessage(coverage, 'thread-1');
    const card = result.extra.rich.blocks[0];
    assert.doesNotMatch(
      JSON.stringify(card),
      /直接 @|传球|未定位|下一步|cat_cafe_get_thread_context|cat_cafe_search_evidence/,
    );
    assert.equal(result.origin, 'briefing');
    assert.deepEqual(result.from, { kind: 'system', service: 'context-briefing' });
  });

  it('shows every exact input and its cross-thread coordinates without a handoff claim', () => {
    const result = buildBriefingMessage(makeCoverage(), 'thread-1', {
      sources: [
        { fromMessageId: 'm1', fromSpeakerDisplay: 'co-creator', timestamp: 1000 },
        {
          fromMessageId: 'm2',
          fromSpeakerDisplay: '砚砚',
          timestamp: 2000,
          sourceThreadId: 'original-thread',
          sourceMessageId: 'original-message',
        },
      ],
      activeTasks: [{ id: 't1', title: 'Existing work', status: 'doing', ownerCatId: 'opus' }],
    });
    const card = result.extra.rich.blocks[0];
    const field = card.fields.find((field) => field.label === '本轮输入来源');
    assert.match(field.value, /messageId=m1/);
    assert.match(field.value, /messageId=m2/);
    assert.match(field.value, /original-thread#original-message/);
    assert.match(card.bodyMarkdown, /Existing work/);
    assert.doesNotMatch(card.bodyMarkdown, /传球|以传球为准/);
  });

  it('keeps validated work materials while omitting regex guesses', () => {
    const source = {
      type: 'feature-doc',
      ref: 'docs/features/F148.md',
      label: 'F148 spec',
      provenance: 'canonical',
      directiveEligible: true,
    };
    for (const provenance of ['canonical', 'regex']) {
      const result = buildBriefingMessage(makeCoverage(), 'thread-1', {
        rankedSources: [{ ...source, provenance, directiveEligible: provenance === 'canonical' }],
      });
      const material = result.extra.rich.blocks[0].fields.find((field) => field.label === '工作材料');
      if (provenance === 'canonical') assert.equal(material.value, 'F148 spec — docs/features/F148.md');
      else assert.equal(material, undefined);
    }
  });

  for (const [terms, expected] of [
    [[], 'cat_cafe_get_thread_context({ threadId: "thread-1" })'],
    [['thread-1'], 'cat_cafe_get_thread_context({ threadId: "thread-1" })'],
    [['F148'], 'cat_cafe_search_evidence({ query: "F148", threadId: "thread-1", scope: "threads", mode: "hybrid" })'],
    [['invalid\nquery'], 'cat_cafe_get_thread_context({ threadId: "thread-1" })'],
  ]) {
    it(`omitted messages retain a structured optional drill for ${JSON.stringify(terms)}`, () => {
      const result = buildBriefingMessage(makeCoverage({ semanticSearchTerms: terms }), 'thread-1');
      const field = result.extra.rich.blocks[0].fields.find((field) => field.label === '省略原文（需要时读取）');
      assert.equal(field.value, expected);
    });
  }

  it('renders a drill pointer beside every thread-memory decision, and drops lifecycle-less open questions', () => {
    const coverage = makeCoverage({
      threadMemory: {
        available: true,
        sessionsIncorporated: 2,
        decisions: ['采用方案B'],
        decisionRefs: [{ threadId: 'thread-1', sessionId: 'session-7', eventNo: 42, invocationId: 'inv-9' }],
        openQuestions: ['阈值待定'],
        openQuestionRefs: [{ threadId: 'thread-1', sessionId: 'session-7', eventNo: 44 }],
      },
    });
    const result = buildBriefingMessage(coverage, 'thread-1', {});
    const body = result.extra.rich.blocks[0].bodyMarkdown;

    assert.ok(
      body.includes('采用方案B [provenance: threadId=thread-1; sessionId=session-7; eventNo=42; invocationId=inv-9]'),
      body,
    );
    // F296 AC-A2: an open question without lifecycle state cannot be shown as current work.
    assert.ok(!body.includes('阈值待定'), body);
    assert.ok(!body.includes('待决问题'), body);
  });

  it('coverage summary reports actual counts', () => {
    const { summary } = formatContextBriefing(makeCoverage());
    assert.match(summary, /看到 5 条/);
    assert.match(summary, /省略 42 条/);
  });
});
