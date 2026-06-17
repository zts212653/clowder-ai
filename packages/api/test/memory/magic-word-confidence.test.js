import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

/**
 * F227 PR-2 Task 5 — Magic Word confidence grading (deterministic, no-classifier).
 *
 * Layers confidence (high/mid/low) on top of the F192 deterministic substring
 * detector. This is the 人工拉闸 lane's noise filter — it does NOT infer cat
 * intent (KD-3 no-classifier); it applies deterministic context rules:
 *   - cat-authored magic word        → low  (magic words are operator-only brake words;
 *                                            a cat using one is quoting/discussing)
 *   - >=3 distinct words OR 「word」=def → low  (the SNR-22% listing/defining noise
 *                                            opus-47 found in eval: RFC listing the table)
 *   - cocreator + @cat mention        → high (a brake directed at a cat)
 *   - cocreator, otherwise            → mid  (present but ambiguous)
 *
 * Source of truth for the 10-word table stays in the F192 detector (AC-A5: no dup).
 */

const loadMod = () => import('../../dist/domains/memory/magic-word-confidence.js');
const loadF192 = () => import('../../dist/infrastructure/harness-eval/task-outcome/magic-word-detector.js');

describe('F227 PR-2: magic word confidence grading', () => {
  it('reuses the F192 word table instead of redefining it (AC-A5)', async () => {
    const mod = await loadMod();
    const f192 = await loadF192();
    const graded = mod.detectGradedMagicWords('这是脚手架吧 @opus', { authoredByCocreator: true });
    assert.equal(graded.length, 1);
    assert.equal(graded[0].word, '脚手架');
    // the confidence module must not ship its own table — it reads the F192 one
    assert.ok(f192.MAGIC_WORD_PATTERNS.includes('脚手架'));
    assert.equal(mod.MAGIC_WORD_PATTERNS, undefined, 'confidence module must not redefine the table');
  });

  it('grades a cocreator brake directed at a cat (@handle) as high', async () => {
    const { detectGradedMagicWords } = await loadMod();
    const g = detectGradedMagicWords('这是脚手架吧？@opus 我要终态不要临时方案', { authoredByCocreator: true });
    assert.equal(g.length, 1);
    assert.equal(g[0].confidence, 'high');
  });

  it('grades a cocreator brake with no cat mention as mid', async () => {
    const { detectGradedMagicWords } = await loadMod();
    const g = detectGradedMagicWords('感觉有点脚手架，重写一下吧', { authoredByCocreator: true });
    assert.equal(g.length, 1);
    assert.equal(g[0].confidence, 'mid');
  });

  it('grades a message listing >=3 distinct magic words as low (discussion, not brake)', async () => {
    const { detectGradedMagicWords } = await loadMod();
    // The exact SNR-22% case: cocreator listing the magic-word RANGE in an RFC.
    // Note the @opus — listing must beat @cat (noise-first precedence).
    const g = detectGradedMagicWords('家规 Magic Words：脚手架 / 绕路了 / 补锅匠 / 第一性原理 都是拉闸词 @opus', {
      authoredByCocreator: true,
    });
    assert.ok(g.length >= 3, `expected >=3 hits, got ${g.length}`);
    for (const h of g) assert.equal(h.confidence, 'low', `${h.word} should be low`);
  });

  it('grades a definition context (「word」= explanation) as low', async () => {
    const { detectGradedMagicWords } = await loadMod();
    const g = detectGradedMagicWords('「脚手架」= 你在偷懒写临时方案，停审视产物是否终态', {
      authoredByCocreator: true,
    });
    assert.equal(g[0].confidence, 'low');
  });

  it('grades a cat-authored magic word as low (operator-only word; cat usage = discussion)', async () => {
    const { detectGradedMagicWords } = await loadMod();
    const g = detectGradedMagicWords('我刚才是不是写得有点脚手架了，下次注意', { authoredByCocreator: false });
    assert.equal(g.length, 1);
    assert.equal(g[0].confidence, 'low');
  });

  it('returns [] when no magic word present', async () => {
    const { detectGradedMagicWords } = await loadMod();
    assert.deepEqual(detectGradedMagicWords('今天天气不错继续干活', { authoredByCocreator: true }), []);
  });

  it('returns [] for an empty message', async () => {
    const { detectGradedMagicWords } = await loadMod();
    assert.deepEqual(detectGradedMagicWords('', { authoredByCocreator: true }), []);
  });

  it('gradeMagicWordHits grades pre-detected hits (used by backfill)', async () => {
    const mod = await loadMod();
    const f192 = await loadF192();
    const msg = '补锅匠 @codex 别逐点修补';
    const hits = f192.detectMagicWords(msg);
    const graded = mod.gradeMagicWordHits(msg, hits, { authoredByCocreator: true });
    assert.equal(graded.length, 1);
    assert.equal(graded[0].word, '补锅匠');
    assert.equal(graded[0].confidence, 'high');
  });

  it('defaults to grading as cocreator-authored when authorship is unknown', async () => {
    const { detectGradedMagicWords } = await loadMod();
    // no opts → must not crash and must apply cocreator rules (mid for a lone word)
    const g = detectGradedMagicWords('有点脚手架');
    assert.equal(g[0].confidence, 'mid');
  });
});
