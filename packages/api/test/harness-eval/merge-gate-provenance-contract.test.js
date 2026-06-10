import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '../../../..');

function read(relPath) {
  return readFileSync(resolve(ROOT, relPath), 'utf8');
}

describe('merge-gate review provenance contract', () => {
  it('merge-gate skill records source provenance before pinging local reviewers', () => {
    const mergeGate = read('cat-cafe-skills/merge-gate/SKILL.md');

    assert.ok(mergeGate.includes('Review Provenance Matrix'), 'merge-gate skill must define provenance matrix');
    assert.ok(mergeGate.includes('localPeerReviewSha'), 'merge-gate skill must track local peer review SHA');
    assert.ok(mergeGate.includes('cloudReviewSha'), 'merge-gate skill must track cloud review SHA');
    assert.ok(mergeGate.includes('headChangeCause = cloud-finding'), 'cloud finding fixes must be a named cause');
    assert.ok(mergeGate.includes('nextGateOwner = cloud'), 'cloud finding fixes must route back to cloud gate');
    assert.ok(
      mergeGate.includes('禁止为了 cloud P1/P2 修复 @ 本地旧 reviewer'),
      'cloud P1/P2 fixes must not ping the old local reviewer',
    );
  });

  it('receive-review and pr-signals return fixes to the original feedback source', () => {
    const receiveReview = read('cat-cafe-skills/receive-review/SKILL.md');
    const prSignals = read('cat-cafe-skills/refs/pr-signals.md');

    assert.ok(receiveReview.includes('Feedback source'), 'receive-review must classify feedback source');
    assert.ok(receiveReview.includes('cloud / GitHub review'), 'receive-review must classify cloud/GitHub review');
    assert.ok(receiveReview.includes('只重新触发 cloud review'), 'cloud fixes must only re-trigger cloud review');
    assert.ok(receiveReview.includes('不要 @ 本地旧 reviewer'), 'receive-review must block local reviewer ping');

    assert.ok(prSignals.includes('Source-aware rule'), 'pr-signals must carry a source-aware rule');
    assert.ok(prSignals.includes('重新触发 cloud review'), 'pr-signals must instruct cloud review re-trigger');
    assert.ok(prSignals.includes('已 @ local reviewer 确认'), 'local review completion must remain explicit');
    assert.ok(
      !prSignals.includes('Review 处理完: "已按 receive-review 模式处理 PR #42 的 review 意见，@ reviewer 确认"'),
      'old source-blind reviewer notification template must not return',
    );
  });

  it('L0 template, compiler overlay, and runtime prompt builder carry the same reflex', () => {
    const l0 = read('assets/system-prompts/system-prompt-l0.md');
    const compiler = read('scripts/compile-system-prompt-l0.mjs');
    const runtimeBuilder = read('packages/api/src/domains/cats/services/context/SystemPromptBuilder.ts');

    assert.ok(l0.includes('merge-gate source provenance 反射'), 'L0 template must name the merge-gate reflex');
    assert.ok(
      l0.includes('外部 finding 修完后等 PR truth'),
      'L0 must route completed external findings to PR truth source without ambiguous 修后 wording',
    );
    assert.ok(!l0.includes('）修后等 PR truth'), 'L0 must not keep ambiguous 修后 wording');
    assert.ok(l0.includes('不 @ 本地旧 reviewer'), 'L0 must block projection to local reviewer');

    for (const [label, source] of [
      ['compiler overlay', compiler],
      ['runtime prompt builder', runtimeBuilder],
    ]) {
      assert.ok(source.includes('MERGE_GATE_SOURCE_PROVENANCE_TRIGGER'), `${label} must define shared trigger text`);
      assert.ok(source.includes('MG provenance override'), `${label} must include source provenance override`);
      assert.ok(source.includes('外部finding修完后等PR truth'), `${label} must name completed external findings`);
      assert.ok(source.includes('不@旧reviewer'), `${label} must override generic review ping`);
    }
  });

  it('F167 fixture documents the regression scenario and expected route', () => {
    const fixturePath = resolve(ROOT, 'docs/harness-feedback/fixtures/F167-merge-gate-review-provenance.md');
    assert.ok(existsSync(fixturePath), 'missing F167 merge-gate review provenance fixture');

    const fixture = read('docs/harness-feedback/fixtures/F167-merge-gate-review-provenance.md');
    assert.ok(fixture.includes('pattern_name: merge-gate-review-provenance'), 'fixture must declare pattern name');
    assert.ok(fixture.includes('thread_mpg6o4q7gjn576ev'), 'fixture must cite PR #2141 main thread');
    assert.ok(fixture.includes('thread_mq41g15xm8w1ojhn'), 'fixture must cite F128 postmortem thread');
    assert.ok(fixture.includes('Stage ③ local peer review'), 'fixture must state local review entry gate');
    assert.ok(
      fixture.includes('nextGateOwner = cloud'),
      'fixture must state cloud review ownership after cloud findings',
    );
    assert.ok(fixture.includes('Regression Test'), 'fixture must identify regression test coverage');
  });
});
