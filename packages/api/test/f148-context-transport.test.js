// @ts-check

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DEFAULT_HIERARCHICAL_CONTEXT } from '../dist/config/hierarchical-context-config.js';
import {
  buildCoverageMap,
  buildTombstone,
  detectRecentBurst,
  formatAnchors,
  formatTombstone,
  recallEvidence,
  scoreImportance,
  scrubToolPayloads,
  selectAnchors,
} from '../dist/domains/cats/services/agents/routing/context-transport.js';

// --- Test Helpers ---

let _msgSeq = 0;
/** Create a minimal StoredMessage for testing */
function makeMsg(overrides = {}) {
  const seq = _msgSeq++;
  return {
    id: `msg-${seq}`,
    threadId: 'thread-1',
    userId: 'user-1',
    catId: null,
    content: `Message ${seq}`,
    mentions: [],
    timestamp: Date.now() - (100 - seq) * 60_000, // each msg 1 minute apart
    ...overrides,
  };
}

function resetSeq() {
  _msgSeq = 0;
}

/** Create N messages spaced 1 minute apart from a base timestamp */
function makeMsgSequence(n, baseTimestamp = Date.now() - n * 60_000) {
  resetSeq();
  return Array.from({ length: n }, (_, i) => makeMsg({ timestamp: baseTimestamp + i * 60_000 }));
}

// --- detectRecentBurst Tests ---

