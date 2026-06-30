import assert from 'node:assert/strict';
import { describe, mock, test } from 'node:test';
import { AntigravityAgentService } from '../dist/domains/cats/services/agents/providers/antigravity/AntigravityAgentService.js';
import { collect, createMockBridge } from './antigravity-agent-service-test-helpers.js';

// F211 REG-followup (service wiring): a terminal planner response that only
// ANNOUNCES a deliverable ("让我整理分析。") but never delivers it used to set
// hasText=true → the empty_response backstop was skipped → the turn completed
// SILENTLY while the human saw a half-thought. The service now detects that
// deferred shape, nudges ONCE in the same cascade for the real answer, and — if
// the model STILL defers — surfaces incomplete_response instead of finishing
// silently. The detection predicate itself is unit-tested in
// antigravity-deferred-terminal.test.js; here we lock the SERVICE behavior.

const DEFERRAL_TEXT = '好了，证据链够了。让我整理分析。';
const REAL_ANSWER = '分析结论：方案 A 最优，因为它平衡了成本与质量。';

function plannerBatch(text) {
  return {
    steps: [
      {
        type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
        status: 'CORTEX_STEP_STATUS_DONE',
        plannerResponse: { response: text },
      },
    ],
    cursor: { baselineStepCount: 0, lastDeliveredStepCount: 1, terminalSeen: true, lastActivityAt: Date.now() },
  };
}

/** A stateful pollForSteps that yields one terminal batch per turn, in order. */
function turnScriptedPoll(textsByTurn) {
  let turn = 0;
  return async function* () {
    const text = textsByTurn[Math.min(turn, textsByTurn.length - 1)];
    turn += 1;
    yield plannerBatch(text);
  };
}

