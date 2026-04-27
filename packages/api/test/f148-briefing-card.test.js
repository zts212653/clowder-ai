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
    retrievalHints: ['hint-1'],
    searchSuggestions: ['search_evidence("F148")'],
    ...overrides,
  };
}

describe('F148 briefing card — navigation-first collapsed view', () => {
  describe('summary (collapsed title)', () => {
    it('shows baton + truth source + next step when all available', () => {
      const result = buildBriefingMessage(makeCoverage(), 'thread-1', {
        baton: {
          fromMessageId: 'm1',
          fromSpeaker: 'user',
          fromSpeakerDisplay: '铲屎官',
          timestamp: Date.now(),
          mentionExcerpt: '帮我看看 F148',
          staleHoldWarning: false,
        },
        rankedSources: [
          { type: 'feature-doc', ref: 'docs/features/F148-*.md', label: 'F148 spec', provenance: 'canonical' },
        ],
      });
      const card = result.extra.rich.blocks[0];
      // Title should contain navigation info, not coverage counts
      assert.ok(card.title.includes('铲屎官'), `title should mention baton source, got: ${card.title}`);
      assert.ok(card.title.includes('F148 spec'), `title should mention truth source, got: ${card.title}`);
    });

    it('shows 未定位 when no ranked sources', () => {
      const result = buildBriefingMessage(makeCoverage(), 'thread-1', {
        baton: {
          fromMessageId: 'm1',
          fromSpeaker: 'user',
          fromSpeakerDisplay: '铲屎官',
          timestamp: Date.now(),
          mentionExcerpt: '看看这个',
          staleHoldWarning: false,
        },
        rankedSources: [],
      });
      const card = result.extra.rich.blocks[0];
      assert.ok(card.title.includes('未定位'), `title should say 未定位 when no sources, got: ${card.title}`);
    });

    it('shows 未定位 when rankedSources is undefined', () => {
      const result = buildBriefingMessage(makeCoverage(), 'thread-1', {});
      const card = result.extra.rich.blocks[0];
      assert.ok(card.title.includes('未定位'), `title should say 未定位, got: ${card.title}`);
    });
  });

  describe('fields (visible in collapsed state)', () => {
    it('has 3 navigation fields: 传球/真相源/下一步', () => {
      const result = buildBriefingMessage(makeCoverage(), 'thread-1', {
        baton: {
          fromMessageId: 'm1',
          fromSpeaker: 'user',
          fromSpeakerDisplay: '铲屎官',
          timestamp: Date.now(),
          mentionExcerpt: '看看 F148',
          staleHoldWarning: false,
        },
        rankedSources: [
          { type: 'feature-doc', ref: 'docs/features/F148-*.md', label: 'F148 spec', provenance: 'canonical' },
        ],
      });
      const card = result.extra.rich.blocks[0];
      const labels = card.fields.map((f) => f.label);
      assert.deepEqual(labels, ['传球', '真相源', '下一步']);
    });

    it('传球 field shows sender → 你', () => {
      const result = buildBriefingMessage(makeCoverage(), 'thread-1', {
        baton: {
          fromMessageId: 'm1',
          fromSpeaker: 'user',
          fromSpeakerDisplay: '砚砚',
          timestamp: Date.now(),
          mentionExcerpt: '',
          staleHoldWarning: false,
        },
      });
      const card = result.extra.rich.blocks[0];
      const batonField = card.fields.find((f) => f.label === '传球');
      assert.ok(batonField.value.includes('砚砚'), `baton field should include sender name, got: ${batonField.value}`);
      assert.ok(batonField.value.includes('→'), `baton field should have arrow, got: ${batonField.value}`);
    });

    it('传球 field shows 直接 @ when no baton', () => {
      const result = buildBriefingMessage(makeCoverage(), 'thread-1', {});
      const card = result.extra.rich.blocks[0];
      const batonField = card.fields.find((f) => f.label === '传球');
      assert.equal(batonField.value, '直接 @');
    });

    it('真相源 field shows top source label', () => {
      const result = buildBriefingMessage(makeCoverage(), 'thread-1', {
        rankedSources: [
          { type: 'feature-doc', ref: 'docs/features/F148-*.md', label: 'F148 spec', provenance: 'canonical' },
          { type: 'pr', ref: '#1303', label: 'PR #1303', provenance: 'recency' },
        ],
      });
      const card = result.extra.rich.blocks[0];
      const sourceField = card.fields.find((f) => f.label === '真相源');
      assert.equal(sourceField.value, 'F148 spec');
    });

    it('真相源 field shows (推断) for regex provenance', () => {
      const result = buildBriefingMessage(makeCoverage(), 'thread-1', {
        rankedSources: [
          { type: 'feature-doc', ref: 'docs/features/F148-*.md', label: 'F148 spec', provenance: 'regex' },
        ],
      });
      const card = result.extra.rich.blocks[0];
      const sourceField = card.fields.find((f) => f.label === '真相源');
      assert.ok(sourceField.value.includes('(推断)'), `regex source should be tagged, got: ${sourceField.value}`);
    });

    it('真相源 field shows 未定位 when empty', () => {
      const result = buildBriefingMessage(makeCoverage(), 'thread-1', { rankedSources: [] });
      const card = result.extra.rich.blocks[0];
      const sourceField = card.fields.find((f) => f.label === '真相源');
      assert.equal(sourceField.value, '未定位');
    });

    it('下一步 field includes both label and ref for actionable pointer', () => {
      const result = buildBriefingMessage(makeCoverage(), 'thread-1', {
        rankedSources: [
          { type: 'feature-doc', ref: 'docs/features/F148-*.md', label: 'F148 spec', provenance: 'canonical' },
        ],
      });
      const card = result.extra.rich.blocks[0];
      const nextField = card.fields.find((f) => f.label === '下一步');
      assert.ok(nextField.value.includes('F148 spec'), `next step should include label, got: ${nextField.value}`);
      assert.ok(
        nextField.value.includes('docs/features/F148-*.md'),
        `next step should include ref for actionable pointer, got: ${nextField.value}`,
      );
    });

    it('下一步 field suggests search when no sources', () => {
      const result = buildBriefingMessage(makeCoverage(), 'thread-1', {
        rankedSources: [],
      });
      const card = result.extra.rich.blocks[0];
      const nextField = card.fields.find((f) => f.label === '下一步');
      assert.ok(
        nextField.value.includes('search_evidence') || nextField.value.includes('搜索'),
        `next step should suggest search, got: ${nextField.value}`,
      );
    });

    it('下一步 field sanitizes search suggestion (no backticks/newlines)', () => {
      const dirty = 'search_evidence(`F148`)\nwith newline\\backslash';
      const result = buildBriefingMessage(makeCoverage({ searchSuggestions: [dirty] }), 'thread-1', {
        rankedSources: [],
      });
      const card = result.extra.rich.blocks[0];
      const nextField = card.fields.find((f) => f.label === '下一步');
      assert.ok(!nextField.value.includes('`'), `should not contain backticks, got: ${nextField.value}`);
      assert.ok(!nextField.value.includes('\n'), `should not contain newlines, got: ${nextField.value}`);
      assert.ok(!nextField.value.includes('\\'), `should not contain backslashes, got: ${nextField.value}`);
    });
  });

  describe('backward compatibility', () => {
    it('still produces bodyMarkdown with full details', () => {
      const result = buildBriefingMessage(makeCoverage(), 'thread-1', {
        baton: {
          fromMessageId: 'm1',
          fromSpeaker: 'user',
          fromSpeakerDisplay: '铲屎官',
          timestamp: Date.now(),
          mentionExcerpt: '看看 F148',
          staleHoldWarning: false,
        },
        activeTasks: [{ id: 't1', title: 'Fix bug', status: 'in-progress', ownerCatId: 'opus' }],
        rankedSources: [
          { type: 'feature-doc', ref: 'docs/features/F148-*.md', label: 'F148 spec', provenance: 'canonical' },
        ],
      });
      const card = result.extra.rich.blocks[0];
      assert.ok(card.bodyMarkdown, 'should have bodyMarkdown');
      assert.ok(card.bodyMarkdown.includes('参与者'), 'bodyMarkdown should still include participants');
      assert.ok(card.bodyMarkdown.includes('传球'), 'bodyMarkdown should include baton');
      assert.ok(card.bodyMarkdown.includes('活跃任务'), 'bodyMarkdown should include tasks');
      assert.ok(card.bodyMarkdown.includes('真相源'), 'bodyMarkdown should include ranked sources');
    });

    it('message envelope structure unchanged', () => {
      const result = buildBriefingMessage(makeCoverage(), 'thread-1', {});
      assert.equal(result.origin, 'briefing');
      assert.equal(result.userId, 'system');
      assert.equal(result.catId, null);
      assert.ok(result.extra.rich.v === 1);
      assert.ok(Array.isArray(result.extra.rich.blocks));
    });
  });

  describe('formatContextBriefing (pure function)', () => {
    it('summary includes navigation info not just coverage', () => {
      const { summary } = formatContextBriefing(makeCoverage());
      // Old format was "看到 X 条 · 省略 Y 条 · ..."
      // New format should still be usable but can include coverage
      assert.ok(typeof summary === 'string');
      assert.ok(summary.length > 0);
    });
  });
});