describe('F148: detectRecentBurst', () => {
  const config = { ...DEFAULT_HIERARCHICAL_CONTEXT };

  it('all messages within 1 minute → all in burst (up to maxBurst)', () => {
    resetSeq();
    const base = Date.now();
    const msgs = Array.from(
      { length: 8 },
      (_, i) => makeMsg({ timestamp: base + i * 1000 }), // 1 second apart
    );

    const { burst, omitted } = detectRecentBurst(msgs, config);
    assert.equal(burst.length, 8);
    assert.equal(omitted.length, 0);
  });

  it('detects silence gap and splits burst', () => {
    resetSeq();
    const base = Date.now();
    // 15 msgs, 1 minute apart, then 20-minute gap, then 5 msgs
    const earlyMsgs = Array.from({ length: 15 }, (_, i) => makeMsg({ timestamp: base + i * 60_000 }));
    const lateMsgs = Array.from({ length: 5 }, (_, i) =>
      makeMsg({ timestamp: base + 15 * 60_000 + 20 * 60_000 + i * 60_000 }),
    );
    const all = [...earlyMsgs, ...lateMsgs];

    const { burst, omitted } = detectRecentBurst(all, config);
    assert.equal(burst.length, 5, 'burst should be the 5 msgs after the gap');
    assert.equal(omitted.length, 15);
  });

  it('guarantees minBurstMessages even when gap is found early', () => {
    resetSeq();
    const base = Date.now();
    // 10 msgs, then 20-minute gap, then only 2 msgs
    const earlyMsgs = Array.from({ length: 10 }, (_, i) => makeMsg({ timestamp: base + i * 60_000 }));
    const lateMsgs = Array.from({ length: 2 }, (_, i) =>
      makeMsg({ timestamp: base + 10 * 60_000 + 20 * 60_000 + i * 60_000 }),
    );
    const all = [...earlyMsgs, ...lateMsgs];

    const { burst, omitted } = detectRecentBurst(all, config);
    // Should get at least minBurstMessages (4), so extends past the gap
    assert.ok(
      burst.length >= config.minBurstMessages,
      `burst (${burst.length}) should be >= minBurstMessages (${config.minBurstMessages})`,
    );
  });

  it('caps at maxBurstMessages', () => {
    resetSeq();
    const base = Date.now();
    // 20 messages, all 1 second apart (no gap) → should cap at maxBurstMessages
    const msgs = Array.from({ length: 20 }, (_, i) => makeMsg({ timestamp: base + i * 1000 }));

    const smallConfig = { ...config, maxBurstMessages: 8 };
    const { burst, omitted } = detectRecentBurst(msgs, smallConfig);
    assert.equal(burst.length, 8, 'should cap at maxBurstMessages');
    assert.equal(omitted.length, 12);
  });

  it('does not split tool_use → tool_result pair at burst boundary', () => {
    resetSeq();
    const base = Date.now();
    // 10 msgs, all 1 second apart. Msg 2 (from tail) is tool_use, msg 1 is tool_result
    const msgs = Array.from({ length: 10 }, (_, i) => makeMsg({ timestamp: base + i * 1000 }));
    // Make msg[8] a tool_use (catId = cat) and msg[9] a tool_result
    msgs[8] = {
      ...msgs[8],
      catId: 'opus',
      toolEvents: [{ id: 'te-1', type: 'tool_use', label: 'search', timestamp: base + 8000 }],
    };
    msgs[9] = {
      ...msgs[9],
      catId: null,
      toolEvents: [{ id: 'te-2', type: 'tool_result', label: 'search', timestamp: base + 9000 }],
    };

    // Cap at 3, but the tool pair is at index 8-9 (positions 2-1 from tail)
    const smallConfig = { ...config, maxBurstMessages: 3 };
    const { burst } = detectRecentBurst(msgs, smallConfig);

    // Both tool_use and tool_result must be in burst
    const hasToolUse = burst.some((m) => m.toolEvents?.some((e) => e.type === 'tool_use'));
    const hasToolResult = burst.some((m) => m.toolEvents?.some((e) => e.type === 'tool_result'));
    assert.ok(hasToolUse && hasToolResult, 'tool_use→tool_result pair must not be split');
  });

  it('does not split user question → cat answer pair at burst boundary', () => {
    resetSeq();
    const base = Date.now();
    const msgs = Array.from({ length: 10 }, (_, i) => makeMsg({ timestamp: base + i * 1000 }));
    // Make msg[6] a user question, msg[7] a cat answer
    msgs[6] = { ...msgs[6], catId: null, content: 'What is Redis?' };
    msgs[7] = { ...msgs[7], catId: 'opus', content: 'Redis is...' };

    // Cap at 4: should include msg[6-9] (indices from tail: 3,2,1,0)
    // If cap were 3, would need to extend to include the Q→A pair
    const smallConfig = { ...config, maxBurstMessages: 3 };
    const { burst } = detectRecentBurst(msgs, smallConfig);

    // The last 3 are msg[7,8,9]. msg[7] is a cat answer to msg[6] (user question).
    // Semantic chain protection should pull in msg[6] too.
    const hasQuestion = burst.some((m) => m.content === 'What is Redis?');
    const hasAnswer = burst.some((m) => m.content === 'Redis is...');
    if (hasAnswer) {
      assert.ok(hasQuestion, 'if cat answer is in burst, the user question must also be included');
    }
  });

  it('returns all messages when count <= minBurstMessages', () => {
    resetSeq();
    const msgs = makeMsgSequence(3);
    const { burst, omitted } = detectRecentBurst(msgs, config);
    assert.equal(burst.length, 3);
    assert.equal(omitted.length, 0);
  });

  it('handles empty array', () => {
    const { burst, omitted } = detectRecentBurst([], config);
    assert.equal(burst.length, 0);
    assert.equal(omitted.length, 0);
  });
});

// --- buildTombstone Tests ---

