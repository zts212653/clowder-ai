import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const { extractBatonContext, summarizeActiveTasks, formatNavigationHeader } = await import(
  '../dist/domains/cats/services/agents/routing/navigation-context.js'
);

describe('extractBatonContext', () => {
  const messages = [
    { id: 'm1', catId: 'codex', content: '我在干活，你别动', timestamp: 1000, userId: 'u1' },
    { id: 'm2', catId: 'codex', content: '@opus 帮我看看这个\n还有别的问题', timestamp: 2000, userId: 'u1' },
    { id: 'm3', catId: null, content: '@opus 你觉得呢？', timestamp: 3000, userId: 'user1' },
  ];

  it('finds last @ mention directed at target cat', () => {
    const baton = extractBatonContext(messages, 'opus');
    assert.equal(baton.fromMessageId, 'm3');
    assert.equal(baton.fromSpeaker, 'user');
    assert.equal(baton.timestamp, 3000);
  });

  it('extracts mention excerpt (first line of @ message)', () => {
    const baton = extractBatonContext(messages.slice(0, 2), 'opus');
    assert.ok(baton.mentionExcerpt.includes('帮我看看'));
  });

  it('identifies cat speaker by catId', () => {
    const baton = extractBatonContext(messages.slice(0, 2), 'opus');
    assert.equal(baton.fromSpeaker, 'codex');
    assert.equal(baton.fromSpeakerDisplay, '缅因猫');
  });

  it('identifies human speaker as "user"', () => {
    const baton = extractBatonContext(messages, 'opus');
    assert.equal(baton.fromSpeaker, 'user');
    assert.equal(baton.fromSpeakerDisplay, '铲屎官');
  });

  it('detects stale hold contradiction', () => {
    // codex said "别动" at t=1000, then @opus at t=2000 — same speaker held then passed
    const baton = extractBatonContext(messages.slice(0, 2), 'opus');
    assert.equal(baton.staleHoldWarning, true);
  });

  it('no stale hold when different speaker @ mentions', () => {
    // user (not codex) @opus — the hold was from codex, not user
    const baton = extractBatonContext(messages, 'opus');
    assert.equal(baton.staleHoldWarning, false);
  });

  it('does not false-positive on code keyword "await" (P2 fix)', () => {
    const msgs = [
      { id: 'm30', catId: 'codex', content: 'await doWork()', timestamp: 1000, userId: 'u1' },
      { id: 'm31', catId: 'codex', content: '@opus 帮看下', timestamp: 2000, userId: 'u1' },
    ];
    const baton = extractBatonContext(msgs, 'opus');
    assert.equal(baton.staleHoldWarning, false);
  });

  it('returns null when no @ found', () => {
    const baton = extractBatonContext([messages[0]], 'opus');
    assert.equal(baton, null);
  });

  it('handles @ in middle of content', () => {
    const msgs = [{ id: 'm10', catId: null, content: '看看这个 @opus 帮忙', timestamp: 5000, userId: 'u2' }];
    const baton = extractBatonContext(msgs, 'opus');
    assert.ok(baton !== null);
    assert.equal(baton.fromMessageId, 'm10');
  });

  it('ignores @ for other cats', () => {
    const msgs = [{ id: 'm20', catId: null, content: '@codex 帮忙', timestamp: 6000, userId: 'u3' }];
    const baton = extractBatonContext(msgs, 'opus');
    assert.equal(baton, null);
  });

  it('blanks excerpt for stream-origin messages (P1-R2: visibility boundary)', () => {
    const msgs = [
      {
        id: 'm40',
        catId: 'codex',
        content: '@opus 我内部在想这个方案不太行',
        timestamp: 1000,
        userId: 'u1',
        origin: 'stream',
      },
    ];
    const baton = extractBatonContext(msgs, 'opus');
    assert.ok(baton !== null);
    assert.equal(baton.fromSpeaker, 'codex');
    assert.equal(baton.mentionExcerpt, '', 'stream excerpt must be blank — thinking content is not visible');
  });

  it('preserves excerpt for non-stream messages', () => {
    const msgs = [
      { id: 'm41', catId: 'codex', content: '@opus 帮我看看这个', timestamp: 1000, userId: 'u1', origin: 'callback' },
    ];
    const baton = extractBatonContext(msgs, 'opus');
    assert.ok(baton.mentionExcerpt.includes('帮我看看'));
  });

  it('does not false-positive on work status "我在想怎么做" (P2-R2)', () => {
    const msgs = [
      { id: 'm50', catId: 'codex', content: '我在想这个怎么做，先看下日志', timestamp: 1000, userId: 'u1' },
      { id: 'm51', catId: 'codex', content: '@opus 帮看下', timestamp: 2000, userId: 'u1' },
    ];
    const baton = extractBatonContext(msgs, 'opus');
    assert.equal(baton.staleHoldWarning, false, '"我在想怎么做" is work status, not hold');
  });

  it('does not false-positive on "正在review" (P2-R2)', () => {
    const msgs = [
      { id: 'm52', catId: 'codex', content: '正在review代码', timestamp: 1000, userId: 'u1' },
      { id: 'm53', catId: 'codex', content: '@opus 看完了帮忙合入', timestamp: 2000, userId: 'u1' },
    ];
    const baton = extractBatonContext(msgs, 'opus');
    assert.equal(baton.staleHoldWarning, false, '"正在review" is work status, not hold');
  });

  it('ignores stream-origin hold for stale-hold detection (cloud P2)', () => {
    const msgs = [
      { id: 'm60', catId: 'codex', content: '别动，等我看完这段代码', timestamp: 1000, userId: 'u1', origin: 'stream' },
      { id: 'm61', catId: 'codex', content: '@opus 帮我看看', timestamp: 2000, userId: 'u1', origin: 'callback' },
    ];
    const baton = extractBatonContext(msgs, 'opus');
    assert.equal(baton.staleHoldWarning, false, 'stream thinking hold should not trigger stale warning');
  });

  it('finds baton via canonical mentions field (alias @宪宪 → catId opus)', () => {
    const msgs = [
      { id: 'm70', catId: null, content: '@宪宪 帮我看看这个', timestamp: 1000, userId: 'u1', mentions: ['opus'] },
    ];
    const baton = extractBatonContext(msgs, 'opus');
    assert.ok(baton !== null, 'mentions.includes("opus") should match even without @opus in text');
    assert.equal(baton.fromMessageId, 'm70');
  });

  it('finds baton when mentions metadata present but no @ in text', () => {
    const msgs = [
      { id: 'm71', catId: 'codex', content: '帮我看看这个 PR', timestamp: 2000, userId: 'u1', mentions: ['opus'] },
    ];
    const baton = extractBatonContext(msgs, 'opus');
    assert.ok(baton !== null, 'should find baton from mentions even without any @ in content');
    assert.equal(baton.fromMessageId, 'm71');
  });

  it('falls back to regex when mentions is empty array (safeParseMentions legacy)', () => {
    const msgs = [
      { id: 'm80', catId: 'codex', content: '@opus 帮我看看', timestamp: 1000, userId: 'u1', mentions: [] },
    ];
    const baton = extractBatonContext(msgs, 'opus');
    assert.ok(baton !== null, 'empty mentions[] must fall back to regex, not silently miss @opus');
    assert.equal(baton.fromMessageId, 'm80');
  });

  it('strips all @mentions from excerpt, not just target (P3: multi-mention)', () => {
    const msgs = [
      {
        id: 'm90',
        catId: null,
        content: '@opus @gemini 帮我看看这个',
        timestamp: 1000,
        userId: 'u1',
        mentions: ['opus', 'gemini'],
      },
    ];
    const baton = extractBatonContext(msgs, 'opus');
    assert.ok(baton !== null);
    assert.ok(
      !baton.mentionExcerpt.includes('@'),
      `excerpt "${baton.mentionExcerpt}" should not contain any @mentions`,
    );
    assert.ok(baton.mentionExcerpt.includes('帮我看看'));
  });

  it('strips Chinese @mentions from excerpt (P2-R2: Unicode handles)', () => {
    const msgs = [
      {
        id: 'm92',
        catId: null,
        content: '@宪宪 帮我看看这个',
        timestamp: 1000,
        userId: 'u1',
        mentions: ['opus'],
      },
    ];
    const baton = extractBatonContext(msgs, 'opus');
    assert.ok(baton !== null);
    assert.ok(
      !baton.mentionExcerpt.includes('@'),
      `excerpt "${baton.mentionExcerpt}" should not contain Chinese @mentions`,
    );
    assert.ok(baton.mentionExcerpt.includes('帮我看看'));
  });

  it('strips mixed Chinese+ASCII @mentions from excerpt (P2-R2)', () => {
    const msgs = [
      {
        id: 'm93',
        catId: null,
        content: '@opus @烁烁 一起验收',
        timestamp: 1000,
        userId: 'u1',
        mentions: ['opus', 'gemini'],
      },
    ];
    const baton = extractBatonContext(msgs, 'opus');
    assert.ok(baton !== null);
    assert.ok(
      !baton.mentionExcerpt.includes('@'),
      `excerpt "${baton.mentionExcerpt}" should not contain any @mentions`,
    );
    assert.ok(baton.mentionExcerpt.includes('验收'));
  });

  it('strips inline @mentions when target cat is not first (P3)', () => {
    const msgs = [
      {
        id: 'm91',
        catId: 'codex',
        content: '@gemini @opus 验收一下猫粮',
        timestamp: 2000,
        userId: 'u1',
        mentions: ['gemini', 'opus'],
      },
    ];
    const baton = extractBatonContext(msgs, 'opus');
    assert.ok(baton !== null);
    assert.ok(
      !baton.mentionExcerpt.includes('@'),
      `excerpt "${baton.mentionExcerpt}" should not contain any @mentions`,
    );
    assert.ok(baton.mentionExcerpt.includes('验收'));
  });

  it('shows 铲屎官 instead of internal userId for human speaker display (Bug: default-user leak)', () => {
    const msgs = [{ id: 'm100', catId: null, content: '@opus 帮我看看', timestamp: 1000, userId: 'default-user' }];
    const baton = extractBatonContext(msgs, 'opus');
    assert.ok(baton !== null);
    assert.equal(
      baton.fromSpeakerDisplay,
      '铲屎官',
      `expected '铲屎官', got '${baton.fromSpeakerDisplay}' — internal userId leaked to display`,
    );
  });

  it('prefers source.label for connector-origin baton messages (cloud P2)', () => {
    const msgs = [
      {
        id: 'm110',
        catId: null,
        content: '@opus CI pipeline failed',
        timestamp: 1000,
        userId: 'system',
        source: { label: 'GitHub CI' },
      },
    ];
    const baton = extractBatonContext(msgs, 'opus');
    assert.ok(baton !== null);
    assert.equal(baton.fromSpeakerDisplay, 'GitHub CI', 'connector baton must show source.label, not 铲屎官');
  });

  it('still detects real hold instructions after P2-R2 narrowing', () => {
    const holdPhrases = ['别动，我来', '你等等', '稍等一下', 'hold on', 'wait for me'];
    for (const phrase of holdPhrases) {
      const msgs = [
        { id: 'h0', catId: 'codex', content: phrase, timestamp: 1000, userId: 'u1' },
        { id: 'h1', catId: 'codex', content: '@opus 好了你来', timestamp: 2000, userId: 'u1' },
      ];
      const baton = extractBatonContext(msgs, 'opus');
      assert.equal(baton.staleHoldWarning, true, `"${phrase}" should trigger stale hold`);
    }
  });
});

