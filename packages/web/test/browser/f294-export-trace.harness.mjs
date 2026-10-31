import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import sharp from 'sharp';

const FIXTURE_TRACE_TYPE = 'cat-cafe:f294-fixture-trace';
const PROOF_REQUEST_EVENT = 'catcafe:html-widget-export-proof-request';
const WIDGET_SIZE_MESSAGE = 'cat-cafe:html-widget-size';
const MAX_TRACE_EVENTS = 80;

export async function countMagentaPixels(png) {
  const { data, info } = await sharp(png).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  let matches = 0;
  for (let offset = 0; offset < data.length; offset += info.channels) {
    if (data[offset] === 255 && data[offset + 1] === 0 && data[offset + 2] === 255) matches++;
  }
  return matches;
}

export async function captureWithPassiveTrace(exporter, capture, afterCandidate) {
  const browserSession = exporter.browserSession;
  assert.equal(typeof browserSession?.openPage, 'function', 'test helper requires the ImageExporter page owner');
  const originalOpenPage = browserSession.openPage;
  const state = { trace: [], droppedTraceEvents: 0, candidatePng: null, returnedPng: null, error: null };

  browserSession.openPage = async function tracedOpenPage(...args) {
    const page = await originalOpenPage.apply(this, args);
    await page.exposeFunction('__recordF294ExportTrace', (entry) => {
      if (state.trace.length < MAX_TRACE_EVENTS) state.trace.push(entry);
      else state.droppedTraceEvents += 1;
    });
    await page.evaluateOnNewDocument(
      ({ fixtureTraceType, proofRequestEvent, widgetSizeMessage }) => {
        if (window !== window.top) return;
        let sequence = 0;
        const publish = (entry) => {
          const sink = globalThis.__recordF294ExportTrace;
          if (typeof sink !== 'function') return;
          void sink({ sequence: ++sequence, parentMonotonicMs: performance.now(), ...entry }).catch(() => {});
        };
        const identity = () => {
          const root = document.querySelector('[data-export-root]');
          const widget = document.querySelector('[data-html-widget]');
          return {
            exportReady: root?.getAttribute('data-export-ready') ?? null,
            fixtureMode: root?.getAttribute('data-export-fixture-mode') ?? null,
            fixtureMessageId: root?.getAttribute('data-export-message-id') ?? null,
            declaredWidgetId: root?.getAttribute('data-export-widget-id') ?? null,
            instanceId: widget?.getAttribute('data-html-widget-instance-id') ?? null,
            renderedWidgetId: widget?.getAttribute('data-html-widget') ?? null,
            layoutState: widget?.getAttribute('data-html-widget-layout-state') ?? null,
            expanded: widget?.getAttribute('data-html-widget-expanded') ?? null,
            measuredHeight: widget?.getAttribute('data-html-widget-measured-height') ?? null,
            proofRequestId: widget?.getAttribute('data-html-widget-proof-request-id') ?? null,
          };
        };
        window.addEventListener(proofRequestEvent, (event) => {
          publish({ event: 'proof-request', proofRequestId: event.detail, identity: identity() });
        });
        window.addEventListener('message', (event) => {
          const data = event.data;
          if (!data || typeof data !== 'object') return;
          if (data.type === fixtureTraceType && data.v === 1) {
            publish({
              event: 'fixture-trace',
              phase: data.phase,
              fixtureMode: data.fixtureMode,
              widgetId: data.widgetId,
              proofRequestId: data.proofRequestId,
              childMonotonicMs: data.monotonicMs,
              mutationError: data.mutationError,
              delayIndex: data.delayIndex,
              requestedDelayMs: data.requestedDelayMs,
              appliedDelayMs: data.appliedDelayMs,
            });
          }
          if (data.type === widgetSizeMessage) {
            publish({
              event: 'bridge-sample',
              phase: data.phase,
              blockId: data.blockId,
              instanceId: data.instanceId,
              cause: data.cause,
              proofRequestId: data.proofRequestId ?? null,
              contentHeight: data.contentHeight,
              bodyScrollHeight: data.bodyScrollHeight,
              rootScrollHeight: data.rootScrollHeight,
              viewportHeight: data.viewportHeight,
              viewportWidth: data.viewportWidth,
              hasUnmeasurableVisualOverflow: data.hasUnmeasurableVisualOverflow,
            });
          }
        });
        const stateAttributes = [
          'data-export-ready',
          'data-export-fixture-mode',
          'data-export-message-id',
          'data-export-widget-id',
          'data-html-widget',
          'data-html-widget-layout-state',
          'data-html-widget-expanded',
          'data-html-widget-measured-height',
          'data-html-widget-proof-request-id',
        ];
        new MutationObserver((records) => {
          const changedAttributes = records
            .filter(
              (record) =>
                record.type === 'attributes' &&
                record.attributeName &&
                (record.target.matches?.('[data-export-root]') || record.target.matches?.('[data-html-widget]')),
            )
            .map((record) => record.attributeName);
          if (changedAttributes.length > 0) {
            publish({
              event: 'widget-state',
              changedAttributes: [...new Set(changedAttributes)],
              identity: identity(),
            });
          }
        }).observe(document, { subtree: true, attributes: true, attributeFilter: stateAttributes });
      },
      {
        fixtureTraceType: FIXTURE_TRACE_TYPE,
        proofRequestEvent: PROOF_REQUEST_EVENT,
        widgetSizeMessage: WIDGET_SIZE_MESSAGE,
      },
    );
    const originalScreenshot = page.screenshot.bind(page);
    page.screenshot = async (...screenshotArgs) => {
      const png = await originalScreenshot(...screenshotArgs);
      state.candidatePng = Buffer.from(png);
      if (afterCandidate) await afterCandidate(page, state);
      return png;
    };
    return page;
  };

  try {
    state.returnedPng = await capture();
  } catch (error) {
    state.error = error;
  } finally {
    browserSession.openPage = originalOpenPage;
  }
  return state;
}

export async function saveCssomArtifact(state, error) {
  const directory = await mkdtemp(path.join(tmpdir(), 'f294-cssom-export-failure-'));
  const png = state.returnedPng ?? state.candidatePng;
  let pngEvidence = null;
  if (png) {
    const metadata = await sharp(png).metadata();
    const pngPath = path.join(directory, 'candidate.png');
    await writeFile(pngPath, png);
    pngEvidence = {
      path: pngPath,
      bytes: png.length,
      sha256: createHash('sha256').update(png).digest('hex'),
      width: metadata.width ?? null,
      height: metadata.height ?? null,
      exactMagentaPixels: await countMagentaPixels(png),
    };
  }
  const payload = {
    error: error ? String(error.stack ?? error).slice(0, 4_096) : null,
    png: pngEvidence,
    droppedTraceEvents: state.droppedTraceEvents,
    trace: state.trace,
    captureBoundary: state.captureBoundary ?? null,
  };
  await writeFile(path.join(directory, 'failure.json'), `${JSON.stringify(payload, null, 2)}\n`);
  process.stderr.write(`F294 CSSOM artifact: ${directory}\n`);
}