describe('F148: buildTombstone', () => {
  const config = { ...DEFAULT_HIERARCHICAL_CONTEXT };

  it('returns correct count, time range, participants for omitted messages', () => {
    resetSeq();
    const base = Date.now() - 3600_000;
    const omitted = [
      makeMsg({ timestamp: base, userId: 'user-1', catId: null, content: 'hello' }),
      makeMsg({ timestamp: base + 60_000, userId: 'user-1', catId: 'opus', content: 'hi there' }),
      makeMsg({ timestamp: base + 120_000, userId: 'user-2', catId: null, content: 'Redis cluster setup' }),
      makeMsg({ timestamp: base + 180_000, userId: 'user-1', catId: 'codex', content: 'Redis config looks good' }),
    ];

    const tombstone = buildTombstone(omitted, 'Redis Migration Thread', config);
    assert.ok(tombstone !== null);
    assert.equal(tombstone.omittedCount, 4);
    assert.equal(tombstone.timeRange.from, base);
    assert.equal(tombstone.timeRange.to, base + 180_000);
    assert.ok(tombstone.participants.includes('opus'));
    assert.ok(tombstone.participants.includes('codex'));
  });

  it('extracts keywords from message content (top N by frequency)', () => {
    resetSeq();
    const base = Date.now();
    const omitted = Array.from({ length: 10 }, (_, i) =>
      makeMsg({
        timestamp: base + i * 60_000,
        content: i % 2 === 0 ? 'Redis cluster configuration needs review' : 'The Redis deployment pipeline is broken',
      }),
    );

    const tombstone = buildTombstone(omitted, 'Deployment', config);
    assert.ok(tombstone !== null);
    // "Redis" appears in all 10 messages → should be a keyword
    assert.ok(tombstone.keywords.length > 0);
    assert.ok(tombstone.keywords.length <= config.maxTombstoneKeywords);
    assert.ok(
      tombstone.keywords.some((k) => k.toLowerCase().includes('redis')),
      `keywords should include "redis", got: ${tombstone.keywords}`,
    );
  });

  it('retrieval hints include search_evidence suggestion', () => {
    resetSeq();
    const omitted = makeMsgSequence(5);
    const tombstone = buildTombstone(omitted, 'Test Thread', config);
    assert.ok(tombstone !== null);
    assert.ok(tombstone.retrievalHints.length > 0);
    assert.ok(
      tombstone.retrievalHints.some((h) => h.includes('search_evidence')),
      'should suggest search_evidence tool',
    );
  });

  it('returns null for empty omitted array', () => {
    const tombstone = buildTombstone([], 'Test', config);
    assert.equal(tombstone, null);
  });

  it('Gap-2: retrieval hints include threadId when provided', () => {
    resetSeq();
    const omitted = Array.from({ length: 5 }, () =>
      makeMsg({ content: 'Redis CAS lock discussion with multiple approaches' }),
    );
    const tombstone = buildTombstone(omitted, 'Redis Discussion', config, 'thread_abc');
    assert.ok(tombstone !== null);
    assert.ok(
      tombstone.retrievalHints.some((h) => h.includes('threadId') && h.includes('thread_abc')),
      `hints should include threadId, got: ${tombstone.retrievalHints}`,
    );
  });

  it('Gap-2: retrieval hints omit threadId when not provided', () => {
    resetSeq();
    const omitted = Array.from({ length: 5 }, () =>
      makeMsg({ content: 'Redis CAS lock discussion with multiple approaches' }),
    );
    const tombstone = buildTombstone(omitted, 'Redis Discussion', config);
    assert.ok(tombstone !== null);
    assert.ok(
      !tombstone.retrievalHints.some((h) => h.includes('threadId')),
      `hints should NOT include threadId when not provided, got: ${tombstone.retrievalHints}`,
    );
  });
});

// --- formatTombstone Tests ---

describe('F148: formatTombstone', () => {
  it('formats tombstone as compact context string', () => {
    const tombstone = {
      omittedCount: 50,
      timeRange: { from: Date.now() - 3600_000, to: Date.now() - 600_000 },
      participants: ['opus', 'codex'],
      keywords: ['Redis', 'migration'],
      retrievalHints: ['search_evidence("Redis migration")'],
    };

    const text = formatTombstone(tombstone);
    assert.ok(text.includes('50'));
    assert.ok(text.includes('opus'));
    assert.ok(text.includes('Redis'));
    assert.ok(text.includes('search_evidence'));
  });
});

// --- scrubToolPayloads Tests ---

