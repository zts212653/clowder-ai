/**
 * ConciergeReplyValidator tests (F229 KD-23)
 *
 * Scans duty cat reply text for [跳过去 R{n}] and [原地看 R{n}] markers.
 * Looks up HandleEntry[] (per-invocation flowing table) → validates anchor → returns CardBlock actions.
 * Fail-closed: unknown handle → no action (no error).
 *
 * KD-23: No HandleMapStore — handle table is a per-invocation value, never stored.
 */

import assert from 'node:assert/strict';
import { before, beforeEach, describe, it } from 'node:test';

let formatConciergeHandleBinding;
let computeConciergeHandleDigest;
let normalizeConciergeHandleTitle;

before(async () => {
  const contextMod = await import('../dist/domains/concierge/concierge-search-context.js');
  formatConciergeHandleBinding = contextMod.formatConciergeHandleBinding;
  computeConciergeHandleDigest = contextMod.computeConciergeHandleDigest;
  normalizeConciergeHandleTitle = contextMod.normalizeConciergeHandleTitle;
});

function binding(entry) {
  return formatConciergeHandleBinding(entry.label, entry.anchor);
}

function marker(verb, entry) {
  return `[${verb} ${binding(entry)}]`;
}

describe('extractConciergeActions', () => {
  let extractConciergeActions;

  beforeEach(async () => {
    const validatorMod = await import('../dist/domains/concierge/concierge-reply-validator.js');
    extractConciergeActions = validatorMod.extractConciergeActions;
  });

  it('extracts teleport action from a bound R1 marker', () => {
    const handles = [
      { label: 'R1', anchor: { threadId: 'thread_abc', messageId: 'msg_123', title: 'F229 讨论', type: 'thread' } },
    ];

    const actions = extractConciergeActions(`你可以看看 ${marker('跳过去', handles[0])} 里的讨论`, handles);
    assert.equal(actions.length, 1);
    assert.equal(actions[0].action, 'concierge_teleport');
    assert.equal(actions[0].payload.threadId, 'thread_abc');
    assert.equal(actions[0].payload.messageId, 'msg_123');
    assert.equal(actions[0].label, '跳过去：F229 讨论');
    // Bug2 AC-1: handle+verb for inline marker rendering
    assert.equal(actions[0].handle, 'R1');
    assert.equal(actions[0].verb, '跳过去');
  });

  it('resolves a title-bound marker only when handle and title name the same entry', () => {
    const handles = [
      { label: 'R2', anchor: { threadId: 'thread_feature', title: 'f229 猫猫球功能', type: 'thread' } },
      { label: 'R3', anchor: { threadId: 'thread_bug', title: '猫猫球传送门bug', type: 'thread' } },
    ];

    const actions = extractConciergeActions(`找到了 ${marker('跳过去', handles[1])}`, handles);
    assert.equal(actions.length, 1);
    assert.equal(actions[0].handle, 'R3');
    assert.equal(actions[0].payload.threadId, 'thread_bug');
  });

  it('rejects the production R2/R3 semantic mismatch', () => {
    const handles = [
      { label: 'R2', anchor: { threadId: 'thread_feature', title: 'f229 猫猫球功能', type: 'thread' } },
      { label: 'R3', anchor: { threadId: 'thread_bug', title: '猫猫球传送门bug', type: 'thread' } },
    ];

    const intendedBinding = binding(handles[1]);
    const actions = extractConciergeActions(
      `PR 在「猫猫球传送门bug」thread 提的。[跳过去 ${intendedBinding.replace(/^R3/, 'R2')}]`,
      handles,
    );
    assert.deepStrictEqual(actions, [], 'a valid ordinal must still fail closed when its bound title disagrees');
  });

  it('rejects a wrong ordinal even when two results have the same normalized title', () => {
    const handles = [
      { label: 'R2', anchor: { threadId: 'thread_feature', title: '同名讨论', type: 'thread' } },
      { label: 'R3', anchor: { threadId: 'thread_bug', title: '同名讨论', type: 'thread' } },
    ];
    const intendedBinding = binding(handles[1]);
    const actions = extractConciergeActions(`[跳过去 ${intendedBinding.replace(/^R3/, 'R2')}]`, handles);
    assert.deepStrictEqual(
      actions,
      [],
      'the anchor digest must keep duplicate titles from authenticating the wrong Rn',
    );
  });

  // BUG-UX-12: [原地看 R1] on thread → resolves to teleport (thread = always jump)
  it('resolves [原地看 R1] on thread to teleport (BUG-UX-12)', () => {
    const handles = [
      { label: 'R1', anchor: { threadId: 'thread_abc', messageId: 'msg_456', title: '记忆搜索', type: 'thread' } },
    ];

    const actions = extractConciergeActions(`看看这里 ${marker('原地看', handles[0])}`, handles);
    assert.equal(actions.length, 1);
    assert.equal(actions[0].action, 'concierge_teleport', 'thread → always teleport');
    assert.equal(actions[0].payload.threadId, 'thread_abc');
    assert.equal(actions[0].payload.messageId, 'msg_456');
    assert.equal(actions[0].label, '跳过去：记忆搜索');
    // Bug2 AC-1: handle+verb for inline marker rendering
    assert.equal(actions[0].handle, 'R1');
    assert.equal(actions[0].verb, '原地看', 'original text verb kept for marker matching');
  });

  // BUG-UX-12: both verbs on same thread handle → both resolve to teleport → deduplicated
  it('deduplicates [跳过去] and [原地看] on same thread handle (BUG-UX-12)', () => {
    const handles = [{ label: 'R1', anchor: { threadId: 't1', messageId: 'm1', title: 'Topic A', type: 'thread' } }];

    const actions = extractConciergeActions(
      `你可以 ${marker('跳过去', handles[0])} 或者 ${marker('原地看', handles[0])}`,
      handles,
    );
    assert.equal(actions.length, 1, 'both resolve to teleport → deduplicated');
    assert.equal(actions[0].action, 'concierge_teleport');
  });

  it('extracts multiple R-handles from a single reply', () => {
    const handles = [
      { label: 'R1', anchor: { threadId: 't1', title: 'Topic A', type: 'thread' } },
      { label: 'R2', anchor: { threadId: 't2', messageId: 'm2', title: 'Topic B', type: 'thread' } },
      { label: 'R3', anchor: { threadId: 't3', messageId: 'm3', title: 'Topic C', type: 'thread' } },
    ];

    const actions = extractConciergeActions(
      `R1 讨论了 A ${marker('跳过去', handles[0])}，R2 是 B ${marker('跳过去', handles[1])}，R3 见 ${marker('原地看', handles[2])}`,
      handles,
    );
    assert.equal(actions.length, 3);
    assert.equal(actions[0].payload.threadId, 't1');
    assert.equal(actions[1].payload.threadId, 't2');
    assert.equal(actions[2].payload.threadId, 't3');
  });

  it('fail-closed: unknown R-handle produces no action', () => {
    const handles = [{ label: 'R1', anchor: { threadId: 't1', title: 'Known', type: 'thread' } }];

    const unknown = { label: 'R99', anchor: { threadId: 'missing', title: '不存在', type: 'thread' } };
    const actions = extractConciergeActions(`${marker('跳过去', unknown)} 不存在的 handle`, handles);
    assert.equal(actions.length, 0, 'unknown handle should produce no actions');
  });

  it('no markers → empty actions', () => {
    const handles = [];
    const actions = extractConciergeActions('纯文本回复，没有任何标记', handles);
    assert.deepStrictEqual(actions, []);
  });

  it('deduplicates: same R-handle + same action type → single action', () => {
    const handles = [{ label: 'R1', anchor: { threadId: 't1', title: 'Dup', type: 'thread' } }];

    const actions = extractConciergeActions(
      `${marker('跳过去', handles[0])} 再来一次 ${marker('跳过去', handles[0])}`,
      handles,
    );
    assert.equal(actions.length, 1, 'duplicate should be deduplicated');
  });

  // BUG-UX-9: [原地看 R1] on thread without messageId → auto-correct to teleport (not silently drop)
  it('auto-corrects peek to teleport when anchor is thread without messageId (BUG-UX-9)', () => {
    const handles = [{ label: 'R1', anchor: { threadId: 't_thread_only', title: 'Thread Level', type: 'thread' } }];

    const actions = extractConciergeActions(marker('原地看', handles[0]), handles);
    assert.equal(actions.length, 1, 'auto-corrected to teleport, not dropped');
    assert.equal(actions[0].action, 'concierge_teleport', 'action type auto-corrected');
    assert.equal(actions[0].verb, '原地看', 'original text verb kept for frontend marker matching');
    assert.equal(actions[0].handle, 'R1');
    assert.equal(actions[0].payload.threadId, 't_thread_only');
  });

  // BUG-UX-12 P1: non-thread anchors are not navigable — frontend can only route to real
  // threadIds. Even with messageId, non-thread anchors must not produce actions (previously
  // BUG-UX-9 auto-corrected to peek, but peek is removed from frontend).
  it('skips non-thread anchor with messageId (frontend cannot navigate to feature:F229)', () => {
    const handles = [
      { label: 'R1', anchor: { threadId: 'feature:F229', messageId: 'msg_99', title: 'F229', type: 'feature' } },
    ];

    const actions = extractConciergeActions(marker('跳过去', handles[0]), handles);
    assert.equal(actions.length, 0, 'non-thread anchor must not produce actions (even with messageId)');
  });

  // BUG-UX-9: mixed markers on thread-only — both resolve to teleport, deduplicated
  it('deduplicates when peek auto-corrects to same teleport on thread-only handle', () => {
    const handles = [{ label: 'R1', anchor: { threadId: 't_thread_only', title: 'Thread Level', type: 'thread' } }];

    const actions = extractConciergeActions(
      `${marker('跳过去', handles[0])} 或者 ${marker('原地看', handles[0])}`,
      handles,
    );
    // Both resolve to teleport — should deduplicate to 1
    assert.equal(actions.length, 1, 'deduplicated after auto-correction');
    assert.equal(actions[0].action, 'concierge_teleport');
  });

  // BUG-UX-12: thread anchors → always teleport, even when duty cat wrote [原地看]
  // and anchor has messageId. Concierge actions pointing to threads are semantically
  // jumps — "原地看" confuses users. (operator: "这些按钮本质的含义不是跳转吗？！")
  it('auto-corrects peek to teleport on thread WITH messageId (BUG-UX-12)', () => {
    const handles = [
      { label: 'R1', anchor: { threadId: 'thread_abc', messageId: 'msg_456', title: '记忆搜索', type: 'thread' } },
    ];

    const actions = extractConciergeActions(`看看这里 ${marker('原地看', handles[0])}`, handles);
    assert.equal(actions.length, 1);
    // BUG-UX-12: must be teleport, not peek — thread actions = jump
    assert.equal(actions[0].action, 'concierge_teleport', 'thread anchor must resolve to teleport');
    assert.equal(actions[0].label, '跳过去：记忆搜索', 'label must say 跳过去');
    assert.equal(actions[0].payload.threadId, 'thread_abc');
    assert.equal(actions[0].payload.messageId, 'msg_456', 'messageId preserved for scroll-to');
  });

  // BUG-UX-12: [跳过去 R1] and [原地看 R1] on thread WITH messageId → both teleport → dedup to 1
  it('deduplicates when both verbs resolve to teleport on thread with messageId (BUG-UX-12)', () => {
    const handles = [{ label: 'R1', anchor: { threadId: 't1', messageId: 'm1', title: 'Topic A', type: 'thread' } }];

    const actions = extractConciergeActions(
      `你可以 ${marker('跳过去', handles[0])} 或者 ${marker('原地看', handles[0])}`,
      handles,
    );
    assert.equal(actions.length, 1, 'both resolve to teleport → deduplicated');
    assert.equal(actions[0].action, 'concierge_teleport');
  });

  // Still fail-closed: non-thread without messageId → truly incompatible, skip
  it('still skips when neither teleport nor peek is possible (fail-closed)', () => {
    const handles = [{ label: 'R1', anchor: { threadId: 'feature:F229', title: 'F229', type: 'feature' } }];

    // non-thread, no messageId → can't teleport, can't peek → skip
    const actions = extractConciergeActions(marker('原地看', handles[0]), handles);
    assert.equal(actions.length, 0, 'truly incompatible → still skipped');
  });

  // Cloud P1: non-thread anchors (feature/doc) can't be teleported to —
  // frontend only navigates to real threadIds. Fail-closed: skip teleport for non-thread types.
  it('skips teleport for non-thread anchor types (fail-closed)', () => {
    const handles = [
      { label: 'R1', anchor: { threadId: 'feature:F229', title: 'F229 前台猫', type: 'feature' } },
      { label: 'R2', anchor: { threadId: 'docs/decisions/ADR-030.md', title: 'ADR-030', type: 'doc' } },
    ];

    const actions = extractConciergeActions(
      `${marker('跳过去', handles[0])} 和 ${marker('跳过去', handles[1])}`,
      handles,
    );
    assert.equal(actions.length, 0, 'non-thread anchors must not produce teleport actions');
  });

  it('rejects the whole marker set when a valid thread marker is mixed with a non-thread marker', () => {
    const handles = [
      { label: 'R1', anchor: { threadId: 'thread_a', title: 'Topic A', type: 'thread' } },
      { label: 'R2', anchor: { threadId: 'feature:F229', title: 'F229', type: 'feature' } },
    ];

    const actions = extractConciergeActions(
      `${marker('跳过去', handles[0])} 和 ${marker('跳过去', handles[1])}`,
      handles,
    );
    assert.deepStrictEqual(actions, [], 'a partially trusted marker set must not produce a partial action list');
  });

  it('matches a copied normalized binding against a stored title containing marker delimiters', () => {
    const handles = [
      {
        label: 'R1',
        anchor: { threadId: 'thread_a', title: 'F229 猫猫球 ｜ [concierge]\nfeature', type: 'thread' },
      },
    ];

    const actions = extractConciergeActions(marker('跳过去', handles[0]), handles);
    assert.equal(actions.length, 1);
    assert.equal(actions[0].payload.threadId, 'thread_a');
  });

  it('handles anchor without messageId (thread-level teleport)', () => {
    const handles = [{ label: 'R1', anchor: { threadId: 't_no_msg', title: 'Thread Only', type: 'thread' } }];

    const actions = extractConciergeActions(marker('跳过去', handles[0]), handles);
    assert.equal(actions.length, 1);
    assert.equal(actions[0].payload.threadId, 't_no_msg');
    assert.strictEqual(actions[0].payload.messageId, undefined);
  });

  // KD-23 red-line: handles from previous invocation are not available
  it('KD-23: empty handles = no actions possible (cross-turn fail-closed)', () => {
    // Simulates a new turn with no search results — previous turn's handles are gone
    const oldEntry = { label: 'R1', anchor: { threadId: 'thread_old', title: 'Old Topic', type: 'thread' } };
    const actions = extractConciergeActions(marker('跳过去', oldEntry), []);
    assert.equal(actions.length, 0, 'no handles = no buttons, even if reply references R1');
  });
});

