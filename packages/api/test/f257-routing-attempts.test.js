/**
 * F257 V1 — RoutingAttemptDraft red baseline.
 *
 * Semantics single source of truth: T-A (§3.4) in
 * docs/features/assets/F257/objective-driven-redesign-v1.md (v2.3.2 FINAL).
 * Tests assert behavior per T-A rows by outcome name; definitions are NOT
 * restated here — when a test contradicts T-A, T-A wins.
 *
 * Covers (per T-A "V1 实现动作" column, full set):
 *  - one draft per unique source span (attempt-stream uniqueness contract)
 *  - tokenOrdinal assigned once after all passes merge, ordered by span start
 *  - parser 改造①: self_excluded tokenized (a2a)
 *  - parser 改造②: unknown_token emitted before line break (a2a)
 *  - (右截断): cap ≠ truncated — read-only scan must confirm extra
 *    metric-affecting tokens before truncated=true / batch metricEligible=false
 *  - parser 改造③: duplicate = distinct-span-same-target only; same-span
 *    re-visit is a traversal artifact (merged silently, outcome unchanged)
 *  - parser 改造④: group keywords classified before unknown (user mode)
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const ROUTING_DIR = '../dist/domains/cats/services/agents/routing';

async function loadA2A() {
  const { ensureCatRegistryPopulated } = await import('./helpers/agent-registry-helpers.js');
  await ensureCatRegistryPopulated();
  return import(`${ROUTING_DIR}/a2a-mentions.js`);
}

async function loadAttemptModule() {
  return import(`${ROUTING_DIR}/routing-attempt.js`);
}

function createNoopService(catId) {
  return {
    invoke: async function* () {
      yield { type: 'done', catId, timestamp: Date.now() };
    },
  };
}

function createNoopRegistry() {
  return {
    create: () => ({ invocationId: 'inv-1', callbackToken: 'cb-1' }),
    update: () => {},
    get: () => null,
  };
}

function createNoopMessageStore() {
  return {
    append: () => ({}),
    getRecent: () => [],
    getMentionsFor: () => [],
    getByThreadBefore: () => [],
    getByThreadAfter: () => [],
    getById: () => null,
    softDelete: () => null,
    restore: () => null,
  };
}

async function createRouter() {
  const { AgentRouter } = await import(`${ROUTING_DIR}/AgentRouter.js`);
  const { migrateRouterOpts } = await import('./helpers/agent-registry-helpers.js');
  return new AgentRouter(
    await migrateRouterOpts({
      claudeService: createNoopService('opus'),
      codexService: createNoopService('codex'),
      geminiService: createNoopService('gemini'),
      registry: createNoopRegistry(),
      messageStore: createNoopMessageStore(),
    }),
  );
}

function outcomes(batch) {
  return batch.attempts.map((a) => a.outcome);
}

function assertOrdinalsSortedBySpan(batch) {
  const sorted = [...batch.attempts].sort((a, b) => a.span.start - b.span.start || a.span.end - b.span.end);
  assert.deepEqual(
    batch.attempts.map((a) => a.tokenOrdinal),
    batch.attempts.map((_, i) => i),
    'tokenOrdinal must be 0-based consecutive',
  );
  assert.deepEqual(
    sorted.map((a) => a.tokenOrdinal),
    batch.attempts.map((_, i) => i),
    'tokenOrdinal order must equal span-start order (assigned once after merge)',
  );
}

// ---------------------------------------------------------------------------
// parserMode=a2a (analyzeA2AMentions)
// ---------------------------------------------------------------------------

describe('F257 T-A parserMode=a2a: attempt batch shape', () => {
  it('emits exactly one draft per token with spans and ordinals (resolved x2)', async () => {
    const { analyzeA2AMentions } = await loadA2A();
    const r = analyzeA2AMentions('@opus @codex 请看', 'kimi');
    assert.deepEqual(r.mentions, ['opus', 'codex'], 'routing behavior unchanged');
    const batch = r.attemptBatch;
    assert.equal(batch.parserMode, 'a2a');
    assert.equal(batch.spanBasis, 'a2a_normalized');
    assert.equal(batch.truncated, false);
    assert.equal(batch.metricEligible, true);
    assert.equal(batch.attempts.length, 2);
    assert.deepEqual(outcomes(batch), ['resolved', 'resolved']);
    assert.deepEqual(batch.attempts[0].span, { start: 0, end: 5 });
    assert.deepEqual(batch.attempts[1].span, { start: 6, end: 12 });
    assert.equal(batch.attempts[0].token, '@opus');
    assert.equal(batch.attempts[1].token, '@codex');
    assert.equal(batch.attempts[0].targetCatId, 'opus');
    assert.equal(batch.attempts[1].targetCatId, 'codex');
    assertOrdinalsSortedBySpan(batch);
  });

  it('returns an empty eligible batch for empty text', async () => {
    const { analyzeA2AMentions } = await loadA2A();
    const batch = analyzeA2AMentions('', 'opus').attemptBatch;
    assert.equal(batch.parserMode, 'a2a');
    assert.deepEqual(batch.attempts, []);
    assert.equal(batch.truncated, false);
    assert.equal(batch.metricEligible, true);
  });

  it('does not tokenize prose lines (non-line-start mentions produce no attempts)', async () => {
    const { analyzeA2AMentions } = await loadA2A();
    const r = analyzeA2AMentions('之前布偶猫说的 @布偶猫 方案不错', 'codex');
    assert.deepEqual(r.mentions, []);
    assert.deepEqual(r.attemptBatch.attempts, []);
  });

  it('does not tokenize mentions inside fenced code blocks', async () => {
    const { analyzeA2AMentions } = await loadA2A();
    const r = analyzeA2AMentions('```\n@codex review\n```\n@opus 看下', 'kimi');
    assert.deepEqual(r.mentions, ['opus']);
    assert.deepEqual(outcomes(r.attemptBatch), ['resolved']);
    assert.equal(r.attemptBatch.attempts[0].targetCatId, 'opus');
  });
});

describe('F257 T-A parserMode=a2a: self_excluded (parser 改造①)', () => {
  it('tokenizes a self mention as self_excluded and keeps scanning the line', async () => {
    const { analyzeA2AMentions } = await loadA2A();
    const r = analyzeA2AMentions('@opus @codex 接力', 'opus');
    // 改造① behavior change: previously the self token aborted the line and
    // @codex was silently dropped; per T-A the self token is tokenized and skipped.
    assert.deepEqual(r.mentions, ['codex']);
    assert.deepEqual(outcomes(r.attemptBatch), ['self_excluded', 'resolved']);
    assert.equal(r.attemptBatch.attempts[0].targetCatId, 'opus');
    assert.equal(r.attemptBatch.attempts[1].targetCatId, 'codex');
    assertOrdinalsSortedBySpan(r.attemptBatch);
  });

  it('tokenizes a self alias as self_excluded (no routing)', async () => {
    const { analyzeA2AMentions } = await loadA2A();
    // P1-4: @宪宪 removed from opus breed patterns → use @布偶猫 (still a valid opus alias)
    const r = analyzeA2AMentions('@布偶猫 我自己说的', 'opus');
    assert.deepEqual(r.mentions, []);
    assert.deepEqual(outcomes(r.attemptBatch), ['self_excluded']);
  });

  it('repeated self tokens are each self_excluded (priority row 1 beats duplicate)', async () => {
    const { analyzeA2AMentions } = await loadA2A();
    const r = analyzeA2AMentions('@opus @codex\n@布偶猫 hmm', 'opus');
    assert.deepEqual(r.mentions, ['codex']);
    assert.deepEqual(outcomes(r.attemptBatch), ['self_excluded', 'resolved', 'self_excluded']);
    assertOrdinalsSortedBySpan(r.attemptBatch);
  });
});

describe('F257 T-A parserMode=a2a: unknown_token (parser 改造②)', () => {
  it('emits unknown_token before abandoning the line, later lines still scanned', async () => {
    const { analyzeA2AMentions } = await loadA2A();
    const r = analyzeA2AMentions('@zzzcat 看看\n@codex 你来', 'kimi');
    assert.deepEqual(r.mentions, ['codex'], 'routing behavior unchanged');
    assert.deepEqual(outcomes(r.attemptBatch), ['unknown_token', 'resolved']);
    assert.equal(r.attemptBatch.attempts[0].token, '@zzzcat');
    assert.equal(r.attemptBatch.attempts[0].targetCatId, undefined);
    assertOrdinalsSortedBySpan(r.attemptBatch);
  });

  it('extracts CJK unknown token up to the next boundary', async () => {
    const { analyzeA2AMentions } = await loadA2A();
    const r = analyzeA2AMentions('@不存在的猫 帮我看看', 'kimi');
    assert.deepEqual(r.mentions, []);
    assert.deepEqual(outcomes(r.attemptBatch), ['unknown_token']);
    assert.equal(r.attemptBatch.attempts[0].token, '@不存在的猫');
  });

  it('same-line tokens after unknown_token stay unscanned (break preserved)', async () => {
    const { analyzeA2AMentions } = await loadA2A();
    const r = analyzeA2AMentions('@zzzcat @codex', 'kimi');
    assert.deepEqual(r.mentions, [], 'routing behavior unchanged');
    assert.deepEqual(outcomes(r.attemptBatch), ['unknown_token']);
  });
});

describe('F257 T-A parserMode=a2a: disabled_cat and duplicate', () => {
  it('tokenizes a disabled cat as disabled_cat with routing warning preserved', async () => {
    const { analyzeA2AMentions } = await loadA2A();
    const r = analyzeA2AMentions('@antigravity 帮看下', 'kimi');
    assert.deepEqual(r.mentions, []);
    assert.equal(r.routing_warnings.length, 1);
    assert.equal(r.routing_warnings[0].kind, 'cat_disabled');
    assert.deepEqual(outcomes(r.attemptBatch), ['disabled_cat']);
    assert.equal(r.attemptBatch.attempts[0].targetCatId, r.routing_warnings[0].catId);
  });

  it('repeated disabled tokens are each disabled_cat (priority row 2 beats duplicate), warning stays deduped', async () => {
    const { analyzeA2AMentions } = await loadA2A();
    const r = analyzeA2AMentions('@antigravity @斑斑 都是它', 'kimi');
    assert.equal(r.routing_warnings.length, 1, 'warning dedup unchanged');
    assert.deepEqual(outcomes(r.attemptBatch), ['disabled_cat', 'disabled_cat']);
  });

  it('duplicate = distinct span pointing at an already-resolved target', async () => {
    const { analyzeA2AMentions } = await loadA2A();
    const r = analyzeA2AMentions('@opus @布偶猫 同一只', 'kimi');
    assert.deepEqual(r.mentions, ['opus'], 'routing behavior unchanged');
    assert.deepEqual(outcomes(r.attemptBatch), ['resolved', 'duplicate']);
    assert.equal(r.attemptBatch.attempts[1].targetCatId, 'opus');
    assert.equal(r.attemptBatch.metricEligible, true, 'duplicate does not invalidate the batch');
  });
});

describe('F257 T-A parserMode=a2a: (右截断) read-only truncation scan', () => {
  it('exactly cap resolved targets with no further tokens → NOT truncated', async () => {
    const { analyzeA2AMentions } = await loadA2A();
    const r = analyzeA2AMentions('@opus @codex', 'kimi');
    assert.deepEqual(r.mentions, ['opus', 'codex']);
    assert.equal(r.attemptBatch.truncated, false);
    assert.equal(r.attemptBatch.metricEligible, true);
  });

  it('cap followed by prose (no further tokens) → NOT truncated', async () => {
    const { analyzeA2AMentions } = await loadA2A();
    const r = analyzeA2AMentions('@opus @codex 后面是散文\n纯散文行', 'kimi');
    assert.equal(r.attemptBatch.truncated, false);
    assert.equal(r.attemptBatch.metricEligible, true);
    assert.equal(r.attemptBatch.attempts.length, 2);
  });

  it('cap + additional resolvable token → truncated, batch not metric eligible, no post-cap drafts', async () => {
    const { analyzeA2AMentions } = await loadA2A();
    const r = analyzeA2AMentions('@opus @codex @gemini', 'kimi');
    assert.deepEqual(r.mentions, ['opus', 'codex'], 'routing behavior unchanged');
    assert.equal(r.attemptBatch.truncated, true);
    assert.equal(r.attemptBatch.metricEligible, false);
    assert.deepEqual(outcomes(r.attemptBatch), ['resolved', 'resolved'], 'post-cap tokens get no drafts');
  });

  it('cap + additional token on a later line → truncated', async () => {
    const { analyzeA2AMentions } = await loadA2A();
    const r = analyzeA2AMentions('@opus\n@codex\n@gemini 看下', 'kimi');
    assert.equal(r.attemptBatch.truncated, true);
    assert.equal(r.attemptBatch.metricEligible, false);
  });

  it('cap + trailing duplicate-only token → NOT truncated (duplicate is not metric-affecting)', async () => {
    const { analyzeA2AMentions } = await loadA2A();
    const r = analyzeA2AMentions('@opus @codex @布偶猫', 'kimi');
    assert.equal(r.attemptBatch.truncated, false);
    assert.equal(r.attemptBatch.metricEligible, true);
    assert.equal(r.attemptBatch.attempts.length, 2);
  });

  it('cap + trailing unknown token → truncated (metric-affecting token per bias rationale)', async () => {
    const { analyzeA2AMentions } = await loadA2A();
    const r = analyzeA2AMentions('@opus @codex @zzzcat', 'kimi');
    assert.equal(r.attemptBatch.truncated, true);
    assert.equal(r.attemptBatch.metricEligible, false);
  });

  it('cap + trailing self token → truncated (self_excluded is denominator-eligible)', async () => {
    const { analyzeA2AMentions } = await loadA2A();
    const r = analyzeA2AMentions('@opus @codex @kimi', 'kimi');
    assert.equal(r.attemptBatch.truncated, true);
    assert.equal(r.attemptBatch.metricEligible, false);
  });
});

// ---------------------------------------------------------------------------
// parserMode=user (AgentRouter.parseMentionsRaw)
// ---------------------------------------------------------------------------

describe('F257 T-A parserMode=user: attempt batch shape', () => {
  it('emits drafts for prose mentions with user batch flags', async () => {
    const router = await createRouter();
    const r = router.parseMentionsRaw('hello 请 @codex 看下这个问题');
    assert.equal(r.mentions.length, 1);
    const batch = r.attemptBatch;
    assert.equal(batch.parserMode, 'user');
    assert.equal(batch.spanBasis, 'lowercased_message');
    assert.equal(batch.truncated, false);
    assert.equal(batch.metricEligible, true);
    assert.deepEqual(outcomes(batch), ['resolved']);
    assert.equal(batch.attempts[0].targetCatId, 'codex');
    assert.equal(batch.attempts[0].token, '@codex');
  });

  it('same span visited by route-line and prose passes yields ONE draft with original outcome', async () => {
    const router = await createRouter();
    // sol R7 P1-1 regression: the second traversal must not reclassify the
    // token as duplicate — traversal artifact merges silently.
    const r = router.parseMentionsRaw('@codex 修一下这个 bug');
    assert.deepEqual(outcomes(r.attemptBatch), ['resolved']);
    assert.equal(r.attemptBatch.attempts[0].targetCatId, 'codex');
  });

  it('duplicate = distinct spans resolving to the same cat', async () => {
    const router = await createRouter();
    const r = router.parseMentionsRaw('@codex 先看，然后 @缅因猫 再确认');
    assert.equal(r.mentions.length, 1, 'routing folds to one mention');
    assert.deepEqual(outcomes(r.attemptBatch), ['resolved', 'duplicate']);
    assert.equal(r.attemptBatch.attempts[1].targetCatId, 'codex');
    assertOrdinalsSortedBySpan(r.attemptBatch);
  });

  it('unknown handles draft unknown_token per distinct span (warning stays deduped)', async () => {
    const router = await createRouter();
    const r = router.parseMentionsRaw('找 @nonexistentcat 帮忙，再找一次 @nonexistentcat');
    assert.equal(r.routing_warnings.length, 1, 'warning dedup unchanged');
    assert.equal(r.routing_warnings[0].kind, 'cat_not_found');
    assert.deepEqual(outcomes(r.attemptBatch), ['unknown_token', 'unknown_token']);
    assertOrdinalsSortedBySpan(r.attemptBatch);
  });

  it('disabled cat drafts disabled_cat in user mode', async () => {
    const router = await createRouter();
    const r = router.parseMentionsRaw('请 @antigravity 看看');
    assert.equal(r.routing_warnings.length, 1);
    assert.equal(r.routing_warnings[0].kind, 'cat_disabled');
    assert.deepEqual(outcomes(r.attemptBatch), ['disabled_cat']);
  });
});

describe('F257 T-A parserMode=user: group_keyword_skip (parser 改造④)', () => {
  it('route-line @all is classified group_keyword_skip, not unknown_token', async () => {
    const router = await createRouter();
    const r = router.parseMentionsRaw('@all 大家集合');
    const groupDrafts = r.attemptBatch.attempts.filter((a) => a.outcome === 'group_keyword_skip');
    assert.equal(groupDrafts.length, 1);
    assert.equal(groupDrafts[0].token, '@all');
    assert.equal(
      r.attemptBatch.attempts.filter((a) => a.outcome === 'unknown_token').length,
      0,
      'group keyword must not fall through to unknown_token',
    );
  });

  it('mid-prose @全体 is classified group_keyword_skip', async () => {
    const router = await createRouter();
    const r = router.parseMentionsRaw('大家注意 @全体 集合了');
    const groupDrafts = r.attemptBatch.attempts.filter((a) => a.outcome === 'group_keyword_skip');
    assert.equal(groupDrafts.length, 1);
    assert.equal(groupDrafts[0].token, '@全体');
  });

  it('group keyword with non-boundary continuation is NOT a group keyword', async () => {
    const router = await createRouter();
    const r = router.parseMentionsRaw('看下 @allxyz 这个');
    assert.deepEqual(outcomes(r.attemptBatch), ['unknown_token']);
  });
});

describe('F257 T-A parserMode=user: domain_suffixed_skip', () => {
  it('cat pattern with domain suffix drafts domain_suffixed_skip', async () => {
    const router = await createRouter();
    const r = router.parseMentionsRaw('部署到 @opus.dev 这个域名');
    assert.deepEqual(r.mentions, [], 'routing behavior unchanged');
    assert.deepEqual(outcomes(r.attemptBatch), ['domain_suffixed_skip']);
  });

  it('domain-like unknown handle drafts domain_suffixed_skip (not unknown_token)', async () => {
    const router = await createRouter();
    const r = router.parseMentionsRaw('联系 @example.com 这个地址');
    assert.equal(r.routing_warnings.length, 0, 'no warning for domain-like handles (unchanged)');
    assert.deepEqual(outcomes(r.attemptBatch), ['domain_suffixed_skip']);
  });
});

describe('F257 T-A parserMode=user: unknown_token Unicode handles (sol R1 P1-2)', () => {
  it('CJK unknown handle emits exactly one unknown_token draft + warning', async () => {
    const router = await createRouter();
    const r = router.parseMentionsRaw('请 @不存在的猫 看看');
    assert.deepEqual(outcomes(r.attemptBatch), ['unknown_token']);
    assert.equal(r.attemptBatch.attempts[0].token, '@不存在的猫');
    assert.ok(r.routing_warnings.length >= 1, 'unknown handle must surface a routing warning');
  });

  it('CJK unknown handle terminates at CJK punctuation boundary', async () => {
    const router = await createRouter();
    const r = router.parseMentionsRaw('@幽灵猫，在吗');
    assert.deepEqual(outcomes(r.attemptBatch), ['unknown_token']);
    assert.equal(r.attemptBatch.attempts[0].token, '@幽灵猫');
  });

  it('regression: ASCII unknown / domain-shaped / email behavior unchanged', async () => {
    const router = await createRouter();
    const ascii = router.parseMentionsRaw('找 @nonexistentcat 帮忙');
    assert.deepEqual(outcomes(ascii.attemptBatch), ['unknown_token']);
    const domain = router.parseMentionsRaw('联系 @example.com 这个地址');
    assert.deepEqual(outcomes(domain.attemptBatch), ['domain_suffixed_skip']);
    const email = router.parseMentionsRaw('发邮件到 someone@example.com 即可');
    assert.deepEqual(outcomes(email.attemptBatch), [], 'email address is excluded upstream');
  });
});

describe('F257 T-A parserMode=user: speech alias pass span mapping', () => {
  // P1-4: @宪宪/@砚砚 removed from opus/codex breed patterns → use @布偶猫/@缅因猫
  it('speech-only alias drafts one resolved attempt mapped to raw coordinates', async () => {
    const router = await createRouter();
    const r = router.parseMentionsRaw('at 布偶猫 帮个忙');
    assert.equal(r.mentions.length, 1);
    assert.deepEqual(outcomes(r.attemptBatch), ['resolved']);
    assert.equal(r.attemptBatch.attempts[0].targetCatId, 'opus');
    // Raw region "at 布偶猫" = [0, 6) in the original (lowercased) message.
    assert.deepEqual(r.attemptBatch.attempts[0].span, { start: 0, end: 6 });
  });

  it('speech pass re-scan of shifted regular tokens merges into existing drafts (no double count)', async () => {
    const router = await createRouter();
    // Speech replacement before @opus shifts positions in the speech variant;
    // the re-scan must map back to raw coordinates and merge, not double-draft.
    const r = router.parseMentionsRaw('at 缅因猫 先看\n@opus 你好');
    assert.equal(r.attemptBatch.attempts.length, 2, 'exactly one draft per physical token');
    const byCat = Object.fromEntries(r.attemptBatch.attempts.map((a) => [a.targetCatId, a.outcome]));
    assert.deepEqual(byCat, { codex: 'resolved', opus: 'resolved' });
    assertOrdinalsSortedBySpan(r.attemptBatch);
  });
});

describe('F257 T-A parserMode=user: plumbing through resolveTargetsAndIntent', () => {
  it('resolveTargetsAndIntent exposes the user attempt batch', async () => {
    const router = await createRouter();
    const result = await router.resolveTargetsAndIntent('@codex 看下', 'thread-f257-v1');
    assert.ok(result.attemptBatch, 'attemptBatch must be plumbed through');
    assert.equal(result.attemptBatch.parserMode, 'user');
    assert.deepEqual(outcomes(result.attemptBatch), ['resolved']);
  });

  it('group-mention path still carries the individual attempt batch (group keyword drafted, expansion not drafted)', async () => {
    const router = await createRouter();
    const result = await router.resolveTargetsAndIntent('@all 集合', 'thread-f257-v1');
    assert.ok(result.attemptBatch);
    const kinds = result.attemptBatch.attempts.map((a) => a.outcome);
    assert.ok(kinds.includes('group_keyword_skip'));
    assert.equal(
      result.attemptBatch.attempts.filter((a) => a.outcome === 'resolved').length,
      0,
      'group expansion targets must NOT appear as resolved attempts (group mention exits V1)',
    );
  });
});

// ---------------------------------------------------------------------------
// Metric mapping (T-A eligible / success columns as pure functions)
// ---------------------------------------------------------------------------

describe('F257 T-A metric mapping functions', () => {
  it('eligible column: resolved/disabled_cat/self_excluded/unknown_token enter the denominator', async () => {
    const { isMetricEligibleOutcome } = await loadAttemptModule();
    for (const o of ['resolved', 'disabled_cat', 'self_excluded', 'unknown_token', 'ambiguous']) {
      assert.equal(isMetricEligibleOutcome(o), true, `${o} must be denominator-eligible`);
    }
    for (const o of ['duplicate', 'group_keyword_skip', 'domain_suffixed_skip']) {
      assert.equal(isMetricEligibleOutcome(o), false, `${o} must NOT be denominator-eligible`);
    }
  });

  it('success column: only resolved counts as success', async () => {
    const { isSuccessOutcome } = await loadAttemptModule();
    assert.equal(isSuccessOutcome('resolved'), true);
    for (const o of [
      'disabled_cat',
      'self_excluded',
      'unknown_token',
      'duplicate',
      'group_keyword_skip',
      'domain_suffixed_skip',
      'ambiguous',
    ]) {
      assert.equal(isSuccessOutcome(o), false);
    }
  });
});

// ---------------------------------------------------------------------------
// Batch validator cross-field invariants (sol R2 P1-2)
// ---------------------------------------------------------------------------

describe('F257 T-A batch validator: cross-field invariants (sol R2 P1-2)', () => {
  async function loadValidator() {
    const mod = await import(`${ROUTING_DIR}/routing-attempt.js`);
    return mod.isValidRoutingAttemptBatch;
  }

  function validBatch(overrides = {}) {
    return {
      parserMode: 'a2a',
      spanBasis: 'a2a_normalized',
      truncated: false,
      metricEligible: true,
      attempts: [
        { tokenOrdinal: 0, outcome: 'resolved', token: '@opus', span: { start: 0, end: 5 }, targetCatId: 'opus' },
        { tokenOrdinal: 1, outcome: 'unknown_token', token: '@zzz', span: { start: 6, end: 10 } },
      ],
      ...overrides,
    };
  }

  it('accepts a well-formed batch and REAL parser output (round-trip sanity)', async () => {
    const isValid = await loadValidator();
    assert.equal(isValid(validBatch()), true);

    const { analyzeA2AMentions } = await loadA2A();
    const a2a = analyzeA2AMentions('@opus @不存在 请看\n@codex 收尾', 'kimi').attemptBatch;
    assert.equal(isValid(a2a), true, 'a2a parser output must pass its own validator');

    const router = await createRouter();
    const user = router.parseMentionsRaw('请 @codex 看，@all 集合，@幽灵猫 呢，邮箱 a@b.com').attemptBatch;
    assert.equal(isValid(user), true, 'user parser output must pass its own validator');
  });

  it('rejects sol R2 repro: truncated+eligible + resolved without target + loose ordinal', async () => {
    const isValid = await loadValidator();
    assert.equal(
      isValid({
        parserMode: 'a2a',
        spanBasis: 'a2a_normalized',
        truncated: true,
        metricEligible: true,
        attempts: [{ tokenOrdinal: 9, outcome: 'resolved', token: '@opus', span: { start: 0, end: 5 } }],
      }),
      false,
    );
  });

  it('rejects each invariant violation individually', async () => {
    const isValid = await loadValidator();
    // metricEligible must equal !truncated
    assert.equal(isValid(validBatch({ truncated: true })), false);
    assert.equal(isValid(validBatch({ metricEligible: false })), false);
    // user parser has no cap — truncated user batch cannot exist
    assert.equal(
      isValid(
        validBatch({ parserMode: 'user', spanBasis: 'lowercased_message', truncated: true, metricEligible: false }),
      ),
      false,
    );
    // tokenOrdinal must be 0-based consecutive
    assert.equal(
      isValid(
        validBatch({
          attempts: [
            { tokenOrdinal: 1, outcome: 'resolved', token: '@opus', span: { start: 0, end: 5 }, targetCatId: 'opus' },
          ],
        }),
      ),
      false,
    );
    // spans must be strictly increasing by (start, end)
    assert.equal(
      isValid(
        validBatch({
          attempts: [
            { tokenOrdinal: 0, outcome: 'resolved', token: '@opus', span: { start: 6, end: 11 }, targetCatId: 'opus' },
            { tokenOrdinal: 1, outcome: 'unknown_token', token: '@zzz', span: { start: 0, end: 4 } },
          ],
        }),
      ),
      false,
    );
    // sol R3 P1-3: parserMode↔spanBasis pairing is fixed by the finalize call sites
    assert.equal(isValid(validBatch({ spanBasis: 'lowercased_message' })), false);
    // sol R3 P1-3: a present-but-empty target must not enter the exact numerator
    assert.equal(
      isValid(
        validBatch({
          attempts: [
            { tokenOrdinal: 0, outcome: 'resolved', token: '@opus', span: { start: 0, end: 5 }, targetCatId: '' },
          ],
        }),
      ),
      false,
    );
    // sol R3 P1-3: spans are non-overlapping in scan order
    assert.equal(
      isValid(
        validBatch({
          attempts: [
            { tokenOrdinal: 0, outcome: 'resolved', token: '@opus', span: { start: 0, end: 5 }, targetCatId: 'opus' },
            { tokenOrdinal: 1, outcome: 'unknown_token', token: '@zz', span: { start: 3, end: 8 } },
          ],
        }),
      ),
      false,
    );
    // pattern-matched outcomes carry a target; token-skip outcomes never do
    assert.equal(
      isValid(
        validBatch({
          attempts: [{ tokenOrdinal: 0, outcome: 'resolved', token: '@opus', span: { start: 0, end: 5 } }],
        }),
      ),
      false,
    );
    assert.equal(
      isValid(
        validBatch({
          attempts: [
            {
              tokenOrdinal: 0,
              outcome: 'unknown_token',
              token: '@zzz',
              span: { start: 0, end: 4 },
              targetCatId: 'opus',
            },
          ],
        }),
      ),
      false,
    );
  });
});

describe('F257 sol R4 P1-1: provenance write boundary fails closed', () => {
  async function loadStorePort() {
    return import('../dist/domains/cats/services/stores/ports/MessageStore.js');
  }
  const legalBatch = {
    parserMode: 'user',
    spanBasis: 'lowercased_message',
    attempts: [],
    truncated: false,
    metricEligible: true,
  };

  it('routedProvenance throws when a parser lane omits its batch (P1-1a)', async () => {
    const { routedProvenance } = await loadStorePort();
    assert.throws(() => routedProvenance('user', undefined), /requires the parser attempt batch/);
  });

  it('routedProvenance wraps a legal batch as a routed declaration', async () => {
    const { routedProvenance } = await loadStorePort();
    const frag = routedProvenance('user', legalBatch);
    assert.equal(frag.provenance.routed, true);
    assert.equal(frag.provenance.author, 'user');
    assert.equal(frag.provenance.observation, 'original');
    assert.equal(frag.routingFact, legalBatch);
  });

  it('assertProvenanceConsistent rejects a missing declaration (P1-1b)', async () => {
    const { assertProvenanceConsistent } = await loadStorePort();
    assert.throws(() => assertProvenanceConsistent({ catId: null }), /append requires provenance/);
    assert.throws(
      () => assertProvenanceConsistent({ provenance: undefined, catId: 'opus' }),
      /append requires provenance/,
    );
  });

  it('assertProvenanceConsistent rejects out-of-domain author and non-boolean routed (P1-1b)', async () => {
    const { assertProvenanceConsistent } = await loadStorePort();
    assert.throws(
      () =>
        assertProvenanceConsistent({
          provenance: { author: 'ghost', routed: false, observation: 'original' },
          catId: null,
        }),
      /author must be one of/,
    );
    assert.throws(
      () =>
        assertProvenanceConsistent({
          provenance: { author: 'user', routed: 'yes', observation: 'original' },
          catId: null,
        }),
      /routed must be a boolean/,
    );
  });

  it("author 'unknown' carries no catId constraint (P1-2 legacy copy lane)", async () => {
    const { assertProvenanceConsistent } = await loadStorePort();
    assert.doesNotThrow(() =>
      assertProvenanceConsistent({
        provenance: { author: 'unknown', routed: false, observation: 'original' },
        catId: null,
      }),
    );
    assert.doesNotThrow(() =>
      assertProvenanceConsistent({
        provenance: { author: 'unknown', routed: false, observation: 'original' },
        catId: 'opus',
      }),
    );
  });

  it('R6: authenticated operator and external connector authors are disjoint at the write boundary', async () => {
    const { assertProvenanceConsistent, isAuthenticatedOperatorMessage } = await loadStorePort();
    const connectorSource = { connector: 'telegram', label: 'Telegram', icon: 'telegram' };

    assert.throws(
      () =>
        assertProvenanceConsistent({
          provenance: { author: 'user', routed: false, observation: 'original' },
          catId: null,
          source: connectorSource,
        }),
      /authenticated operator.*source/,
    );
    assert.throws(
      () =>
        assertProvenanceConsistent({
          provenance: { author: 'external_user', routed: false, observation: 'original' },
          catId: null,
        }),
      /external_user.*source/,
    );
    assert.doesNotThrow(() =>
      assertProvenanceConsistent({
        provenance: { author: 'external_user', routed: false, observation: 'original' },
        catId: null,
        source: connectorSource,
      }),
    );

    assert.equal(
      isAuthenticatedOperatorMessage({
        provenance: { author: 'user', routed: false, observation: 'original' },
        catId: null,
      }),
      true,
    );
    assert.equal(
      isAuthenticatedOperatorMessage({
        provenance: { author: 'external_user', routed: false, observation: 'original' },
        catId: null,
        source: connectorSource,
      }),
      false,
    );
    assert.equal(
      isAuthenticatedOperatorMessage({
        provenance: { author: 'user', routed: false, observation: 'derived', sourceRef: 'message:old' },
        catId: null,
      }),
      false,
      'derived context is not a fresh authenticated operator assertion',
    );
  });

  it('requires explicit observation lineage and a sourceRef for derived copies', async () => {
    const { assertProvenanceConsistent } = await loadStorePort();
    assert.throws(
      () =>
        assertProvenanceConsistent({
          provenance: { author: 'user', routed: false },
          catId: null,
        }),
      /provenance\.observation must be one of original\|derived/,
    );
    assert.throws(
      () =>
        assertProvenanceConsistent({
          provenance: { author: 'user', routed: false, observation: 'derived' },
          catId: null,
        }),
      /derived provenance requires a non-empty sourceRef/,
    );
    assert.throws(
      () =>
        assertProvenanceConsistent({
          provenance: {
            author: 'user',
            routed: false,
            observation: 'original',
            sourceRef: 'message:source-1',
          },
          catId: null,
        }),
      /original provenance must not carry sourceRef/,
    );
  });
});