describe('F148: scrubToolPayloads', () => {
  it('preserves last message tool content verbatim', () => {
    resetSeq();
    const base = Date.now();
    const msgs = [
      makeMsg({
        timestamp: base,
        catId: 'opus',
        content: 'Let me search...',
        toolEvents: [{ id: 'te-1', type: 'tool_use', label: 'search_evidence', timestamp: base }],
      }),
      makeMsg({
        timestamp: base + 1000,
        content: 'Tool result: {"rows": 45, "data": "very long payload..."}',
        toolEvents: [{ id: 'te-2', type: 'tool_result', label: 'search_evidence', timestamp: base + 1000 }],
      }),
    ];

    const scrubbed = scrubToolPayloads(msgs);
    // Last message should be unchanged
    assert.equal(scrubbed[scrubbed.length - 1].content, msgs[msgs.length - 1].content);
  });

  it('scrubs earlier messages with tool results', () => {
    resetSeq();
    const base = Date.now();
    const msgs = [
      makeMsg({
        timestamp: base,
        catId: 'opus',
        content: 'Searching...',
        toolEvents: [{ id: 'te-1', type: 'tool_use', label: 'search_evidence', timestamp: base }],
      }),
      makeMsg({
        timestamp: base + 1000,
        content: '{"result": "very long tool output that should be scrubbed"}',
        toolEvents: [{ id: 'te-2', type: 'tool_result', label: 'search_evidence', timestamp: base + 1000 }],
      }),
      makeMsg({ timestamp: base + 2000, catId: null, content: 'Thanks, what about Redis?' }),
      makeMsg({ timestamp: base + 3000, catId: 'opus', content: 'Redis is configured at...' }),
    ];

    const scrubbed = scrubToolPayloads(msgs);
    // Earlier tool_result (index 1) should be scrubbed
    assert.ok(scrubbed[1].content.includes('truncated'), `expected scrubbed content, got: ${scrubbed[1].content}`);
    // Non-tool messages should be unchanged
    assert.equal(scrubbed[2].content, msgs[2].content);
    assert.equal(scrubbed[3].content, msgs[3].content);
  });

  it('leaves non-tool messages untouched', () => {
    resetSeq();
    const msgs = makeMsgSequence(5);
    const scrubbed = scrubToolPayloads(msgs);
    for (let i = 0; i < msgs.length; i++) {
      assert.equal(scrubbed[i].content, msgs[i].content);
    }
  });

  it('handles empty array', () => {
    const scrubbed = scrubToolPayloads([]);
    assert.equal(scrubbed.length, 0);
  });
});

// --- recallEvidence Tests ---

describe('F148: recallEvidence', () => {
  const config = { ...DEFAULT_HIERARCHICAL_CONTEXT };

  /** Mock evidence store */
  function mockEvidenceStore(results) {
    return {
      search: async (query) =>
        results.map((r, i) => ({
          anchor: `ev-${i}`,
          kind: 'thread',
          status: 'active',
          title: r.title,
          summary: r.summary,
          keywords: [],
        })),
      upsert: async () => {},
      deleteByAnchor: async () => {},
      getByAnchor: async () => null,
      health: async () => true,
      initialize: async () => {},
    };
  }

  it('returns formatted evidence from store search', async () => {
    const store = mockEvidenceStore([
      { title: 'Redis Config Decision', summary: 'We decided to use cluster mode' },
      { title: 'Migration Plan', summary: 'Phase 1: data migration' },
    ]);

    resetSeq();
    const recentMsgs = makeMsgSequence(2);
    const results = await recallEvidence(store, 'Redis Thread', 'How do we handle Redis?', recentMsgs, config);
    assert.ok(results.length > 0);
    assert.ok(results.length <= config.maxEvidenceHits);
  });

  it('returns empty array when no evidenceStore', async () => {
    resetSeq();
    const results = await recallEvidence(undefined, 'Thread', 'test', makeMsgSequence(1), config);
    assert.deepEqual(results, []);
  });

  it('returns empty array on timeout (fail-open)', async () => {
    const slowStore = {
      search: async () => {
        await new Promise((r) => setTimeout(r, 2000)); // 2s delay
        return [{ anchor: 'x', kind: 'thread', status: 'active', title: 'X', summary: 'X', keywords: [] }];
      },
      upsert: async () => {},
      deleteByAnchor: async () => {},
      getByAnchor: async () => null,
      health: async () => true,
      initialize: async () => {},
    };

    resetSeq();
    const shortConfig = { ...config, evidenceRecallTimeoutMs: 50 }; // 50ms timeout
    const results = await recallEvidence(slowStore, 'Thread', 'test', makeMsgSequence(1), shortConfig);
    assert.deepEqual(results, []);
  });

  it('returns empty array on store error (fail-open)', async () => {
    const errorStore = {
      search: async () => {
        throw new Error('DB connection failed');
      },
      upsert: async () => {},
      deleteByAnchor: async () => {},
      getByAnchor: async () => null,
      health: async () => true,
      initialize: async () => {},
    };

    resetSeq();
    const results = await recallEvidence(errorStore, 'Thread', 'test', makeMsgSequence(1), config);
    assert.deepEqual(results, []);
  });
});

