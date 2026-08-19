import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const narrativeModule = await import('../../dist/infrastructure/harness-eval/hub/eval-hub-operator-narrative.js').catch(
  () => ({}),
);

const synthesize = narrativeModule.synthesizeEvalHubOperatorNarrative;

function baseInput(overrides = {}) {
  return {
    verdict: 'keep_observe',
    domainDescription: 'anchor-first 到底有没有省 token',
    featureId: 'F236',
    snapshot: {
      window: { durationHours: 24 },
      components: [
        {
          confidence: 'low',
          activationCounts: { preview_events: 0 },
          frictionCounts: {},
        },
      ],
    },
    attribution: {
      findings: [],
      noFindingRecord: {
        reason: 'no_preview_events',
        evidence: 'No anchor-first preview events in the rollup window.',
      },
    },
    stale: false,
    ...overrides,
  };
}

function run(input) {
  assert.equal(typeof synthesize, 'function', 'operator narrative synthesizer must be exported');
  return synthesize(input);
}

describe('Eval Hub operator narrative', () => {
  it('exports the structured narrative synthesizer', () => {
    assert.equal(typeof synthesize, 'function');
  });

  it('calls an empty low-confidence window insufficient instead of healthy', () => {
    const narrative = run(baseInput());

    assert.equal(narrative.evidenceQuality, 'insufficient');
    assert.match(narrative.headline, /数据还不够/);
    assert.match(narrative.summary, /采样了 24 小时/);
    assert.match(narrative.summary, /判断不了好坏/);
    assert.match(narrative.action, /不用改代码/);
    assert.match(narrative.nextCheck, /积累到足够样本/);
    assert.doesNotMatch(narrative.summary, /No anchor-first|no_preview_events/);
  });

  it('does not call an all-zero window usable just because confidence is high', () => {
    const narrative = run(
      baseInput({
        snapshot: {
          window: { durationHours: 24 },
          components: [
            {
              confidence: 'high',
              activationCounts: { preview_events: 0 },
              frictionCounts: { regressions: 0 },
            },
          ],
        },
      }),
    );

    assert.equal(narrative.evidenceQuality, 'insufficient');
    assert.match(narrative.headline, /数据还不够/);
  });

  it('calls a usable no-finding window checked and quiet', () => {
    const narrative = run(
      baseInput({
        domainDescription: '猫和猫协作顺不顺',
        snapshot: {
          window: { durationHours: 24 },
          components: [
            {
              confidence: 'high',
              activationCounts: { checked: 82 },
              frictionCounts: { dropped: 0 },
            },
          ],
        },
      }),
    );

    assert.equal(narrative.evidenceQuality, 'usable');
    assert.match(narrative.headline, /没有发现要处理的问题/);
    assert.match(narrative.summary, /本轮数据可用/);
    assert.match(narrative.action, /不用处理/);
  });

  it('does not treat an empty attribution bundle as proof that the window is quiet', () => {
    const narrative = run(
      baseInput({
        snapshot: {
          window: { durationHours: 24 },
          components: [
            {
              confidence: 'high',
              activationCounts: { checked: 82 },
              frictionCounts: { dropped: 0 },
            },
          ],
        },
        attribution: { findings: [] },
      }),
    );

    assert.equal(narrative.evidenceQuality, 'insufficient');
    assert.match(narrative.headline, /数据还不够/);
  });

  it('keeps usable findings in observation language for keep-observe verdicts', () => {
    const narrative = run(
      baseInput({
        snapshot: {
          window: { durationHours: 24 },
          components: [
            {
              confidence: 'high',
              activationCounts: { checked: 82 },
              frictionCounts: { 'c1.zombie_hold_count': 2 },
            },
          ],
        },
        attribution: {
          findings: [
            {
              frictionSignal: { type: 'c1.zombie_hold_count', severity: 'medium', confidence: 0.6 },
            },
          ],
        },
        metricGlossary: {
          'c1.zombie_hold_count': {
            label: '真正卡住的持球',
            means: '猫持球后没有正常醒来或交接',
            goodDirection: 'lower',
          },
        },
      }),
    );

    assert.equal(narrative.evidenceQuality, 'usable');
    assert.match(narrative.headline, /1 个线索/);
    assert.match(narrative.summary, /真正卡住的持球/);
    assert.match(narrative.summary, /继续观察/);
    assert.match(narrative.action, /不用立刻改代码/);
  });

  it('turns an actionable finding into a Chinese owner action without copying ownerAsk', () => {
    const narrative = run(
      baseInput({
        verdict: 'fix',
        domainDescription: '猫和猫协作顺不顺',
        snapshot: {
          window: { durationHours: 24 },
          components: [
            {
              confidence: 'high',
              activationCounts: { checked: 82 },
              frictionCounts: { 'c1.zombie_hold_count': 4 },
            },
          ],
        },
        attribution: {
          findings: [
            {
              frictionSignal: { type: 'c1.zombie_hold_count', severity: 'high', confidence: 0.7 },
            },
          ],
        },
        metricGlossary: {
          'c1.zombie_hold_count': {
            label: '真正卡住的持球',
            means: '猫持球后没有正常醒来或交接',
            goodDirection: 'lower',
          },
        },
      }),
    );

    assert.match(narrative.headline, /需要修复/);
    assert.match(narrative.summary, /真正卡住的持球/);
    assert.match(narrative.action, /负责 F236 的猫/);
    assert.doesNotMatch(narrative.action, /Fix|ownerAsk|owner/i);
  });

  it('explains build and sunset decisions in operator language', () => {
    const build = run(
      baseInput({
        verdict: 'build',
        attribution: {
          findings: [
            {
              frictionSignal: { type: 'missing_capability', severity: 'high', confidence: 0.8 },
            },
          ],
        },
        metricGlossary: {
          missing_capability: {
            label: '缺失能力信号',
            means: '当前 harness 无法完成目标动作',
            goodDirection: 'lower',
          },
        },
      }),
    );
    const sunset = run(baseInput({ verdict: 'delete_sunset' }));

    assert.match(build.headline, /补一项能力/);
    assert.match(build.summary, /1 个需要处理的线索/);
    assert.match(build.summary, /缺失能力信号/);
    assert.match(build.action, /负责 F236 的猫/);
    assert.match(sunset.headline, /可以停用/);
    assert.match(sunset.action, /You.*决定/);
  });

  it('surfaces an overdue re-evaluation without exposing lifecycle enums', () => {
    const narrative = run(baseInput({ stale: true }));

    assert.match(narrative.nextCheck, /超过原定复评时间/);
    assert.doesNotMatch(narrative.nextCheck, /pending_reeval|observing/);
  });
});
