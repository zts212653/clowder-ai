/**
 * L0-budget-defense PR-B-impl tests (ADR-038 件套 ④)
 *
 * Verifies:
 *   - Staging manifest parses + items present
 *   - Hard cap invariant: sum(items.estimated_tokens) ≤ hard_cap_tokens (双层守恒)
 *   - Soft margin warn: sum + soft_margin ≤ hard_cap_tokens (贴线预警)
 *   - buildStagingPrepend returns wipers content for all cats (shared item)
 *   - Wired into buildSystemPrompt output (user-message systemPrompt path)
 *   - Wiper content NOT compiled into native L0 (decoupled from 6000-cap)
 */

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { before, describe, test } from 'node:test';
import { catRegistry } from '@cat-cafe/shared';
import { encodingForModel } from 'js-tiktoken';
import { loadCatConfig, toAllCatConfigs } from '../dist/config/cat-config-loader.js';
import { buildStagingPrepend, loadStagingManifest } from '../dist/domains/cats/services/context/StagingContent.js';
import { buildSystemPrompt } from '../dist/domains/cats/services/context/SystemPromptBuilder.js';

const enc = encodingForModel('gpt-4o');
const tok = (s) => (s ? enc.encode(s, [], []).length : 0);
const hasSourceStagingContent = existsSync(
  new URL('../../../cat-cafe-skills/refs/l0-staging-content.md', import.meta.url),
);
const sourceOnlyTest = hasSourceStagingContent ? test : test.skip;
const publicExportOnlyTest = hasSourceStagingContent ? test.skip : test;

// Bootstrap cat-config so SystemPromptBuilder's getConfig() resolves opus-47 et al.
// Pattern mirrors scripts/compile-system-prompt-l0.mjs bootstrapCatRegistry.
before(() => {
  const loaded = loadCatConfig();
  const all = toAllCatConfigs(loaded);
  for (const [id, config] of Object.entries(all)) {
    if (!catRegistry.has(id)) catRegistry.register(id, config);
  }
});