// --- Phase C: scoreImportance Tests ---

describe('F148 Phase C: scoreImportance', () => {
  it('AC-C1: code blocks boost structural score', () => {
    resetSeq();
    const msg = makeMsg({ content: 'Here is the fix:\n```js\nconst x = 1;\n```' });
    const scored = scoreImportance(msg, 5, 50, []);
    assert.ok(scored.signals.structural > 0, 'code block should boost structural');
  });

  it('AC-C1: @-mentions boost structural score', () => {
    resetSeq();
    const msg = makeMsg({ content: 'normal text', mentions: ['opus'] });
    const scored = scoreImportance(msg, 5, 50, []);
    assert.ok(scored.signals.structural > 0, '@-mention should boost structural');
  });

  it('AC-C1: tool events boost structural score', () => {
    resetSeq();
    const msg = makeMsg({ content: 'result', toolEvents: [{ type: 'tool_result', label: 'search' }] });
    const scored = scoreImportance(msg, 5, 50, []);
    assert.ok(scored.signals.structural > 0, 'tool event should boost structural');
  });

  it('AC-C3: index 0 is primacy', () => {
    resetSeq();
    const scored = scoreImportance(makeMsg({}), 0, 50, []);
    assert.ok(scored.isPrimacy, 'first message should be primacy');
    assert.ok(scored.signals.positional > 0, 'primacy boosts positional');
  });

  it('AC-C1: keyword overlap boosts relevance', () => {
    resetSeq();
    const msg = makeMsg({ content: 'Redis cluster configuration sentinel mode' });
    const scored = scoreImportance(msg, 5, 50, ['redis', 'cluster']);
    assert.ok(scored.signals.relevance > 0, 'keyword match should boost relevance');
  });

  it('plain message has low score', () => {
    resetSeq();
    const msg = makeMsg({ content: 'ok sounds good' });
    const scored = scoreImportance(msg, 10, 50, ['redis']);
    assert.equal(scored.score, scored.signals.structural + scored.signals.positional + scored.signals.relevance);
    assert.ok(scored.score === 0, 'filler message should score 0');
  });
});

// --- Phase C: selectAnchors Tests ---