// KD-26: a prefetch candidate table is context, not reply intent. Only an
// explicit, integrity-bound marker may authorize a navigation action.
describe('buildConciergeActions (explicit binding gate)', () => {
  let buildConciergeActions;

  beforeEach(async () => {
    const mod = await import('../dist/domains/concierge/concierge-reply-validator.js');
    buildConciergeActions = mod.buildConciergeActions;
  });

  it('honors curated marker actions when duty cat used markers', async () => {
    const handles = [
      { label: 'R1', anchor: { threadId: 'th1', messageId: 'm1', title: 'A', type: 'thread' } },
      { label: 'R2', anchor: { threadId: 'th2', messageId: 'm2', title: 'B', type: 'thread' } },
    ];

    const actions = await buildConciergeActions(`你可以看 ${marker('跳过去', handles[0])}`, handles);
    // marker present → honor curation (only R1), do NOT dump the full fallback list
    assert.equal(actions.length, 1, 'marker-first: only curated R1');
    assert.equal(actions[0].action, 'concierge_teleport');
    assert.equal(actions[0].payload.threadId, 'th1');
  });

  it('does not run all-results fallback when a marker binding is invalid', async () => {
    const handles = [
      { label: 'R2', anchor: { threadId: 'thread_feature', title: 'f229 猫猫球功能', type: 'thread' } },
      { label: 'R3', anchor: { threadId: 'thread_bug', title: '猫猫球传送门bug', type: 'thread' } },
    ];

    const intendedBinding = binding(handles[1]);
    const actions = await buildConciergeActions(`[跳过去 ${intendedBinding.replace(/^R3/, 'R2')}]`, handles);
    assert.deepStrictEqual(actions, [], 'invalid marker must not degrade into a clickable candidate list');
  });

  it('does not accept a bare ordinal for newly generated actions', async () => {
    const handles = [{ label: 'R1', anchor: { threadId: 'thread_a', title: 'Topic A', type: 'thread' } }];

    const actions = await buildConciergeActions('[跳过去 R1]', handles);
    assert.deepStrictEqual(actions, [], 'bare Rn has no semantic integrity check');
  });

  it('rejects a valid binding mixed with a bare marker before the bare marker can borrow its action', async () => {
    const handles = [{ label: 'R1', anchor: { threadId: 'thread_a', title: 'Topic A', type: 'thread' } }];
    const reply = `${marker('跳过去', handles[0])} legacy copy [跳过去 R1]`;

    const actions = await buildConciergeActions(reply, handles);
    assert.deepStrictEqual(
      actions,
      [],
      'one valid binding must not authorize a bare marker with the same verb and handle',
    );
  });

  it('does not run fallback for malformed marker-like text', async () => {
    const handles = [{ label: 'R1', anchor: { threadId: 'thread_a', title: 'Topic A', type: 'thread' } }];

    const actions = await buildConciergeActions(marker('跳过去', handles[0]).slice(0, -1), handles);
    assert.deepStrictEqual(actions, [], 'a truncated marker is invalid, not marker absence');
  });

  it('treats any reserved marker prefix as an invalid marker instead of enabling fallback', async () => {
    const handles = [{ label: 'R1', anchor: { threadId: 'thread_a', title: 'Topic A', type: 'thread' } }];

    const actions = await buildConciergeActions('[跳过去 看一下]', handles);
    assert.deepStrictEqual(
      actions,
      [],
      'reserved bracket syntax is protocol-like even when its Rn binding is malformed',
    );
  });

  it('accepts a generated marker for a handle whose normalized title would otherwise be empty', async () => {
    const handles = [{ label: 'R1', anchor: { threadId: 'thread_empty', title: '[｜|]\n', type: 'thread' } }];

    const actions = await buildConciergeActions(marker('跳过去', handles[0]), handles);
    assert.equal(actions.length, 1, 'the formatter fallback must produce a validator-accepted marker');
    assert.equal(actions[0].payload.threadId, 'thread_empty');
  });

  it('accepts a generated marker whose canonical title contains markdown-safe metacharacters', async () => {
    const handles = [
      {
        label: 'R1',
        anchor: {
          threadId: 'thread_md',
          title: 'Bug *fix* _audit_ `cmd` \\path [link](target) ~done~',
          type: 'thread',
        },
      },
    ];

    const actions = await buildConciergeActions(marker('跳过去', handles[0]), handles);
    assert.equal(actions.length, 1, 'generated markdown-safe markers must remain copyable');
    assert.equal(actions[0].payload.threadId, 'thread_md');
  });

  it('rejects a raw markdown-control title even with the correct anchor digest', async () => {
    const handles = [
      {
        label: 'R1',
        anchor: {
          threadId: 'thread_md',
          title: 'Bug *fix* _audit_ `cmd` \\path',
          type: 'thread',
        },
      },
    ];
    const rawTitle = normalizeConciergeHandleTitle(handles[0].anchor.title);
    const digest = computeConciergeHandleDigest(handles[0].label, handles[0].anchor);

    const actions = await buildConciergeActions(`[跳过去 R1｜${rawTitle}｜${digest}]`, handles);
    assert.deepStrictEqual(actions, [], 'raw markdown-control titles are not canonical binding titles');
  });

  it('canonicalizes lowercase handles accepted by the marker grammar', async () => {
    const handles = [{ label: 'R1', anchor: { threadId: 'thread_a', title: 'Topic A', type: 'thread' } }];

    const actions = await buildConciergeActions(
      marker('跳过去', handles[0]).replace('[跳过去 R1', '[跳过去 r1'),
      handles,
    );
    assert.equal(actions.length, 1);
    assert.equal(actions[0].handle, 'R1');
    assert.equal(actions[0].payload.threadId, 'thread_a');
  });

  it('rejects a marker with an empty bound title', async () => {
    const handles = [{ label: 'R1', anchor: { threadId: 'thread_a', title: 'Topic A', type: 'thread' } }];

    const emptyTitleEntry = { label: 'R1', anchor: { ...handles[0].anchor, title: '[｜|]\n' } };
    const delimiterOnlyMarker = marker('跳过去', emptyTitleEntry).replace('｜未命名记录｜', '｜｜');
    const actions = await buildConciergeActions(delimiterOnlyMarker, handles);
    assert.deepStrictEqual(actions, [], 'an empty title cannot authenticate a handle');
  });

  it('does not turn unrelated prefetched thread candidates into reply actions', async () => {
    const handles = Array.from({ length: 8 }, (_, index) => ({
      label: `R${index + 1}`,
      anchor: {
        threadId: `thread_unrelated_${index + 1}`,
        title: `无关的历史推荐 ${index + 1}`,
        type: 'thread',
      },
    }));

    const reply = '找到了 PR #2998 和 PR #2930 对应的两个 thread；本轮没有它们的完整绑定，所以不生成传送按钮。';
    const actions = await buildConciergeActions(reply, handles);

    assert.deepStrictEqual(actions, [], 'candidate recall must not impersonate reply intent');
  });

  it('does not infer navigation authority from a plain-text title mention', async () => {
    const handles = [{ label: 'R1', anchor: { threadId: 'thread_target', title: '正确的 thread', type: 'thread' } }];

    const actions = await buildConciergeActions('我找到了「正确的 thread」，但没有完整绑定。', handles);
    assert.deepStrictEqual(actions, [], 'title text alone is not an integrity-bound action');
  });

  it('uses one separately verified tool anchor when the reply has no marker', async () => {
    const verifiedToolAnchor = {
      threadId: 'thread_verified',
      messageId: 'message_verified',
      title: '工具已核验的 thread',
      type: 'thread',
    };

    const actions = await buildConciergeActions('找到了正确来源。', [], undefined, verifiedToolAnchor);

    assert.deepStrictEqual(actions, [
      {
        action: 'concierge_teleport',
        label: '跳过去：工具已核验的 thread',
        payload: { threadId: 'thread_verified', messageId: 'message_verified' },
      },
    ]);
  });

  it('does not let a verified tool anchor bypass malformed marker syntax', async () => {
    const verifiedToolAnchor = {
      threadId: 'thread_verified',
      title: '工具已核验的 thread',
      type: 'thread',
    };

    const actions = await buildConciergeActions('[跳过去 R1] 但工具找到了来源', [], undefined, verifiedToolAnchor);
    assert.deepStrictEqual(actions, [], 'invalid marker syntax remains an invocation-wide fail-closed signal');
  });

  it('keeps an explicit valid marker ahead of a separately verified tool anchor', async () => {
    const handles = [{ label: 'R1', anchor: { threadId: 'thread_marker', title: '显式目标', type: 'thread' } }];
    const verifiedToolAnchor = {
      threadId: 'thread_verified',
      title: '工具目标',
      type: 'thread',
    };

    const actions = await buildConciergeActions(marker('跳过去', handles[0]), handles, undefined, verifiedToolAnchor);
    assert.equal(actions.length, 1);
    assert.equal(actions[0].payload.threadId, 'thread_marker');
  });

  it('returns empty when handles empty and no markers', async () => {
    const actions = await buildConciergeActions('纯文本', []);
    assert.deepStrictEqual(actions, []);
  });

  // KD-23 red-line: different handle tables per invocation produce different buttons
  it('KD-23: each invocation resolves only against its own bound handle table', async () => {
    const handlesA = [{ label: 'R1', anchor: { threadId: 'thread_old', title: 'Old Topic', type: 'thread' } }];
    const handlesB = [{ label: 'R1', anchor: { threadId: 'thread_new', title: 'New Topic', type: 'thread' } }];

    const actionsA = await buildConciergeActions(marker('跳过去', handlesA[0]), handlesA);
    const actionsB = await buildConciergeActions(marker('跳过去', handlesB[0]), handlesB);

    assert.equal(actionsA[0].payload.threadId, 'thread_old');
    assert.equal(actionsB[0].payload.threadId, 'thread_new');
    // The BUG: with HandleMapStore, handlesB would OVERWRITE handlesA, so
    // if someone reads from store after B wrote, they'd get wrong data for A's turn.
    // KD-23: each call gets its own table, no cross-contamination possible.
  });
});

