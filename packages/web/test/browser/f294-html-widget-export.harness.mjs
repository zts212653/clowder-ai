import assert from 'node:assert/strict';
import { captureWithPassiveTrace, countMagentaPixels, saveCssomArtifact } from './f294-export-trace.harness.mjs';
import { assertFinalProofRejectsCommittedPaint } from './f294-final-proof-race.harness.mjs';

export { countMagentaPixels } from './f294-export-trace.harness.mjs';

function findFirstProofAndAck(trace) {
  const request = trace.find((entry) => entry.event === 'proof-request');
  const ack = request
    ? trace.find(
        (entry) =>
          entry.event === 'bridge-sample' &&
          entry.phase === 'measured' &&
          entry.proofRequestId === request.proofRequestId,
      )
    : undefined;
  assert.ok(request, 'exporter must issue a fresh widget proof request');
  assert.ok(ack, 'bridge must acknowledge the same fresh proof request');
  return { request, ack };
}

export async function runF294HtmlWidgetExportContract({ browser, exporter, fixtureMessageId, t, url }) {
  await t.test('withholds export readiness and fixture identity until URL hydration commits', async () => {
    const blockedPage = await browser.newPage({ javaScriptEnabled: false, viewport: { width: 1280, height: 900 } });
    const fixtureUrl = `${url}?fixture=cssom-root-pseudo-content&export=true&messageId=${fixtureMessageId}`;
    try {
      await blockedPage.goto(fixtureUrl, { waitUntil: 'domcontentloaded' });
      const root = blockedPage.locator('[data-export-root]');
      await root.waitFor();
      assert.equal(await root.getAttribute('data-export-ready'), null, 'SSR fallback must not claim export readiness');
      assert.equal(await root.getAttribute('data-export-fixture-mode'), null);
      assert.equal(await root.getAttribute('data-export-widget-id'), null);
      assert.equal(
        await blockedPage.locator('[data-html-widget]').count(),
        0,
        'SSR fallback must not mount another fixture',
      );
    } finally {
      await blockedPage.close();
    }
  });

  await t.test('viewport-bound root generated overflow rejects instead of clipping', async () => {
    await assert.rejects(
      () =>
        exporter.capture(`${url}?fixture=root-pseudo-feedback`, 'browser-test-user', {
          selectionMessageIds: [fixtureMessageId],
        }),
      /HTML widget layout failed/,
    );
  });

  await t.test('fixed generated paint outside every scroll extent rejects instead of clipping', async () => {
    await assert.rejects(
      () =>
        exporter.capture(`${url}?fixture=fixed-root-pseudo`, 'browser-test-user', {
          selectionMessageIds: [fixtureMessageId],
        }),
      /HTML widget layout failed/,
    );
  });

  await t.test('CSSOM-generated fixed paint revokes stale readiness before screenshot', async () => {
    await assert.rejects(
      () =>
        exporter.capture(`${url}?fixture=cssom-fixed-root-pseudo`, 'browser-test-user', {
          selectionMessageIds: [fixtureMessageId],
        }),
      /HTML widget layout failed/,
    );
  });

  await t.test('CSSOM paint inserted after the final pre-capture proof invalidates the candidate PNG', async () => {
    await assertFinalProofRejectsCommittedPaint({ exporter, fixtureMessageId, url });
  });

  await t.test('delays both proof scheduling paths beyond the retired two-second sub-deadline', async () => {
    const state = await captureWithPassiveTrace(exporter, () =>
      exporter.capture(`${url}?fixture=delayed-proof`, 'browser-test-user', {
        selectionMessageIds: [fixtureMessageId],
      }),
    );
    if (state.error) throw state.error;
    const { request, ack } = findFirstProofAndAck(state.trace);
    const rafDelays = state.trace.filter(
      (entry) =>
        entry.event === 'fixture-trace' &&
        entry.phase === 'raf-delay-applied' &&
        entry.proofRequestId === request.proofRequestId,
    );
    const timerDelays = state.trace.filter(
      (entry) =>
        entry.event === 'fixture-trace' &&
        entry.phase === 'timer-fallback-delay-applied' &&
        entry.proofRequestId === request.proofRequestId,
    );
    assert.equal(request.identity.fixtureMode, 'delayed-proof');
    assert.equal(request.identity.declaredWidgetId, 'delayed-proof-widget');
    assert.equal(rafDelays.length, 2, 'both nested RAF callbacks must be delayed');
    assert.equal(timerDelays.length, 1, 'the 100ms timer fallback must be delayed independently');
    assert.ok(
      ack.parentMonotonicMs - request.parentMonotonicMs >= 2_000,
      `fresh proof ACK must outlive 2s after both schedulers are delayed; got ${ack.parentMonotonicMs - request.parentMonotonicMs}ms`,
    );
  });

  await t.test('measurable CSSOM flow mutates on the first proof and enters the PNG', async () => {
    const state = await captureWithPassiveTrace(exporter, () =>
      exporter.capture(`${url}?fixture=cssom-root-pseudo-content`, 'browser-test-user', {
        selectionMessageIds: [fixtureMessageId],
      }),
    );
    try {
      if (state.error) throw state.error;
      const { request, ack } = findFirstProofAndAck(state.trace);
      const attempted = state.trace.find(
        (entry) =>
          entry.event === 'fixture-trace' &&
          entry.phase === 'mutation-attempted' &&
          entry.proofRequestId === request.proofRequestId,
      );
      const succeeded = state.trace.find(
        (entry) =>
          entry.event === 'fixture-trace' &&
          entry.phase === 'mutation-succeeded' &&
          entry.proofRequestId === request.proofRequestId,
      );
      assert.ok(attempted, 'fixture must record the first proof-bound CSSOM mutation attempt');
      assert.ok(succeeded, 'fixture must record successful insertRule before the fresh ACK');
      assert.ok(attempted.sequence < succeeded.sequence && succeeded.sequence < ack.sequence);
      assert.equal(request.identity.layoutState, 'ready', 'initial widget readiness must precede the first proof');
      assert.equal(request.identity.expanded, 'true');
      assert.equal(request.identity.fixtureMode, 'cssom-root-pseudo-content');
      assert.equal(request.identity.declaredWidgetId, 'cssom-root-pseudo-content-widget');
      const initialHeight = Number(request.identity.measuredHeight);
      assert.ok(Number.isFinite(initialHeight) && initialHeight > 0);
      assert.ok(ack.rootScrollHeight > initialHeight + 900, 'fresh bridge ACK must measure the inserted flow');
      const expandedRequest = state.trace.find(
        (entry) =>
          entry.event === 'proof-request' &&
          entry.sequence > ack.sequence &&
          Number(entry.identity.measuredHeight) > initialHeight + 900,
      );
      assert.ok(expandedRequest, 'a later proof must observe the expanded parent widget height');
      const png = state.returnedPng;
      assert.ok(png, 'exporter must return the verified candidate PNG');
      const magentaPixels = await countMagentaPixels(png);
      assert.ok(magentaPixels > 100_000, `fresh proof lost exact magenta flow paint (${magentaPixels} pixels)`);
    } catch (error) {
      try {
        await saveCssomArtifact(state, error);
      } catch (artifactError) {
        process.stderr.write(`F294 CSSOM artifact write failed: ${String(artifactError)}\n`);
      }
      throw error;
    }
  });
}