describe('F148 Phase C: selectAnchors', () => {
  it('AC-C3: primacy anchor always included', () => {
    resetSeq();
    const msgs = Array.from({ length: 20 }, (_, i) =>
      makeMsg({ content: i === 0 ? 'Thread opener question about Redis' : `filler msg ${i}` }),
    );
    const anchors = selectAnchors(msgs, ['redis'], 3);
    assert.ok(
      anchors.some((a) => a.isPrimacy),
      'primacy anchor must be present',
    );
  });

  it('AC-C2: returns at most maxAnchors', () => {
    resetSeq();
    const msgs = Array.from({ length: 20 }, () =>
      makeMsg({ content: 'Redis ```code``` important', mentions: ['opus'] }),
    );
    const anchors = selectAnchors(msgs, ['redis'], 3);
    assert.ok(anchors.length <= 3, `should not exceed maxAnchors, got ${anchors.length}`);
  });

  it('AC-C2: high-signal messages rank higher', () => {
    resetSeq();
    const msgs = [
      makeMsg({ content: 'boring filler' }),
      makeMsg({ content: 'Redis config:\n```yaml\nport: 6379\n```', mentions: ['opus'] }),
      makeMsg({ content: 'ok' }),
    ];
    const anchors = selectAnchors(msgs, ['redis'], 2);
    assert.ok(
      anchors.some((a) => a.message.content.includes('Redis config')),
      'high-signal message should be selected',
    );
  });

  it('returns empty for empty omitted', () => {
    assert.deepStrictEqual(selectAnchors([], ['redis'], 3), []);
  });

  it('P2-2: maxAnchors=0 returns empty (not 1 via primacy)', () => {
    resetSeq();
    const msgs = Array.from({ length: 5 }, (_, i) => makeMsg({ content: i === 0 ? 'Thread opener' : `msg ${i}` }));
    const anchors = selectAnchors(msgs, [], 0);
    assert.equal(anchors.length, 0, `maxAnchors=0 should return 0, got ${anchors.length}`);
  });

  it('P1: chronological re-sort does not break score-based trim', () => {
    resetSeq();
    // Create messages where highest-score is NOT first chronologically
    // m0: primacy (score 5), m1: filler (score 0), m2: code+mention+keyword (score 6+)
    const msgs = [
      makeMsg({ content: 'Thread opener question' }), // idx 0: primacy +5
      makeMsg({ content: 'ok sounds good' }), // idx 1: score 0
      makeMsg({ content: 'Redis config:\n```yaml\nport: 6379\n```', mentions: ['opus'] }), // idx 2: structural 3+2=5, relevance +1 = 6
    ];
    const anchors = selectAnchors(msgs, ['redis'], 3);
    // All 3 selected. After chronological sort: [m0, m1, m2]
    // Scores: m0=5, m1=0, m2=6
    // If we pop() the last, we lose m2 (score 6) — WRONG
    // Correct trim should drop m1 (score 0)
    assert.equal(anchors.length, 3);
    // Verify the scores so trim logic can be tested in integration
    const scores = anchors.map((a) => a.score);
    // Last item should NOT necessarily be lowest score (it's chronological order)
    // This test documents the ordering for the trim P1 fix
    assert.ok(scores[scores.length - 1] > 0, 'last anchor chronologically has non-zero score');
    assert.ok(scores[1] < scores[0], 'middle anchor (filler) should be lowest score');
  });

  it('anchors are sorted by original index (chronological)', () => {
    resetSeq();
    const msgs = Array.from({ length: 10 }, (_, i) =>
      makeMsg({ content: i % 3 === 0 ? 'Redis ```code```' : 'filler', mentions: i % 3 === 0 ? ['opus'] : [] }),
    );
    const anchors = selectAnchors(msgs, ['redis'], 3);
    for (let i = 1; i < anchors.length; i++) {
      const prevIdx = msgs.indexOf(anchors[i - 1].message);
      const currIdx = msgs.indexOf(anchors[i].message);
      assert.ok(prevIdx < currIdx, 'anchors should be in chronological order');
    }
  });
});

// --- Phase C: formatAnchors Tests ---