describe('AntigravityAgentService — deferred/progress-only terminal nudge', () => {
  test('deferred terminal text → nudges once in the SAME cascade, then delivers the real answer', async () => {
    const bridge = createMockBridge();
    const sentPrompts = [];
    const sentCascades = [];
    bridge.sendMessage = mock.fn(async (cascadeId, prompt) => {
      sentCascades.push(cascadeId);
      sentPrompts.push(prompt);
      return { stepsBefore: 0, wasBusy: false };
    });
    bridge.pollForSteps = turnScriptedPoll([DEFERRAL_TEXT, REAL_ANSWER]);

    const service = new AntigravityAgentService({ catId: 'antigravity', model: 'claude-opus-4-6', bridge });
    const messages = await collect(service.invoke('帮我分析'));

    // original prompt + exactly one nudge follow-up
    assert.equal(sentPrompts.length, 2, 'should send the original prompt then one nudge');
    assert.equal(sentPrompts[0], '帮我分析');
    assert.notEqual(sentPrompts[1], '帮我分析', 'second send must be the nudge, not a resend of the user prompt');
    // follow-up rides the SAME cascade (no rotation) so the model keeps context
    assert.equal(sentCascades[1], sentCascades[0], 'nudge must reuse the same cascade');

    // the real answer is delivered; no silent half-thought
    const texts = messages.filter((m) => m.type === 'text').map((m) => m.content);
    assert.ok(texts.includes(REAL_ANSWER), `real answer must be delivered after nudge (got ${JSON.stringify(texts)})`);
    // the recovered answer REPLACES the deferred half-thought bubble (route/queue
    // aggregators append by default), so the user is left with the answer, not
    // "让我整理分析。 + answer" (cloud #2558 P2).
    const recovered = messages.find((m) => m.type === 'text' && m.content === REAL_ANSWER);
    assert.equal(recovered?.textMode, 'replace', 'recovered answer must replace the deferred sentence, not append');
    assert.equal(
      messages.find((m) => m.type === 'error' && m.errorCode === 'incomplete_response'),
      undefined,
      'a recovered turn must NOT surface incomplete_response',
    );
    assert.equal(messages.at(-1)?.type, 'done');
  });

  test('deferral persists after the nudge → incomplete_response, and the loop terminates (no stall)', async () => {
    const bridge = createMockBridge();
    let sends = 0;
    bridge.sendMessage = mock.fn(async () => {
      sends += 1;
      return { stepsBefore: 0, wasBusy: false };
    });
    // every turn defers — the anti-loop cap must stop after exactly one nudge
    bridge.pollForSteps = turnScriptedPoll([DEFERRAL_TEXT]);

    const service = new AntigravityAgentService({ catId: 'antigravity', model: 'claude-opus-4-6', bridge });
    const messages = await collect(service.invoke('帮我分析'));

    assert.equal(sends, 2, 'must nudge at most once (original + one nudge), never loop');
    const incomplete = messages.find((m) => m.type === 'error' && m.errorCode === 'incomplete_response');
    assert.ok(incomplete, 'a persisted deferral must surface incomplete_response instead of finishing silently');
    assert.ok(incomplete.metadata?.diagnostics, 'incomplete_response must carry diagnostics');
    assert.equal(messages.at(-1)?.type, 'done', 'turn must still terminate cleanly');
  });

  test('normal terminal answer → no nudge, completes normally (REG12 termination preserved)', async () => {
    const bridge = createMockBridge(); // default planner response 'Meow!'
    let sends = 0;
    bridge.sendMessage = mock.fn(async () => {
      sends += 1;
      return { stepsBefore: 0, wasBusy: false };
    });

    const service = new AntigravityAgentService({ catId: 'antigravity', model: 'claude-opus-4-6', bridge });
    const messages = await collect(service.invoke('hi'));

    assert.equal(sends, 1, 'a real answer must NOT trigger a nudge');
    assert.equal(
      messages.find((m) => m.type === 'error' && m.errorCode === 'incomplete_response'),
      undefined,
    );
    assert.equal(messages.at(-1)?.type, 'done');
  });

  test('streamed deferral: terminal batch carries only the suffix delta, full text via cursor.latestPlannerText → still nudges (cloud #2558 P1)', async () => {
    // Antigravity streams planner text as suffix-only deltas (toReplayStep). When the
    // deferral spans polls, the TERMINAL batch's step holds only "分析。"; the complete
    // text "...让我整理分析。" lives in the bridge's latestPlanner snapshot, surfaced on
    // the cursor. The service must detect off the full snapshot, not the delta batch.
    const bridge = createMockBridge();
    const sentPrompts = [];
    bridge.sendMessage = mock.fn(async (_cascadeId, prompt) => {
      sentPrompts.push(prompt);
      return { stepsBefore: 0, wasBusy: false };
    });
    let turn = 0;
    bridge.pollForSteps = async function* () {
      turn += 1;
      if (turn === 1) {
        // poll batch 1: partial planner, NOT terminal
        yield {
          steps: [
            {
              type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
              status: 'CORTEX_STEP_STATUS_DONE',
              plannerResponse: { response: '好了，证据链够了。让我整理' },
            },
          ],
          cursor: {
            baselineStepCount: 0,
            lastDeliveredStepCount: 1,
            terminalSeen: false,
            lastActivityAt: Date.now(),
            latestPlannerText: '好了，证据链够了。让我整理',
          },
        };
        // poll batch 2: TERMINAL, step holds ONLY the streamed suffix delta
        yield {
          steps: [
            {
              type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
              status: 'CORTEX_STEP_STATUS_DONE',
              plannerResponse: { response: '分析。' },
            },
          ],
          cursor: {
            baselineStepCount: 0,
            lastDeliveredStepCount: 1,
            terminalSeen: true,
            lastActivityAt: Date.now(),
            // full snapshot the bridge already computed from raw allSteps
            latestPlannerText: '好了，证据链够了。让我整理分析。',
          },
        };
      } else {
        yield plannerBatch(REAL_ANSWER);
      }
    };

    const service = new AntigravityAgentService({ catId: 'antigravity', model: 'claude-opus-4-6', bridge });
    const messages = await collect(service.invoke('帮我分析'));

    assert.equal(sentPrompts.length, 2, 'chunked deferral must still trigger exactly one nudge');
    assert.notEqual(sentPrompts[1], '帮我分析', 'second send is the nudge');
    const texts = messages.filter((m) => m.type === 'text').map((m) => m.content);
    assert.ok(texts.includes(REAL_ANSWER), 'real answer delivered after nudge');
    assert.equal(messages.at(-1)?.type, 'done');
  });

  test('terminal text on a non-terminal batch, cascade flips IDLE as an empty terminal close → still nudges (cloud #2558 P1 round 3)', async () => {
    // Antigravity can emit the (DONE) planner text while the cascade is still RUNNING,
    // then flip to IDLE with no new/mutated steps — pollForSteps returns the terminal
    // cursor as an EMPTY batch (steps:[]). The text-bearing batch had terminalSeen=false,
    // so a terminalSeen-gated capture records nothing and the deferral completes silently.
    const bridge = createMockBridge();
    const sentPrompts = [];
    bridge.sendMessage = mock.fn(async (_cascadeId, prompt) => {
      sentPrompts.push(prompt);
      return { stepsBefore: 0, wasBusy: false };
    });
    let turn = 0;
    bridge.pollForSteps = async function* () {
      turn += 1;
      if (turn === 1) {
        // planner text delivered while cascade is still RUNNING (terminalSeen=false)
        yield {
          steps: [
            {
              type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
              status: 'CORTEX_STEP_STATUS_DONE',
              plannerResponse: { response: '好了，证据链够了。让我整理分析。' },
            },
          ],
          cursor: {
            baselineStepCount: 0,
            lastDeliveredStepCount: 1,
            terminalSeen: false,
            lastActivityAt: Date.now(),
            latestPlannerText: '好了，证据链够了。让我整理分析。',
          },
        };
        // cascade flips IDLE with NO new steps → empty terminal close
        yield {
          steps: [],
          cursor: {
            baselineStepCount: 0,
            lastDeliveredStepCount: 1,
            terminalSeen: true,
            lastActivityAt: Date.now(),
          },
        };
      } else {
        yield plannerBatch(REAL_ANSWER);
      }
    };

    const service = new AntigravityAgentService({ catId: 'antigravity', model: 'claude-opus-4-6', bridge });
    const messages = await collect(service.invoke('帮我分析'));

    assert.equal(sentPrompts.length, 2, 'empty-terminal-close deferral must still trigger one nudge');
    const texts = messages.filter((m) => m.type === 'text').map((m) => m.content);
    assert.ok(texts.includes(REAL_ANSWER), 'real answer delivered after nudge');
    assert.equal(messages.at(-1)?.type, 'done');
  });

  test('blank modifiedResponse falls back to response for detection (|| not ??) → still nudges (cloud #2558 P2)', async () => {
    // Antigravity can return modifiedResponse:'' with the real text in response; the
    // transformer DISPLAYS it via `modifiedResponse || response`, so the detector must
    // read the same non-empty field — a `??` snapshot would capture '' and miss it.
    // No cursor.latestPlannerText here, so the service's extractTerminalPlannerText
    // fallback (which also gates hasTerminalPlannerText) is what must use ||.
    const bridge = createMockBridge();
    const sentPrompts = [];
    bridge.sendMessage = mock.fn(async (_cascadeId, prompt) => {
      sentPrompts.push(prompt);
      return { stepsBefore: 0, wasBusy: false };
    });
    let turn = 0;
    bridge.pollForSteps = async function* () {
      turn += 1;
      if (turn === 1) {
        yield {
          steps: [
            {
              type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
              status: 'CORTEX_STEP_STATUS_DONE',
              plannerResponse: { modifiedResponse: '', response: '好了，证据链够了。让我整理分析。' },
            },
          ],
          cursor: { baselineStepCount: 0, lastDeliveredStepCount: 1, terminalSeen: true, lastActivityAt: Date.now() },
        };
      } else {
        yield plannerBatch(REAL_ANSWER);
      }
    };

    const service = new AntigravityAgentService({ catId: 'antigravity', model: 'claude-opus-4-6', bridge });
    const messages = await collect(service.invoke('帮我分析'));

    assert.equal(sentPrompts.length, 2, 'blank-modifiedResponse deferral must still nudge');
    const texts = messages.filter((m) => m.type === 'text').map((m) => m.content);
    assert.ok(texts.includes(REAL_ANSWER), 'real answer delivered after nudge');
    assert.equal(messages.at(-1)?.type, 'done');
  });

  test('near-miss terminal (looks deferred but predicate misses) is observability-only → no nudge', async () => {
    const bridge = createMockBridge();
    let sends = 0;
    bridge.sendMessage = mock.fn(async () => {
      sends += 1;
      return { stepsBefore: 0, wasBusy: false };
    });
    // '让我处理一下。' has the intent marker but no matched deliverable verb →
    // predicate returns false → near-miss → MUST NOT nudge (log only).
    bridge.pollForSteps = turnScriptedPoll(['让我处理一下。']);

    const service = new AntigravityAgentService({ catId: 'antigravity', model: 'claude-opus-4-6', bridge });
    const messages = await collect(service.invoke('hi'));

    assert.equal(sends, 1, 'a near-miss must not nudge (observability only)');
    assert.equal(
      messages.find((m) => m.type === 'error' && m.errorCode === 'incomplete_response'),
      undefined,
    );
    assert.equal(messages.at(-1)?.type, 'done');
  });
});