// ---------------------------------------------------------------------------
// Phase B: extractTriagePlanActions — <!-- triage-plan --> marker parsing
// ---------------------------------------------------------------------------
describe('extractTriagePlanActions (Phase B)', () => {
  let extractTriagePlanActions;
  let extractTriagePlanIdsFromActions;
  let buildConciergeActions;
  let MemoryConciergeTriagePlanStore;

  beforeEach(async () => {
    const mod = await import('../dist/domains/concierge/concierge-reply-validator.js');
    extractTriagePlanActions = mod.extractTriagePlanActions;
    extractTriagePlanIdsFromActions = mod.extractTriagePlanIdsFromActions;
    buildConciergeActions = mod.buildConciergeActions;
    const storeMod = await import('../dist/domains/concierge/ConciergeTriagePlanStore.js');
    MemoryConciergeTriagePlanStore = storeMod.MemoryConciergeTriagePlanStore;
  });

  function makeDeps(store, participants = ['codex']) {
    return {
      triagePlanStore: store || new MemoryConciergeTriagePlanStore(),
      userId: 'test-user',
      sourceMessageId: 'msg-src-1',
      targetCatsResolverDeps: {
        messageStore: { getByThread: async () => [] },
        threadStore: { getParticipants: async () => participants },
      },
    };
  }

  it('extracts relay triage plan from an R-handle target and resolves targetCats', async () => {
    const triageStore = new MemoryConciergeTriagePlanStore();
    const handles = [
      { label: 'R1', anchor: { threadId: 'thread_abc', messageId: 'msg_123', title: '砚砚的 thread', type: 'thread' } },
    ];
    const text = `好的，我帮你传话：

<!-- triage-plan -->
**意图**: relay
**目标**: ${binding(handles[0])}
**原文**: 帮我问砚砚 bug 修了没
**操作**: 传话给砚砚询问 bug 修复状态
<!-- /triage-plan -->

请确认以上操作。`;

    const actions = await extractTriagePlanActions(text, handles, makeDeps(triageStore));
    assert.equal(actions.length, 2); // confirm + cancel
    assert.equal(actions[0].action, 'concierge_triage_confirm');
    assert.equal(actions[0].payload.intent, 'relay');
    assert.equal(actions[0].payload.threadId, 'thread_abc');
    assert.ok(actions[0].payload.planId);
    assert.ok(actions[0].payload.summary);
    assert.equal(actions[1].action, 'concierge_triage_cancel');
    assert.equal(actions[1].payload.planId, actions[0].payload.planId);

    // Verify plan was persisted
    const plan = await triageStore.get(actions[0].payload.planId);
    assert.ok(plan);
    assert.equal(plan.intent, 'relay');
    assert.equal(plan.status, 'proposed');
    assert.equal(plan.originalText, '帮我问砚砚 bug 修了没');
    assert.equal(plan.target.threadId, 'thread_abc');
    assert.equal(plan.target.threadTitle, '砚砚的 thread');
    assert.deepStrictEqual(plan.target.targetCats, ['codex']);
  });

  it('keeps a bracketed bound relay target in the triage confirmation path', async () => {
    const triageStore = new MemoryConciergeTriagePlanStore();
    const handles = [{ label: 'R1', anchor: { threadId: 'thread_abc', title: '砚砚的 thread', type: 'thread' } }];
    const text = `<!-- triage-plan -->
**意图**: relay
**目标**: ${marker('跳过去', handles[0])}
**原文**: 帮我问砚砚 bug 修了没
**操作**: 传话给砚砚询问 bug 修复状态
<!-- /triage-plan -->`;

    const actions = await buildConciergeActions(text, handles, makeDeps(triageStore));

    assert.deepStrictEqual(
      actions.map((action) => action.action),
      ['concierge_triage_confirm', 'concierge_triage_cancel'],
      'a displayed bound marker in the target field must not fall through to a plain teleport',
    );
    assert.equal(actions[0].payload.intent, 'relay');
    assert.equal(actions[0].payload.threadId, 'thread_abc');
  });

  it('keeps markers in a failed relay control block out of ordinary actions', async () => {
    const handles = [
      { label: 'R1', anchor: { threadId: 'thread_hidden', title: 'Hidden target', type: 'thread' } },
      { label: 'R2', anchor: { threadId: 'thread_visible', title: 'Visible target', type: 'thread' } },
    ];
    const text = `Visible choice: ${marker('跳过去', handles[1])}

<!-- triage-plan -->
**意图**: relay
**目标**: ${marker('跳过去', handles[0])}
**原文**: 帮我问隐藏目标
**操作**: 传话
<!-- /triage-plan -->`;

    const actions = await buildConciergeActions(text, handles, makeDeps(undefined, []));

    assert.deepStrictEqual(
      actions.map((action) => action.payload.threadId),
      ['thread_visible'],
      'an unresolved triage plan must not lend its hidden marker to the ordinary scanner',
    );
  });

  it('does not revive candidate fallback after triage extraction fails', async () => {
    const handles = [
      { label: 'R1', anchor: { threadId: 'thread_hidden', title: 'Hidden target', type: 'thread' } },
      { label: 'R2', anchor: { threadId: 'thread_fallback', title: 'Fallback target', type: 'thread' } },
    ];
    const text = `No visible markers here.

<!-- triage-plan -->
**意图**: invalid_thing
**目标**: ${marker('跳过去', handles[0])}
**原文**: hidden
**操作**: hidden
<!-- /triage-plan -->`;

    const actions = await buildConciergeActions(text, handles, makeDeps());

    assert.deepStrictEqual(actions, [], 'neither hidden control data nor prefetch candidates authorize navigation');
  });

  it('strips triage control data even when extraction deps are unavailable', async () => {
    const handles = [
      { label: 'R1', anchor: { threadId: 'thread_hidden', title: 'Hidden target', type: 'thread' } },
      { label: 'R2', anchor: { threadId: 'thread_visible', title: 'Visible target', type: 'thread' } },
    ];
    const text = `${marker('跳过去', handles[1])}

<!-- triage-plan -->
**意图**: relay
**目标**: ${marker('跳过去', handles[0])}
**原文**: hidden
**操作**: hidden
<!-- /triage-plan -->`;

    const actions = await buildConciergeActions(text, handles);

    assert.deepStrictEqual(
      actions.map((action) => action.payload.threadId),
      ['thread_visible'],
      'control-data isolation must not depend on triage extraction availability',
    );
  });

  it('strips every complete triage block before ordinary marker scanning', async () => {
    const handles = [
      { label: 'R1', anchor: { threadId: 'thread_hidden_1', title: 'Hidden one', type: 'thread' } },
      { label: 'R2', anchor: { threadId: 'thread_hidden_2', title: 'Hidden two', type: 'thread' } },
      { label: 'R3', anchor: { threadId: 'thread_visible', title: 'Visible target', type: 'thread' } },
    ];
    const block = (entry) => `<!-- triage-plan -->
**意图**: invalid_thing
**目标**: ${marker('跳过去', entry)}
**原文**: hidden
**操作**: hidden
<!-- /triage-plan -->`;
    const text = `${marker('跳过去', handles[2])}\n${block(handles[0])}\n${block(handles[1])}`;

    const actions = await buildConciergeActions(text, handles, makeDeps());

    assert.deepStrictEqual(
      actions.map((action) => action.payload.threadId),
      ['thread_visible'],
      'no hidden block may survive into the ordinary scanner',
    );
  });

  it('treats a dangling triage open block as control data through end of reply', async () => {
    const handles = [
      { label: 'R1', anchor: { threadId: 'thread_hidden', title: 'Hidden target', type: 'thread' } },
      { label: 'R2', anchor: { threadId: 'thread_visible', title: 'Visible target', type: 'thread' } },
    ];
    const text = `${marker('跳过去', handles[1])}

<!-- triage-plan -->
**意图**: relay
**目标**: ${marker('跳过去', handles[0])}`;

    const actions = await buildConciergeActions(text, handles, makeDeps());

    assert.deepStrictEqual(
      actions.map((action) => action.payload.threadId),
      ['thread_visible'],
      'a malformed hidden block must not leak marker authority',
    );
  });

  it('extracts go triage plan from an R-handle target', async () => {
    const triageStore = new MemoryConciergeTriagePlanStore();
    const handles = [{ label: 'R2', anchor: { threadId: 'thread_f229', title: 'F229 讨论 thread', type: 'thread' } }];
    const text = `<!-- triage-plan -->
**意图**: go
**目标**: ${binding(handles[0])}
**原文**: 带我去看看 F229 的讨论
**操作**: 跳转到 F229 讨论 thread
<!-- /triage-plan -->`;

    const actions = await extractTriagePlanActions(text, handles, makeDeps(triageStore));
    assert.equal(actions.length, 2);
    assert.equal(actions[0].payload.intent, 'go');
    assert.equal(actions[0].payload.threadId, 'thread_f229');
    assert.ok(actions[0].label.includes('确认跳转'));
  });

  it('accepts the displayed bracketed binding for a go triage target', async () => {
    const handles = [{ label: 'R2', anchor: { threadId: 'thread_f229', title: 'F229 讨论 thread', type: 'thread' } }];
    const text = `<!-- triage-plan -->
**意图**: go
**目标**: ${marker('跳过去', handles[0])}
**原文**: 带我去看看 F229 的讨论
**操作**: 跳转到 F229 讨论 thread
<!-- /triage-plan -->`;

    const actions = await extractTriagePlanActions(text, handles, makeDeps());

    assert.equal(actions[0]?.action, 'concierge_triage_confirm');
    assert.equal(actions[0]?.payload.intent, 'go');
    assert.equal(actions[0]?.payload.threadId, 'thread_f229');
  });

  it('requires the go target handle and title to bind to the same entry', async () => {
    const handles = [
      { label: 'R2', anchor: { threadId: 'thread_feature', title: 'f229 猫猫球功能', type: 'thread' } },
      { label: 'R3', anchor: { threadId: 'thread_bug', title: '猫猫球传送门bug', type: 'thread' } },
    ];
    const valid = `<!-- triage-plan -->
**意图**: go
**目标**: ${binding(handles[1])}
**原文**: 带我去 bug thread
**操作**: 跳转
<!-- /triage-plan -->`;
    const mismatch = valid.replace('R3｜', 'R2｜');

    const validActions = await extractTriagePlanActions(valid, handles, makeDeps());
    const mismatchActions = await extractTriagePlanActions(mismatch, handles, makeDeps());

    assert.equal(validActions[0].payload.threadId, 'thread_bug');
    assert.deepStrictEqual(mismatchActions, []);
  });

  it('extracts propose_thread triage plan', async () => {
    const store = new MemoryConciergeTriagePlanStore();
    const handles = [];
    const text = `<!-- triage-plan -->
**意图**: propose_thread
**目标**: Redis 性能调查
**原文**: 帮我开个新 thread 调查 Redis 性能
**操作**: 开新 thread 调查 Redis 性能问题
<!-- /triage-plan -->`;

    const actions = await extractTriagePlanActions(text, handles, makeDeps(store));
    assert.equal(actions.length, 2);
    const plan = await store.get(actions[0].payload.planId);
    assert.equal(plan.intent, 'propose_thread');
    assert.equal(plan.target.query, 'Redis 性能调查');
  });

  it('returns empty for text without triage-plan markers', async () => {
    const actions = await extractTriagePlanActions('普通回复文本', [], makeDeps());
    assert.deepStrictEqual(actions, []);
  });

  it('returns empty for invalid intent', async () => {
    const text = `<!-- triage-plan -->
**意图**: invalid_thing
**目标**: something
**原文**: test
**操作**: test
<!-- /triage-plan -->`;

    const actions = await extractTriagePlanActions(text, [], makeDeps());
    assert.deepStrictEqual(actions, []);
  });

  it('returns empty for missing intent field', async () => {
    const text = `<!-- triage-plan -->
**目标**: something
**原文**: test
<!-- /triage-plan -->`;

    const actions = await extractTriagePlanActions(text, [], makeDeps());
    assert.deepStrictEqual(actions, []);
  });

  it('fail-closed: relay/go free-text target does not create a non-dispatchable plan', async () => {
    const triageStore = new MemoryConciergeTriagePlanStore();
    const text = `<!-- triage-plan -->
**意图**: relay
**目标**: 砚砚的 thread
**原文**: 帮我问砚砚
**操作**: 传话
<!-- /triage-plan -->`;

    const actions = await extractTriagePlanActions(text, [], makeDeps(triageStore));
    assert.deepStrictEqual(actions, []);
    assert.deepStrictEqual(await triageStore.listByUser('test-user'), []);
  });

  it('P1: relay target with ambiguous cats creates user-selectable confirm actions', async () => {
    const triageStore = new MemoryConciergeTriagePlanStore();
    const handles = [{ label: 'R1', anchor: { threadId: 'thread_abc', title: '多人 thread', type: 'thread' } }];
    const text = `<!-- triage-plan -->
**意图**: relay
**目标**: ${binding(handles[0])}
**原文**: 帮我问问
**操作**: 传话
<!-- /triage-plan -->`;

    const actions = await extractTriagePlanActions(text, handles, makeDeps(triageStore, ['codex', 'opus']));
    assert.equal(actions.length, 3); // one confirm per candidate + cancel
    assert.equal(actions[0].action, 'concierge_triage_confirm');
    assert.deepStrictEqual(actions[0].payload.targetCats, ['codex']);
    assert.ok(actions[0].label.includes('@codex'));
    assert.equal(actions[1].action, 'concierge_triage_confirm');
    assert.deepStrictEqual(actions[1].payload.targetCats, ['opus']);
    assert.ok(actions[1].label.includes('@opus'));
    assert.equal(actions[2].action, 'concierge_triage_cancel');

    const plans = await triageStore.listByUser('test-user');
    assert.equal(plans.length, 1);
    assert.equal(plans[0].intent, 'relay');
    assert.deepStrictEqual(plans[0].target.candidateCats, ['codex', 'opus']);
    assert.equal(plans[0].target.targetCats, undefined);
  });

  it('P1: extracts triage plan ids from confirm/cancel actions for assistant-message linking', () => {
    const ids = extractTriagePlanIdsFromActions([
      { action: 'concierge_triage_confirm', label: '确认', payload: { planId: 'plan-1' } },
      { action: 'concierge_triage_cancel', label: '取消', payload: { planId: 'plan-1' } },
      { action: 'concierge_triage_confirm', label: '确认', payload: { planId: 'plan-2' } },
      { action: 'concierge_teleport', label: '跳过去', payload: { threadId: 'thread-1' } },
    ]);

    assert.deepStrictEqual(ids, ['plan-1', 'plan-2']);
  });
});