describe('F148 Phase C: formatAnchors', () => {
  it('produces labeled lines with truncation', () => {
    resetSeq();
    const anchors = [
      {
        message: makeMsg({ content: 'x'.repeat(2000) }),
        score: 10,
        signals: { structural: 5, positional: 5, relevance: 0 },
        isPrimacy: true,
      },
      {
        message: makeMsg({ content: 'short msg' }),
        score: 5,
        signals: { structural: 2, positional: 0, relevance: 3 },
        isPrimacy: false,
      },
    ];
    const lines = formatAnchors(anchors, 500);
    assert.equal(lines.length, 2);
    assert.ok(
      lines[0].startsWith('[Thread opener @'),
      `primacy should be labeled with speaker, got: ${lines[0].slice(0, 40)}`,
    );
    assert.ok(lines[0].length < 600, 'should truncate long content');
    assert.ok(lines[1].includes('short msg'));
  });

  it('returns empty for no anchors', () => {
    assert.deepStrictEqual(formatAnchors([], 500), []);
  });

  it('prefers source.label over getSenderName for connector-origin anchors (cloud P2)', () => {
    resetSeq();
    const anchors = [
      {
        message: makeMsg({
          catId: null,
          content: 'CI build failed on commit abc123',
          source: { label: 'GitHub CI' },
        }),
        score: 4,
        signals: { structural: 2, positional: 0, relevance: 2 },
        isPrimacy: false,
      },
    ];
    const lines = formatAnchors(anchors, 500);
    assert.equal(lines.length, 1);
    assert.ok(
      lines[0].includes('GitHub CI'),
      `connector anchor should show source.label 'GitHub CI', got: ${lines[0]}`,
    );
    assert.ok(!lines[0].includes('铲屎官'), `connector anchor must NOT be misattributed as 铲屎官, got: ${lines[0]}`);
  });

  it('includes speaker name in anchor labels (Bug: missing speaker attribution)', () => {
    resetSeq();
    const anchors = [
      {
        message: makeMsg({ catId: null, content: 'What should we do about Redis config?' }),
        score: 5,
        signals: { structural: 0, positional: 5, relevance: 0 },
        isPrimacy: true,
      },
      {
        message: makeMsg({ catId: 'opus', content: 'I suggest we use cluster mode' }),
        score: 3,
        signals: { structural: 1, positional: 0, relevance: 2 },
        isPrimacy: false,
      },
    ];
    const lines = formatAnchors(anchors, 500);
    assert.equal(lines.length, 2);
    assert.ok(lines[0].includes('铲屎官'), `user anchor should show '铲屎官', got: ${lines[0]}`);
    assert.ok(
      lines[1].includes('opus') || lines[1].includes('宪宪') || lines[1].includes('布偶猫'),
      `cat anchor should include speaker name, got: ${lines[1]}`,
    );
  });
});

// --- Phase D: AC-D1 — Read ops tracking ---

import { TranscriptWriter } from '../dist/domains/cats/services/session/TranscriptWriter.js';