describe('L0 Staging Protocol PR-B-impl (ADR-038)', () => {
  describe('Public sync missing-file boundary', () => {
    publicExportOnlyTest('raw internal staging content can be absent from public export', () => {
      assert.equal(buildStagingPrepend('opus-47'), '');
      const manifest = loadStagingManifest();
      assert.equal(manifest.hard_cap_tokens, 2000);
      assert.deepEqual(manifest.items, []);
    });
  });

  describe('Manifest parsing', () => {
    sourceOnlyTest('manifest loads with version 1 + items array', () => {
      const m = loadStagingManifest();
      assert.equal(m.staging_version, 1);
      assert.ok(Array.isArray(m.items));
      assert.ok(m.items.length > 0, 'staging manifest must contain at least one item');
    });

    sourceOnlyTest('first item is wipers-clause with first-principles check filled', () => {
      const m = loadStagingManifest();
      const wipers = m.items.find((it) => it.id === 'wipers-clause');
      assert.ok(wipers, 'wipers-clause item must exist as dogfood first case');
      assert.equal(wipers.family, 'shared');
      assert.ok(wipers.estimated_tokens > 0);
      assert.ok(wipers.first_principles_check, 'first-principles check must be filled');
      const fp = wipers.first_principles_check;
      assert.equal(fp.single_round_complete, true);
      assert.equal(fp.compress_gap_harmful, false);
      assert.equal(fp.referenced_by_l0, false);
    });

    sourceOnlyTest(
      'Cloud R1 P1 #2239: every item carries trigger_rate evidence fields (ADR-038 AND 判据条款 1)',
      () => {
        // Cloud R1 P1: manifest schema must enforce trigger-rate evidence,
        // otherwise "first_principles_check + signoff alone" lets any
        // staging-compatible clause slip out of L0 without decay evidence —
        // exactly the ADR's "only 2 is not enough" hole.
        const m = loadStagingManifest();
        for (const item of m.items) {
          assert.ok(
            item.trigger_rate_method,
            `${item.id} missing trigger_rate_method (ADR-038 §Demote 判据 AND 条款 1)`,
          );
          assert.ok(item.trigger_rate_window, `${item.id} missing trigger_rate_window`);
          assert.ok(
            item.trigger_rate_note,
            `${item.id} missing trigger_rate_note (must reference ADR-038 carve-out or telemetry source)`,
          );
        }
      },
    );

    sourceOnlyTest('Cloud R1 P1 #2239: bootstrap-from-L0 reflexes use v1 carve-out method', () => {
      // Items demoted from L0 reflex layer (no telemetry pipeline) must use
      // the explicit cvo-signoff-carveout-v1-bootstrap method. Source-thread
      // investments (e.g. wipers) use a different non-applicable method.
      // Mis-tagging a real L0 demote as "not-applicable" would silently
      // bypass the carve-out boundary.
      //
      // PR-C R2 (cloud R2 L33 #2239): F218 source-audit demote reverted to
      // restore system-role authority — only friction-detection remains as
      // bootstrap-from-L0 demote case in v1.
      const m = loadStagingManifest();
      const bootstrapItems = m.items.filter((it) => it.source?.includes('demote 从 L0'));
      assert.ok(
        bootstrapItems.length >= 1,
        'expected ≥1 bootstrap-from-L0 demoted item (friction-detection; f218 reverted in PR-C R2)',
      );
      for (const item of bootstrapItems) {
        assert.equal(
          item.trigger_rate_method,
          'cvo-signoff-carveout-v1-bootstrap',
          `${item.id} demoted from L0 must use carve-out method`,
        );
        assert.ok(
          item.trigger_rate_note?.includes('telemetry'),
          `${item.id} trigger_rate_note must reference telemetry pipeline gap`,
        );
        assert.ok(
          item.trigger_rate_note?.includes('operator signoff'),
          `${item.id} trigger_rate_note must reference operator signoff substitute`,
        );
      }
    });
  });

  describe('Hard cap invariant (双层守恒, fable-5 P1-1 PR #2221 + 砚砚 R1 P1#1 #2237)', () => {
    sourceOnlyTest('manifest declared: sum(items.estimated_tokens) ≤ hard_cap_tokens', () => {
      // Belt: manifest-declared budget tracker (catches mis-declared items at edit time)
      const m = loadStagingManifest();
      const total = m.items.reduce((sum, it) => sum + it.estimated_tokens, 0);
      assert.ok(
        total <= m.hard_cap_tokens,
        `staging cap breached (declared): ${total} > ${m.hard_cap_tokens} — must demote or sunset before adding more`,
      );
    });

    sourceOnlyTest('manifest declared soft margin: sum + soft_margin_tokens ≤ hard_cap_tokens', () => {
      // Belt soft margin: 贴线预警
      const m = loadStagingManifest();
      const total = m.items.reduce((sum, it) => sum + it.estimated_tokens, 0);
      assert.ok(
        total + m.soft_margin_tokens <= m.hard_cap_tokens,
        `staging near cap (declared): ${total} + ${m.soft_margin_tokens} margin > ${m.hard_cap_tokens} — 贴线跳舞预警`,
      );
    });

    sourceOnlyTest('砚砚 R1 P1#1: ACTUAL rendered prepend tokens ≤ hard_cap_tokens', () => {
      // Suspenders: real injection size, NOT just manifest declared.
      // Prevents "manifest says 1000, actually injects 2412" hole (砚砚 negative
      // validation in PR #2237 R1). For each cat, render the prepend, measure
      // tokens, assert against hard cap.
      const m = loadStagingManifest();
      const cats = ['opus-47', 'codex', 'gemini25', 'sonnet', 'gpt52', 'opus'];
      for (const catId of cats) {
        const rendered = buildStagingPrepend(catId);
        const measured = tok(rendered);
        assert.ok(
          measured <= m.hard_cap_tokens,
          `staging cap breached (rendered): ${catId} actual prepend = ${measured} tokens > ${m.hard_cap_tokens} — manifest under-declared or content too large`,
        );
      }
    });

    sourceOnlyTest('砚砚 R1 P1#1: ACTUAL rendered + soft_margin ≤ hard_cap_tokens (实测贴线预警)', () => {
      const m = loadStagingManifest();
      const cats = ['opus-47', 'codex', 'gemini25', 'sonnet', 'gpt52', 'opus'];
      for (const catId of cats) {
        const rendered = buildStagingPrepend(catId);
        const measured = tok(rendered);
        assert.ok(
          measured + m.soft_margin_tokens <= m.hard_cap_tokens,
          `staging near cap (rendered): ${catId} = ${measured} + ${m.soft_margin_tokens} margin > ${m.hard_cap_tokens} — 实测贴线预警`,
        );
      }
    });
  });

  describe('buildStagingPrepend (shared items apply to all cats)', () => {
    sourceOnlyTest('wipers content rendered for ragdoll cat (opus-47)', () => {
      const out = buildStagingPrepend('opus-47');
      assert.ok(out.length > 0, 'staging prepend must be non-empty when shared items exist');
      assert.ok(out.includes('摩擦上报'), 'must include wipers clause core trigger');
      assert.ok(out.includes('[爪感差:'), 'must include wipers reporting format');
    });

    sourceOnlyTest('wipers content rendered for maine-coon cat (codex)', () => {
      const out = buildStagingPrepend('codex');
      assert.ok(out.includes('摩擦上报'));
      assert.ok(out.includes('[爪感差:'));
    });

    sourceOnlyTest('wipers content rendered for siamese cat (gemini25)', () => {
      const out = buildStagingPrepend('gemini25');
      assert.ok(out.includes('摩擦上报'));
      assert.ok(out.includes('[爪感差:'));
    });

    sourceOnlyTest('wipers routes actionable friction without copying or guessing', () => {
      const out = buildStagingPrepend('codex');
      assert.match(out, /cat_cafe_capture_paw_feel/, 'current invocation must declare typed capture intent');
      assert.match(out, /原\s*turn.*单独一行/, 'typed report marker must be a standalone source line');
      assert.match(out, /无此能力.*ambiguous.*兼容采集/, 'agent-key mode must retain a truthful fallback');
      assert.match(out, /落盘.*sourceMessageId/, 'server must bind only the future source message');
      assert.match(out, /(?:查证|验证).*(?:owner|归属).*thread/i, 'action routing must verify the owning thread');
      assert.match(out, /sourceMessageId/, 'cross-thread follow-up must reference the canonical source message');
      assert.match(out, /不复制\s*marker/, 'the literal marker must stay in the source turn');
      assert.match(out, /(?:F128|propose_thread)/, 'unresolved ownership must fail closed to an approval proposal');
      assert.match(out, /禁止猜投/, 'the contract must forbid choosing a nearby thread by guess');
    });

    sourceOnlyTest('header indicates ADR-038 + outside L0 cap', () => {
      const out = buildStagingPrepend('opus-47');
      assert.ok(out.includes('ADR-038'));
      assert.match(out, /outside L0\s+\d+-cap/);
    });

    sourceOnlyTest('PR-C R2 (cloud L33 #2239): F218 source-audit NOT in staging (kept in L0)', () => {
      // Cloud R2 L33 P1: F218 source-audit is security-class — must stay in
      // L0 (system-role) to keep authority against user "skip provenance"
      // override. Verify staging body does NOT carry source-audit content,
      // and compile-system-prompt-l0.test.mjs has the inverse assertion that
      // L0 retains it.
      const out = buildStagingPrepend('opus-47');
      assert.ok(
        !out.includes('搜索结果只是候选线索'),
        'F218 trigger phrase must NOT be in staging — see compile-system-prompt-l0.test.mjs for L0 presence',
      );
      assert.ok(!out.includes('source-audit'), 'F218 source-audit reflex must NOT be in staging body');
    });

    sourceOnlyTest(
      'Cloud R1 P2 #2239: 摩擦检测反射 trigger phrases rendered (positive coverage for demoted reflex)',
      () => {
        // Same hole-plugging: ensure co-creator重复不满 → code-as-harness reflex
        // is actually injected, not just declared in manifest.
        const out = buildStagingPrepend('opus-47');
        assert.ok(
          out.includes('co-creator重复不满'),
          '摩擦检测反射 trigger "co-creator重复不满" must be rendered (demoted from L0 §2)',
        );
        assert.ok(out.includes('code-as-harness'), '摩擦检测反射 action "code-as-harness" must be rendered');
        assert.ok(out.includes('搜证据确认'), '摩擦检测反射 procedure "搜证据确认" must be rendered');
      },
    );

    sourceOnlyTest('LL-095 v2: 机制选择反射 rendered (discriminator, not slogan)', () => {
      // History: born unconditional in PR #2005 (c3f6812ad, "harness 改动按
      // 软+硬+eval三层落地"), retained verbatim by PR #2239 R5 disentangle.
      // 2026-07-19 thread_mrs0y3pjcoc0170x: the unconditional slogan pushed a
      // pure engineering fix (codex CLI stall) into "attach an eval" — LL-095.
      // v1 fix (c76dd9ce0) added an actor-based split; codex-sol audit replaced
      // it with problem-type discrimination. This test now guards the
      // DISCRIMINATOR (which question → which mechanism), not slogan presence —
      // the old `includes('软+硬+eval 三层落地')` assertion guarded exactly the
      // overbroad phrasing that caused the misfire.
      const out = buildStagingPrepend('opus-47');
      assert.ok(out.includes('机制选择反射'), '机制选择反射 title must be rendered (LL-095 v2)');
      assert.ok(out.includes('先判要回答的问题'), 'entry discriminator "先判要回答的问题" must be rendered');
      assert.ok(out.includes('同一改动可含多类问题'), 'compound changes must be split by claim');
      assert.ok(out.includes('按 claim 逐项选机制'), 'gray-zone rule must select per claim, not per file');
      assert.ok(out.includes('不是待补齐清单'), 'toolbox-not-checklist stance must be rendered (anti-ritual guard)');
      assert.ok(out.includes('不盘点未选项'), 'unused mechanisms must not become N/A checklist slots');
      assert.ok(out.includes('默认不挂 Eval Hub'), 'runtime signal default boundary must preserve eval promotion path');
      assert.ok(out.includes('ADR-031'), 'reflex must reference ADR-031 (§机制选择)');
      assert.ok(
        !out.includes('三层落地'),
        'the unconditional "按三层落地" slogan must NOT come back (LL-095: 触发词定义域 > 规则适用域)',
      );
      assert.ok(
        !out.includes('软/硬/eval 是可选工具箱'),
        'anti-checklist guidance must not keep the old three-slot frame as its lead-in',
      );
    });

    sourceOnlyTest('EXECUTION_CONTEXT 运行模式能力 matrix rendered (operator direct investment 2026-06-13)', () => {
      // runtime-sync 48 -p 3-times-wrong root cause: cats KNOW their mode but
      // guess capability boundaries wrong. Static matrix injected via staging
      // (F203/staging 增量, not a new feat — operator 终裁 2026-06-13).
      const out = buildStagingPrepend('opus-47');
      assert.ok(out.includes('运行模式能力'), 'EXECUTION_CONTEXT title must be rendered');
      assert.ok(out.includes('-p') && out.includes('bg-cron'), 'must list the run modes');
      assert.ok(
        out.includes('能力 ≠ 授权'),
        'must distinguish capability from authorization (砚砚 R2 P1: cron 不可外推自发 merge)',
      );
      assert.ok(
        out.includes('任务授权范围'),
        'bg-cron must be scoped to task authorization, not default-merge (砚砚 R2 P1)',
      );
      assert.ok(out.includes('merge-gate'), 'all modes still bound by merge-gate (capability ≠ self-authorization)');
      assert.ok(out.includes('靠实测不靠脑补'), 'must carry the empirical-boundary principle');
    });
  });

  describe('Staging wired in invoke-single-cat per-invocation (Cloud R2 P1 #2237 L1099 fix)', () => {
    test('staging NOT in staticIdentity (route-serial/parallel) — kept out of skippable injection', () => {
      // Cloud R2 P1 #2237 L1099: previous PR-B-impl folded staging into
      // buildLiveStaticIdentity, which routes passed as systemPrompt; on
      // resumed session-chain turns, invoke-single-cat skips that injection
      // (canSkipOnResume + isResume) and staging was lost.
      //
      // Fix: staging is now wired in invoke-single-cat next to F225
      // contextHintPrefix (independent of injectSystemPrompt). This test
      // documents that staging is NOT in the staticIdentity helpers route-*
      // call. Cannot easily unit-test invoke-single-cat itself (too many
      // deps); the buildStagingPrepend invariants + the resume-skip
      // independence are documented architecturally.
      //
      // buildSystemPrompt (dead-code helper) still doesn't include staging
      // (preserves system-prompt-builder.test.js budget guard).
      const sp = buildSystemPrompt({
        catId: 'opus-47',
        mode: 'independent',
        teammates: [],
        mcpAvailable: false,
      });
      assert.ok(sp.length > 0);
      assert.ok(
        !sp.includes('摩擦上报'),
        'buildSystemPrompt (dead-code helper) must NOT include staging — staging only via invoke-single-cat per-invocation prepend',
      );
    });

    sourceOnlyTest('buildStagingPrepend is the single source consumed by invoke-single-cat', () => {
      // Architectural invariant: only buildStagingPrepend produces staging
      // text. invoke-single-cat calls it per turn, regardless of
      // injectSystemPrompt. ADR-038 "每轮注入生效" contract delivered.
      const out = buildStagingPrepend('opus-47');
      assert.ok(out.includes('摩擦上报'), 'buildStagingPrepend must produce wipers for known cat');
    });
  });

  describe('Decoupling from native L0 (砚砚 R1 P2: staging NOT in 6000 L0 cap)', () => {
    test('staging tokens are bounded by staging cap, not L0 cap', () => {
      const m = loadStagingManifest();
      // staging hard cap ≤ 2000; L0 hard cap = 6000; separately bounded.
      assert.equal(m.hard_cap_tokens, 2000, 'staging cap should be 2000 per ADR-038 v1');
      // Verify they are independent: changing staging items doesn't affect L0 cap.
      // (L0 cap enforced by scripts/compile-system-prompt-l0.test.mjs, untouched here.)
    });

    test('wipers content NOT present in compile-system-prompt-l0 output (compiled L0)', async () => {
      // This is the critical proof of the砚砚 P2 boundary: staging is NOT in native L0.
      const { compileL0 } = await import('../../../scripts/compile-system-prompt-l0.mjs');
      const l0 = await compileL0({ catId: 'opus-47' });
      // L0 contains "摩擦检测反射" (existing) but must NOT contain "摩擦上报反射 (雨刮器条款)"
      // (which lives in staging body) — check the staging body marker text.
      assert.ok(
        !l0.includes('[爪感差: 工具+现象]'),
        'staging wipers core format must NOT appear in compiled native L0',
      );
    });

    sourceOnlyTest('staging item estimates track rendered body; only compact header overhead remains', () => {
      const m = loadStagingManifest();
      const declared = m.items.reduce((sum, it) => sum + it.estimated_tokens, 0);
      const out = buildStagingPrepend('opus-47');
      const measured = tok(out);
      const headerOverhead = measured - declared;
      // The item estimates describe the five body clauses. The rendered prepend
      // additionally carries one compact header, which is intentionally bounded.
      assert.ok(
        headerOverhead >= 0 && headerOverhead <= 40,
        `staging measured ${measured} tokens vs declared body ${declared}; header overhead ${headerOverhead} must stay within 0..40`,
      );
    });
  });
});