describe('summarizeActiveTasks', () => {
  it('returns top 3 non-done tasks sorted by recency', () => {
    const tasks = [
      { id: 't1', title: 'Fix Redis bug', status: 'todo', ownerCatId: 'opus', updatedAt: 1000 },
      { id: 't2', title: 'Review PR #900', status: 'in-progress', ownerCatId: 'codex', updatedAt: 3000 },
      { id: 't3', title: 'Write tests', status: 'done', ownerCatId: 'opus', updatedAt: 4000 },
      { id: 't4', title: 'Deploy v2', status: 'todo', ownerCatId: null, updatedAt: 2000 },
      { id: 't5', title: 'Phase F plan', status: 'in-progress', ownerCatId: 'opus', updatedAt: 5000 },
    ];
    const result = summarizeActiveTasks(tasks);
    assert.equal(result.length, 3);
    assert.equal(result[0].title, 'Phase F plan');
    assert.ok(result.every((t) => t.status !== 'done'));
  });

  it('returns empty for no tasks', () => {
    assert.deepEqual(summarizeActiveTasks([]), []);
  });

  it('caps at 3 even with many active tasks', () => {
    const tasks = Array.from({ length: 10 }, (_, i) => ({
      id: `t${i}`,
      title: `Task ${i}`,
      status: 'todo',
      ownerCatId: 'opus',
      updatedAt: i * 1000,
    }));
    assert.equal(summarizeActiveTasks(tasks).length, 3);
  });
});