describe('Phase D: toolNameToOp read ops (AC-D1)', () => {
  const session = {
    sessionId: 'sess-d1',
    threadId: 'thread-d1',
    catId: 'cat-d1',
    cliSessionId: 'cli-d1',
    seq: 0,
  };
  const sealTs = { createdAt: 1000000, sealedAt: 1060000 };

  it('tracks Read tool as read op in filesTouched', () => {
    const tw = new TranscriptWriter({ dataDir: '/tmp/test-d1' });
    tw.appendEvent(session, {
      type: 'tool_use',
      toolName: 'Read',
      toolInput: { file_path: 'src/index.ts' },
    });
    const digest = tw.generateExtractiveDigest(session, sealTs);
    const entry = digest.filesTouched.find((f) => f.path === 'src/index.ts');
    assert.ok(entry, 'src/index.ts should appear in filesTouched');
    assert.ok(entry.ops.includes('read'), `ops should include 'read', got: ${JSON.stringify(entry.ops)}`);
  });

  it('tracks Grep tool as read op', () => {
    const tw = new TranscriptWriter({ dataDir: '/tmp/test-d1' });
    tw.appendEvent(session, {
      type: 'tool_use',
      toolName: 'Grep',
      toolInput: { path: 'src/', pattern: 'foo' },
    });
    const digest = tw.generateExtractiveDigest(session, sealTs);
    const entry = digest.filesTouched.find((f) => f.path === 'src/');
    assert.ok(entry, 'src/ should appear in filesTouched');
    assert.ok(entry.ops.includes('read'), `ops should include 'read', got: ${JSON.stringify(entry.ops)}`);
  });

  it('tracks Glob tool as read op', () => {
    const tw = new TranscriptWriter({ dataDir: '/tmp/test-d1' });
    tw.appendEvent(session, {
      type: 'tool_use',
      toolName: 'Glob',
      toolInput: { path: 'src/components' },
    });
    const digest = tw.generateExtractiveDigest(session, sealTs);
    const entry = digest.filesTouched.find((f) => f.path === 'src/components');
    assert.ok(entry, 'src/components should appear in filesTouched');
    assert.ok(entry.ops.includes('read'), `ops should include 'read', got: ${JSON.stringify(entry.ops)}`);
  });

  it('file with both read and edit shows both ops', () => {
    const tw = new TranscriptWriter({ dataDir: '/tmp/test-d1' });
    tw.appendEvent(session, {
      type: 'tool_use',
      toolName: 'Read',
      toolInput: { file_path: 'src/config.ts' },
    });
    tw.appendEvent(session, {
      type: 'tool_use',
      toolName: 'Edit',
      toolInput: { file_path: 'src/config.ts' },
    });
    const digest = tw.generateExtractiveDigest(session, sealTs);
    const entry = digest.filesTouched.find((f) => f.path === 'src/config.ts');
    assert.ok(entry, 'src/config.ts should appear in filesTouched');
    assert.ok(entry.ops.includes('read'), 'should have read op');
    assert.ok(entry.ops.includes('edit'), 'should have edit op');
  });
});

// --- Phase D: AC-D2 — CoverageMap ---

describe('Phase D: buildCoverageMap (AC-D2)', () => {
  it('produces valid coverage map with all fields', () => {
    const map = buildCoverageMap({
      omitted: { count: 22, from: 1000, to: 2000, participants: ['user-1', 'opus'] },
      burst: { count: 8, from: 2000, to: 3000 },
      anchorIds: ['msg-5', 'msg-10'],
      threadMemory: { available: true, sessionsIncorporated: 3 },
      retrievalHints: ['Ask about Redis config decisions'],
    });
    assert.equal(map.omitted.count, 22);
    assert.equal(map.omitted.timeRange.from, 1000);
    assert.equal(map.omitted.timeRange.to, 2000);
    assert.deepStrictEqual(map.omitted.participants, ['user-1', 'opus']);
    assert.equal(map.burst.count, 8);
    assert.equal(map.burst.timeRange.from, 2000);
    assert.equal(map.burst.timeRange.to, 3000);
    assert.deepStrictEqual(map.anchorIds, ['msg-5', 'msg-10']);
    assert.deepStrictEqual(map.threadMemory, { available: true, sessionsIncorporated: 3 });
    assert.deepStrictEqual(map.retrievalHints, ['Ask about Redis config decisions']);
  });

  it('handles zero omitted messages', () => {
    const map = buildCoverageMap({
      omitted: { count: 0, from: 0, to: 0, participants: [] },
      burst: { count: 5, from: 1000, to: 2000 },
      anchorIds: [],
      threadMemory: null,
      retrievalHints: [],
    });
    assert.equal(map.omitted.count, 0);
    assert.equal(map.anchorIds.length, 0);
    assert.equal(map.threadMemory, null);
  });

  it('produces JSON-serializable output', () => {
    const map = buildCoverageMap({
      omitted: { count: 10, from: 1000, to: 2000, participants: ['user-1'] },
      burst: { count: 3, from: 2000, to: 3000 },
      anchorIds: ['msg-1'],
      threadMemory: { available: true, sessionsIncorporated: 1 },
      retrievalHints: [],
    });
    const json = JSON.stringify(map);
    const parsed = JSON.parse(json);
    assert.deepStrictEqual(parsed, map);
  });
});