// ---------------------------------------------------------------------------
// Cloud P2 fix: stripTriagePlanMarkers
// ---------------------------------------------------------------------------
describe('stripTriagePlanMarkers (cloud P2)', () => {
  let stripTriagePlanMarkers;

  before(async () => {
    const mod = await import('../dist/domains/concierge/concierge-reply-validator.js');
    stripTriagePlanMarkers = mod.stripTriagePlanMarkers;
  });

  it('strips triage-plan block and collapses extra newlines', () => {
    const text = `好的，我帮你传话：

<!-- triage-plan -->
**意图**: relay
**目标**: R1
**原文**: 帮我问砚砚 bug 修了没
**操作**: 传话给砚砚询问 bug 修复状态
<!-- /triage-plan -->

请确认以上操作。`;

    const result = stripTriagePlanMarkers(text);
    assert.ok(!result.includes('<!-- triage-plan -->'), 'opening marker should be stripped');
    assert.ok(!result.includes('<!-- /triage-plan -->'), 'closing marker should be stripped');
    assert.ok(!result.includes('**意图**'), 'plan fields should be stripped');
    assert.ok(result.includes('好的，我帮你传话'), 'surrounding text should be preserved');
    assert.ok(result.includes('请确认以上操作'), 'surrounding text should be preserved');
    // No triple+ newlines
    assert.ok(!result.includes('\n\n\n'), 'should not have 3+ consecutive newlines');
  });

  it('returns text unchanged when no markers present', () => {
    const text = '普通回复文本，没有 markers';
    assert.strictEqual(stripTriagePlanMarkers(text), text);
  });

  it('handles markers at the very start/end of text', () => {
    const text = `<!-- triage-plan -->
**意图**: go
**目标**: R2
<!-- /triage-plan -->`;

    const result = stripTriagePlanMarkers(text);
    assert.strictEqual(result, '');
  });
});