describe('formatNavigationHeader', () => {
  it('formats baton with @ message excerpt', () => {
    const header = formatNavigationHeader({
      baton: {
        fromMessageId: 'm1',
        fromSpeaker: 'codex',
        fromSpeakerDisplay: 'codex',
        timestamp: 1000,
        mentionExcerpt: '帮我看看这个 PR 的 Redis 改动',
        staleHoldWarning: false,
      },
      tasks: [{ id: 't1', title: 'Fix Redis', status: 'in-progress', ownerCatId: 'opus' }],
    });
    assert.ok(header.includes('codex'));
    assert.ok(header.includes('帮我看看'));
    assert.ok(header.includes('Fix Redis'));
  });

  it('includes stale hold warning when present', () => {
    const header = formatNavigationHeader({
      baton: {
        fromMessageId: 'm1',
        fromSpeaker: 'codex',
        fromSpeakerDisplay: 'codex',
        timestamp: 1000,
        mentionExcerpt: '看一下',
        staleHoldWarning: true,
      },
      tasks: [],
    });
    assert.ok(header.includes('⚠️'));
  });

  it('handles missing baton and tasks gracefully', () => {
    const header = formatNavigationHeader({ baton: null, tasks: [] });
    assert.ok(header.includes('[导航]'));
    assert.ok(!header.includes('undefined'));
  });

  it('does not include intent labels (KD-8)', () => {
    const header = formatNavigationHeader({
      baton: {
        fromMessageId: 'm1',
        fromSpeaker: 'user',
        fromSpeakerDisplay: 'user1',
        timestamp: 1000,
        mentionExcerpt: '帮我 review 这个',
        staleHoldWarning: false,
      },
      tasks: [],
    });
    assert.ok(!header.includes('intent'));
    assert.ok(!header.includes('分类'));
    assert.ok(!header.includes('type:'));
  });

  it('shows task owner as 未分配 when null', () => {
    const header = formatNavigationHeader({
      baton: null,
      tasks: [{ id: 't1', title: 'Deploy', status: 'todo', ownerCatId: null }],
    });
    assert.ok(header.includes('未分配'));
  });
});
