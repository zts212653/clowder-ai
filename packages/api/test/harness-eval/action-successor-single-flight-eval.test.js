import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const { buildActionSuccessorSingleFlight } = await import(
  '../../dist/infrastructure/harness-eval/action-successor-single-flight-eval.js'
);

describe('F167 Phase S action successor single-flight eval', () => {
  it('separates explicit parallel throughput from single-mode concurrency violations', () => {
    const component = buildActionSuccessorSingleFlight({
      cat_cafe_a2a_successor_unique_cats_invoked_per_action_sum: 5,
      cat_cafe_a2a_successor_unique_cats_invoked_per_action_count: 3,
      'cat_cafe_a2a_successor_concurrent_successors_count{action_successor_mode="single"}': 2,
      // Excess mass semantics: 2 obs, sum=3 -> one obs had value=2 -> mass=1 violation
      'cat_cafe_a2a_successor_concurrent_successors_sum{action_successor_mode="single"}': 3,
      'cat_cafe_a2a_successor_concurrent_successors_count{action_successor_mode="parallel"}': 1,
      'cat_cafe_a2a_successor_concurrent_successors_sum{action_successor_mode="parallel"}': 3,
      cat_cafe_a2a_successor_responses_after_terminal_state_total: 0,
      cat_cafe_a2a_successor_safe_wait_total: 4,
      cat_cafe_a2a_successor_replace_total: 1,
      cat_cafe_a2a_successor_multi_mention_total: 10,
      cat_cafe_a2a_successor_single_target_multi_mention_total: 3,
      cat_cafe_a2a_successor_unfenced_single_target_multi_mention_total: 2,
      cat_cafe_a2a_successor_action_fence_unavailable_total: 1,
      cat_cafe_a2a_successor_agent_key_action_rejected_total: 2,
    });

    assert.equal(component.componentId, 'action-successor-single-flight');
    assert.equal(component.activationCounts['successor.unique_cats_invoked_total'], 5);
    assert.equal(component.activationCounts['successor.actions_observed'], 3);
    assert.equal(component.activationCounts['successor.explicit_parallel_observations'], 1);
    assert.equal(component.activationCounts['successor.safe_wait'], 4);
    assert.equal(component.activationCounts['successor.replace'], 1);
    assert.equal(component.activationCounts['successor.single_target_multi_mention_rate'], 0.3);
    assert.equal(component.frictionCounts['successor.concurrent_single_violations'], 1);
    assert.equal(component.frictionCounts['successor.responses_after_terminal_state'], 0);
    assert.equal(component.frictionCounts['successor.unfenced_single_target_multi_mention'], 2);
    assert.equal(component.frictionCounts['successor.action_fence_unavailable'], 1);
    assert.equal(component.frictionCounts['successor.agent_key_action_rejected'], 2);
  });

  it('treats responses after external terminal truth as zero-tolerance friction', () => {
    const component = buildActionSuccessorSingleFlight({
      cat_cafe_a2a_successor_responses_after_terminal_state_total: 2,
    });

    assert.equal(component.frictionCounts['successor.responses_after_terminal_state'], 2);
    assert.deepEqual(component.falsePositiveCandidates, []);
    assert.equal(component.confidence, 'low');
  });

  it('reports no-data when successor telemetry has not been emitted', () => {
    const component = buildActionSuccessorSingleFlight({});

    assert.equal(component.confidence, 'no-data');
    assert.equal(component.telemetryGaps[0].metric, 'successor.concurrent_successors');
  });

  it('preserves missing critical friction counters as unknown during a partial scrape', () => {
    const component = buildActionSuccessorSingleFlight({
      cat_cafe_a2a_successor_safe_wait_total: 1,
    });

    assert.equal(component.confidence, 'low');
    assert.equal(component.frictionCounts['successor.responses_after_terminal_state'], null);
    assert.equal(component.frictionCounts['successor.unfenced_single_target_multi_mention'], null);
    assert.equal(component.frictionCounts['successor.action_fence_unavailable'], null);
    assert.equal(component.frictionCounts['successor.agent_key_action_rejected'], null);
    for (const metric of [
      'successor.responses_after_terminal_state',
      'successor.unfenced_single_target_multi_mention',
      'successor.action_fence_unavailable',
      'successor.agent_key_action_rejected',
    ]) {
      assert.ok(
        component.telemetryGaps.some((gap) => gap.metric === metric),
        `${metric} must expose a telemetry gap`,
      );
    }
  });

  it('keeps a warm zero distinct from missing sibling friction counters', () => {
    const component = buildActionSuccessorSingleFlight({
      cat_cafe_a2a_successor_safe_wait_total: 1,
      cat_cafe_a2a_successor_action_fence_unavailable_total: 0,
    });

    assert.equal(component.frictionCounts['successor.action_fence_unavailable'], 0);
    assert.equal(component.frictionCounts['successor.unfenced_single_target_multi_mention'], null);
    assert.equal(
      component.telemetryGaps.some((gap) => gap.metric === 'successor.action_fence_unavailable'),
      false,
    );
    assert.ok(component.telemetryGaps.some((gap) => gap.metric === 'successor.unfenced_single_target_multi_mention'));
  });

  it('reports zero migration rate when multi_mention counters are warm but unused', () => {
    const component = buildActionSuccessorSingleFlight({
      cat_cafe_a2a_successor_unique_cats_invoked_per_action_count: 0,
      cat_cafe_a2a_successor_responses_after_terminal_state_total: 0,
      cat_cafe_a2a_successor_safe_wait_total: 0,
      cat_cafe_a2a_successor_replace_total: 0,
      cat_cafe_a2a_successor_multi_mention_total: 0,
      cat_cafe_a2a_successor_single_target_multi_mention_total: 0,
      cat_cafe_a2a_successor_unfenced_single_target_multi_mention_total: 0,
      cat_cafe_a2a_successor_action_fence_unavailable_total: 0,
      cat_cafe_a2a_successor_agent_key_action_rejected_total: 0,
    });

    assert.equal(component.activationCounts['successor.single_target_multi_mention_rate'], 0);
    assert.equal(component.frictionCounts['successor.unfenced_single_target_multi_mention'], 0);
    assert.equal(component.frictionCounts['successor.action_fence_unavailable'], 0);
    assert.deepEqual(component.telemetryGaps, []);
  });

  it('omits an unknowable migration rate and exposes the missing numerator as a telemetry gap', () => {
    const component = buildActionSuccessorSingleFlight({
      cat_cafe_a2a_successor_multi_mention_total: 4,
    });

    assert.equal('successor.single_target_multi_mention_rate' in component.activationCounts, false);
    assert.ok(component.telemetryGaps.some((gap) => gap.metric === 'successor.single_target_multi_mention_rate'));
  });

  it('preserves missing successor counters as no-data during a partial scrape', () => {
    const component = buildActionSuccessorSingleFlight({
      cat_cafe_a2a_successor_safe_wait_total: 4,
    });

    assert.equal(component.confidence, 'low');
    assert.equal(component.activationCounts['successor.safe_wait'], 4);
    assert.equal(component.activationCounts['successor.multi_mention_total'], null);
    assert.equal(component.activationCounts['successor.single_target_multi_mention_total'], null);
    assert.equal(component.frictionCounts['successor.unfenced_single_target_multi_mention'], null);
    assert.equal(component.frictionCounts['successor.action_fence_unavailable'], null);
    assert.equal(component.frictionCounts['successor.agent_key_action_rejected'], null);

    const gaps = new Set(component.telemetryGaps.map((gap) => gap.metric));
    assert.ok(gaps.has('successor.multi_mention_total'));
    assert.ok(gaps.has('successor.single_target_multi_mention_total'));
    assert.ok(gaps.has('successor.unfenced_single_target_multi_mention'));
    assert.ok(gaps.has('successor.action_fence_unavailable'));
    assert.ok(gaps.has('successor.agent_key_action_rejected'));
  });

  // ------------------------------------------------------------------
  // 07-15 verdict fix: eval must prove single-flight cleanliness from
  // Prometheus `_sum + _count` (OTel default histogram lacks le="1" bucket).
  // Semantics chosen: `singleSum - singleCount` = excess concurrency mass
  //   (accumulated holder count above the single-target invariant of 1).
  //   sum == count -> mass=0 -> clean; sum > count -> positive violation mass.
  // ------------------------------------------------------------------

  it('proves clean single-flight from _sum == _count when default OTel buckets omit le="1"', () => {
    // Realistic prod shape: OTel default histogram buckets are [0, 5, 10, 25, ...],
    // so single-mode admits at value=1 leave `_bucket{le="1"}` absent from the scrape.
    const component = buildActionSuccessorSingleFlight({
      cat_cafe_a2a_successor_unique_cats_invoked_per_action_count: 5,
      cat_cafe_a2a_successor_unique_cats_invoked_per_action_sum: 5,
      'cat_cafe_a2a_successor_concurrent_successors_count{action_successor_mode="single"}': 5,
      'cat_cafe_a2a_successor_concurrent_successors_sum{action_successor_mode="single"}': 5,
      // Default OTel bucket boundaries (no le="1"):
      'cat_cafe_a2a_successor_concurrent_successors_bucket{action_successor_mode="single",le="0"}': 0,
      'cat_cafe_a2a_successor_concurrent_successors_bucket{action_successor_mode="single",le="5"}': 5,
    });

    // 5 observations each of value 1 -> sum=5=count -> zero excess mass
    assert.equal(component.frictionCounts['successor.concurrent_single_violations'], 0);
    assert.equal(
      component.telemetryGaps.some((gap) => gap.metric === 'successor.concurrent_successors'),
      false,
      'clean single-flight from _sum == _count must not produce a telemetry gap',
    );
  });

  it('produces positive excess-mass violation signal when concurrent holders exceed 1', () => {
    // 3 single-mode observations, one had holderCount=2 (violation).
    // count=3, sum=1+1+2=4 -> excess mass = sum - count = 1
    // Semantics: excess concurrency mass (NOT event count of violating observations).
    const component = buildActionSuccessorSingleFlight({
      cat_cafe_a2a_successor_unique_cats_invoked_per_action_count: 3,
      cat_cafe_a2a_successor_unique_cats_invoked_per_action_sum: 4,
      'cat_cafe_a2a_successor_concurrent_successors_count{action_successor_mode="single"}': 3,
      'cat_cafe_a2a_successor_concurrent_successors_sum{action_successor_mode="single"}': 4,
      'cat_cafe_a2a_successor_concurrent_successors_bucket{action_successor_mode="single",le="0"}': 0,
      'cat_cafe_a2a_successor_concurrent_successors_bucket{action_successor_mode="single",le="5"}': 3,
    });

    assert.equal(component.frictionCounts['successor.concurrent_single_violations'], 1);
  });

  it('keeps idle-window Path 3 clean when actionCount === 0 without regression', () => {
    // Idle window: some activation counters warm but no admissions happened.
    // Path 3 idle recognition must still return violations=0 without needing _sum.
    const component = buildActionSuccessorSingleFlight({
      cat_cafe_a2a_successor_unique_cats_invoked_per_action_count: 0,
      cat_cafe_a2a_successor_safe_wait_total: 0,
      cat_cafe_a2a_successor_replace_total: 0,
    });

    assert.equal(component.frictionCounts['successor.concurrent_single_violations'], 0);
    assert.equal(
      component.telemetryGaps.some((gap) => gap.metric === 'successor.concurrent_successors'),
      false,
      'idle window (actionCount=0) must not report a concurrent_successors gap',
    );
  });

  it('leaves explicit parallel-mode observations processing intact', () => {
    // Parallel mode admits multiple holders per action by design.
    // Single-mode invariant does not apply; parallel_observations counter emits normally.
    // actionCount>0 (admits happened) but no single-mode data — could be "all parallel"
    // OR observability failure (single admits with lost histogram). Conservative:
    // flag as gap (07-18 R1 P1 by @gpt52 required narrower predicate: only flag clean
    // when we can prove no admissions occurred, not just "some counter is warm").
    const component = buildActionSuccessorSingleFlight({
      cat_cafe_a2a_successor_unique_cats_invoked_per_action_count: 2,
      cat_cafe_a2a_successor_unique_cats_invoked_per_action_sum: 8,
      'cat_cafe_a2a_successor_concurrent_successors_count{action_successor_mode="parallel"}': 2,
      'cat_cafe_a2a_successor_concurrent_successors_sum{action_successor_mode="parallel"}': 8,
    });

    assert.equal(component.activationCounts['successor.explicit_parallel_observations'], 2);
    // actionCount>0 + no single-mode data -> conservative gap (cannot distinguish
    // all-parallel from observability failure)
    assert.ok(component.telemetryGaps.some((gap) => gap.metric === 'successor.concurrent_successors'));
  });

  // ------------------------------------------------------------------
  // 07-18 verdict fix: cold-idle recognition upgrade
  // (2026-07-18-eval-a2a-successor-cold-idle-gap-v3)
  //
  // Fresh runtime startup emits counters via `.add(0)` warming, but histograms
  // (`unique_cats_invoked_per_action`, `concurrent_successors`) are not emitted
  // until first admission. Cold-idle window shape: warm lifecycle counters at 0,
  // admission histogram series entirely absent (actionCount === null).
  //
  // Old Path 3 recognition was `actionCount === 0 ? 0 : null` — null !== 0, so
  // cold-idle produced a false `successor.concurrent_successors` gap.
  //
  // Fix semantics: if `hasCounters` (any warm lifecycle counter present) AND
  // single-mode admission data absent, the invariant is trivially satisfied
  // (no admissions, no violation possible). Warmed lifecycle counters prove
  // the server is alive; absent admission histogram proves no admits happened.
  // ------------------------------------------------------------------

  it('recognizes cold-idle window (warm lifecycle counters + absent admission histogram) as clean', () => {
    // Reproduces snapshot 2026-07-18-eval-a2a-successor-cold-idle-gap-v3:
    // fresh runtime PID after 07-16 fix, no admissions yet, only lifecycle
    // counters warmed at zero.
    const component = buildActionSuccessorSingleFlight({
      // No unique_cats_invoked_per_action_* series (histogram absent)
      // No concurrent_successors_* series (histogram absent)
      cat_cafe_a2a_successor_responses_after_terminal_state_total: 0,
      cat_cafe_a2a_successor_safe_wait_total: 0,
      cat_cafe_a2a_successor_replace_total: 0,
      cat_cafe_a2a_successor_multi_mention_total: 0,
      cat_cafe_a2a_successor_single_target_multi_mention_total: 0,
      cat_cafe_a2a_successor_unfenced_single_target_multi_mention_total: 0,
      cat_cafe_a2a_successor_action_fence_unavailable_total: 0,
      cat_cafe_a2a_successor_agent_key_action_rejected_total: 0,
    });

    assert.equal(
      component.confidence,
      'medium',
      'cold-idle window with warm lifecycle counters must be medium (not low)',
    );
    assert.equal(
      component.frictionCounts['successor.concurrent_single_violations'],
      0,
      'cold-idle window must resolve concurrent_single_violations to numeric 0',
    );
    assert.equal(
      component.telemetryGaps.some((gap) => gap.metric === 'successor.concurrent_successors'),
      false,
      'cold-idle window must not emit successor.concurrent_successors telemetry gap',
    );
  });

  it('preserves no-data confidence when nothing is warm (truly cold server)', () => {
    // Contrast case: no counter is present at all (server never emitted anything).
    // Cannot infer aliveness, must report no-data.
    const component = buildActionSuccessorSingleFlight({});

    assert.equal(component.confidence, 'no-data');
    assert.ok(component.telemetryGaps.some((gap) => gap.metric === 'successor.concurrent_successors'));
  });

  it('flags observability failure when admits happened but single-mode proof absent (07-18 R1 P1)', () => {
    // GPT-5.4 R1 P1 grounded: admissions definitely happened (actionCount>0), lifecycle
    // counters warm, but concurrent_successors histogram single-mode series entirely
    // absent. This is either (a) OTel wiring broken (dropped emissions in
    // successorConcurrentSuccessors path while successorUniqueCatsInvokedPerAction
    // still emitted — see ActionSuccessorAdmissionService.admitted() dual record), or
    // (b) all admits used mode='parallel'. Eval cannot distinguish safely; conservatively
    // flag as gap so genuine emission failures aren't silently masked as clean.
    const component = buildActionSuccessorSingleFlight({
      cat_cafe_a2a_successor_unique_cats_invoked_per_action_count: 5,
      cat_cafe_a2a_successor_unique_cats_invoked_per_action_sum: 5,
      cat_cafe_a2a_successor_safe_wait_total: 0,
      cat_cafe_a2a_successor_replace_total: 0,
      // Deliberately no concurrent_successors_* series at all
    });

    assert.equal(
      component.frictionCounts['successor.concurrent_single_violations'],
      null,
      'admits happened but no single-mode proof must resolve to null (unknown), not 0',
    );
    assert.ok(
      component.telemetryGaps.some((gap) => gap.metric === 'successor.concurrent_successors'),
      'admits happened + single-mode proof absent must flag telemetry gap so emission bugs are visible',
    );
  });

  it('flags dual-record half-loss: parallel concurrent_successors present but actionCount absent (07-18 R2 P1)', () => {
    // GPT-5.4 R2 P1: `admitted()` calls two histogram records
    // (successorUniqueCatsInvokedPerAction + successorConcurrentSuccessors). If the
    // former is dropped and the latter survives, `actionCount==null` while
    // `parallelCount>0`. Prior R1 fix (actionCount===null → cold-idle) would still
    // wash this into clean. Correct behavior: any partial admission signal implies
    // OTel wiring dropped half of the dual record — flag gap.
    const component = buildActionSuccessorSingleFlight({
      // Deliberately NO unique_cats_invoked_per_action_* (dropped emission)
      'cat_cafe_a2a_successor_concurrent_successors_count{action_successor_mode="parallel"}': 2,
      'cat_cafe_a2a_successor_concurrent_successors_sum{action_successor_mode="parallel"}': 8,
      cat_cafe_a2a_successor_safe_wait_total: 0,
      cat_cafe_a2a_successor_replace_total: 0,
    });

    assert.equal(
      component.frictionCounts['successor.concurrent_single_violations'],
      null,
      'parallelCount present + actionCount absent must resolve to null (partial-emission gap)',
    );
    assert.ok(
      component.telemetryGaps.some((gap) => gap.metric === 'successor.concurrent_successors'),
      'partial admission histograms must flag telemetry gap so dual-record failures are visible',
    );
  });

  it('flags dual-record half-loss: single concurrent_successors present but actionCount absent (07-18 R2 P1)', () => {
    // Same shape as above but with mode='single' label. `actionCount==null` while
    // `singleCount>0` — asymmetric emission of the dual record. Must flag gap.
    const component = buildActionSuccessorSingleFlight({
      // Deliberately NO unique_cats_invoked_per_action_* (dropped emission)
      'cat_cafe_a2a_successor_concurrent_successors_count{action_successor_mode="single"}': 3,
      // NOTE: singleSum deliberately absent to force fall-through past non-idle branch
      cat_cafe_a2a_successor_safe_wait_total: 0,
      cat_cafe_a2a_successor_replace_total: 0,
    });

    assert.equal(
      component.frictionCounts['successor.concurrent_single_violations'],
      null,
      'singleCount present + actionCount absent must resolve to null (partial-emission gap)',
    );
    assert.ok(
      component.telemetryGaps.some((gap) => gap.metric === 'successor.concurrent_successors'),
      'partial admission histograms must flag telemetry gap so dual-record failures are visible',
    );
  });
});
