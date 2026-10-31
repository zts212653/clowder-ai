import assert from 'node:assert/strict';
import { captureWithPassiveTrace, saveCssomArtifact } from './f294-export-trace.harness.mjs';

const WIDGET_ID = 'cssom-final-proof-race-widget';

async function commitPaintAfterCandidate(page, state, fixtureMessageId) {
  const identity = await page.evaluate(() => {
    const root = document.querySelector('[data-export-root]');
    const widget = document.querySelector('[data-html-widget]');
    return {
      url: location.href,
      fixtureMode: root?.getAttribute('data-export-fixture-mode'),
      messageId: root?.getAttribute('data-export-message-id'),
      widgetId: widget?.getAttribute('data-html-widget'),
      instanceId: widget?.getAttribute('data-html-widget-instance-id'),
      proofRequestId: widget?.getAttribute('data-html-widget-proof-request-id'),
      parentMonotonicMs: performance.now(),
    };
  });
  state.captureBoundary = { candidateComplete: identity };
  assert.equal(identity.fixtureMode, 'cssom-final-proof-race');
  assert.equal(identity.messageId, fixtureMessageId);
  assert.equal(identity.widgetId, WIDGET_ID);
  assert.ok(identity.instanceId && identity.proofRequestId, 'candidate must have a real instance and exact proof ACK');
  const iframe = await page.$(`[data-html-widget="${WIDGET_ID}"] iframe`);
  assert.ok(iframe, 'injection must target the rendered widget iframe');
  const frame = await iframe.contentFrame();
  assert.ok(frame, 'injection requires the actual child realm');
  // CDP evaluation completion is the commit barrier. It does not depend on a
  // sandboxed iframe receiving RAF callbacks, nor on an assumed proof ordinal.
  state.captureBoundary.commit = await frame.evaluate(() => {
    const sheet = document.querySelector('#post-proof-cssom-paint')?.sheet;
    if (!sheet || sheet.cssRules.length !== 0) throw new Error('fixture paint must wait for the capture boundary');
    sheet.insertRule(
      'html::after { content: "CSSOM_FINAL_PROOF_RACE_SENTINEL"; position: fixed; top: 1000px; height: 1000px; width: 100%; background: #ff00ff; }',
    );
    return { rule: sheet.cssRules[0].cssText, childMonotonicMs: performance.now() };
  });
  state.captureBoundary.commitReturnedAt = await page.evaluate(() => performance.now());
}

export async function assertFinalProofRejectsCommittedPaint({ exporter, fixtureMessageId, url }) {
  const state = await captureWithPassiveTrace(
    exporter,
    () =>
      exporter.capture(`${url}?fixture=cssom-final-proof-race`, 'browser-test-user', {
        selectionMessageIds: [fixtureMessageId],
      }),
    (page, captureState) => commitPaintAfterCandidate(page, captureState, fixtureMessageId),
  );
  let failure;
  try {
    assert.ok(state.candidatePng, 'the real screenshot must finish before injection');
    const boundary = state.captureBoundary;
    assert.ok(boundary?.commit, 'insertRule must commit before returning the candidate to the exporter');
    assert.match(boundary.commit.rule, /CSSOM_FINAL_PROOF_RACE_SENTINEL/);
    assert.equal(state.droppedTraceEvents, 0, 'the proof timeline must remain complete');
    const before = state.trace.find(
      (entry) =>
        entry.event === 'bridge-sample' &&
        entry.phase === 'measured' &&
        entry.proofRequestId === boundary.candidateComplete.proofRequestId,
    );
    assert.ok(before, 'the candidate must follow an observed exact pre-capture proof ACK');
    assert.equal(before.instanceId, boundary.candidateComplete.instanceId);
    assert.equal(before.hasUnmeasurableVisualOverflow, false);
    const request = state.trace.find(
      (entry) => entry.event === 'proof-request' && entry.parentMonotonicMs >= boundary.commitReturnedAt,
    );
    assert.ok(request, 'exporter must request a new proof after the candidate and committed mutation');
    assert.notEqual(request.proofRequestId, before.proofRequestId);
    assert.equal(request.identity.instanceId, before.instanceId);
    const after = state.trace.find(
      (entry) =>
        entry.event === 'bridge-sample' &&
        entry.phase === 'measured' &&
        entry.proofRequestId === request.proofRequestId,
    );
    assert.ok(after, 'the actual child must acknowledge the post-capture proof');
    assert.equal(after.blockId, WIDGET_ID);
    assert.equal(after.instanceId, before.instanceId);
    assert.equal(after.hasUnmeasurableVisualOverflow, true);
    assert.equal(state.returnedPng, null, 'the unverified candidate must never be returned');
    assert.match(String(state.error), /HTML widget layout failed: cssom-final-proof-race-widget/);
  } catch (error) {
    failure = error;
  }
  // Persist both successful and failed injections, including the rejected PNG.
  // Evidence-write failure is itself a failure, never a silent green result.
  await saveCssomArtifact(state, failure ?? state.error);
  if (failure) throw failure;
}
