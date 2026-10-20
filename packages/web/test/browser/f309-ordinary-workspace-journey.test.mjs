import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { after, before, test } from 'node:test';
import { registerDocumentProgressLayoutJourneys } from './f309-document-progress-layout.journey.mjs';
import { probeDocumentReceiptClick } from './f309-document-receipt-stability.mjs';
import { registerFirstFileJourney } from './f309-first-file-journey.mjs';
import { registerLargeWorkspaceVideoJourney } from './f309-large-workspace-video.mjs';
import { registerNativeSendAckCloseJourneys } from './f309-native-send-ack-close.mjs';
import { registerDocumentReopenJourney } from './f309-ordinary-document-reopen.mjs';
import { registerArtworkEntryJourneys } from './f309-ordinary-workspace-journey-artwork-entry.mjs';
import { registerOrdinaryChatCompareJourney } from './f309-ordinary-workspace-journey-chat-compare.mjs';
import { registerOrdinaryChatCompareRoundJourney } from './f309-ordinary-workspace-journey-chat-compare-round.mjs';
import { registerOrdinaryChatMediaJourney } from './f309-ordinary-workspace-journey-chat-media.mjs';
import { EVIDENCE, registerOrdinaryChatProgressJourney } from './f309-ordinary-workspace-journey-chat-progress.mjs';
import { registerOrdinaryChatReceiptJourney } from './f309-ordinary-workspace-journey-chat-receipt.mjs';
import { registerOrdinaryChatTextRequestJourney } from './f309-ordinary-workspace-journey-chat-text-request.mjs';
import { registerOrdinaryDocumentJourney } from './f309-ordinary-workspace-journey-document.mjs';
import { registerOrdinaryEntryJourneys } from './f309-ordinary-workspace-journey-entries.mjs';
import { assertArtworkLayout, registerOrdinaryImageJourney } from './f309-ordinary-workspace-journey-image.mjs';
import { registerOrdinaryModificationJourney } from './f309-ordinary-workspace-journey-modification.mjs';
import { registerOrdinaryOwnerJourney } from './f309-ordinary-workspace-journey-owner.mjs';
import {
  startF309OrdinaryWorkspaceJourney,
  stopF309OrdinaryWorkspaceJourney,
} from './f309-ordinary-workspace-journey-runtime.mjs';
import { registerOrdinaryTextQuoteJourney } from './f309-ordinary-workspace-journey-text-quote.mjs';
import { registerOrdinaryVideoJourney } from './f309-ordinary-workspace-journey-video.mjs';
import { registerOrdinaryVideoModificationJourney } from './f309-ordinary-workspace-journey-video-modification.mjs';
import { registerPublishedTextJourneys } from './f309-published-text-journey.mjs';
import { registerStudio297LongImageJourneys } from './f309-studio297-long-image.mjs';
import { registerTaskPublicationHeaderJourneys } from './f309-task-publication-header.mjs';

let suite;

before(async () => {
  suite = await startF309OrdinaryWorkspaceJourney();
});

after(async () => {
  if (suite) await stopF309OrdinaryWorkspaceJourney(suite);
});

registerOrdinaryImageJourney(() => suite);
registerOrdinaryModificationJourney(() => suite);
registerOrdinaryVideoJourney(() => suite);
registerOrdinaryVideoModificationJourney(() => suite);
registerOrdinaryOwnerJourney(() => suite);
registerOrdinaryEntryJourneys(() => suite);
registerArtworkEntryJourneys(() => suite);
registerLargeWorkspaceVideoJourney(() => suite);
registerStudio297LongImageJourneys(() => suite);
registerTaskPublicationHeaderJourneys(() => suite);
registerOrdinaryTextQuoteJourney(() => suite);
registerOrdinaryChatProgressJourney(() => suite);
registerOrdinaryChatReceiptJourney(() => suite);
registerOrdinaryChatMediaJourney(() => suite);
registerOrdinaryChatTextRequestJourney(() => suite);
registerOrdinaryChatCompareJourney(() => suite);
registerOrdinaryChatCompareRoundJourney(() => suite);
registerOrdinaryDocumentJourney(() => suite);
registerDocumentProgressLayoutJourneys(() => suite);
registerDocumentReopenJourney(() => suite);
registerFirstFileJourney(() => suite);
registerPublishedTextJourneys(() => suite);

for (const changesAdjacentGeometry of [false, true]) {
  test(
    `document click geometry probe: ${changesAdjacentGeometry ? 'rejects adjacent layout change during native input' : 'accepts stable native input'}`,
    { timeout: 30_000 },
    async () => {
      await mkdir(EVIDENCE, { recursive: true });
      const context = await suite.browser.newContext({ viewport: { width: 1440, height: 900 } });
      try {
        const page = await context.newPage();
        await page.route('http://f309-probe.test/**', (route) =>
          route.fulfill({
            status: 200,
            contentType: 'text/html; charset=utf-8',
            body: `<main style="position:absolute;left:312px;top:84px;width:1112px;height:711px;overflow:auto">
              <div data-message-viewport-boundary data-message-id="previous" style="display:flow-root;height:80px"></div>
              <div data-message-viewport-boundary data-message-id="receipt" style="display:flow-root;position:absolute;top:300px;height:52px;width:1112px">
                <button aria-label="打开对照" style="display:block;margin:8px 0 0 732px;padding:0;border:0;height:16px;width:48px">打开对照</button>
              </div></main>`,
          }),
        );
        await page.goto('http://f309-probe.test/native-click');
        await page.evaluate((changes) => {
          window.probeClickCount = 0;
          const button = document.querySelector('button');
          button.addEventListener('click', () => {
            window.probeClickCount += 1;
          });
          if (changes) {
            button.addEventListener(
              'pointerdown',
              () => {
                document.querySelector('[data-message-id="previous"]').style.height = '100px';
              },
              { once: true },
            );
          }
        }, changesAdjacentGeometry);
        const host = page.locator('[data-message-id="receipt"]');
        await host.getByRole('button', { name: '打开对照' }).scrollIntoViewIfNeeded();
        const evidence = `${EVIDENCE}/document-probe-control-${changesAdjacentGeometry ? 'layout-change' : 'stable'}.json`;
        const probe = probeDocumentReceiptClick(page, host, 'receipt', evidence);
        if (changesAdjacentGeometry) await assert.rejects(probe, /previous height changed during the native click/);
        else await probe;
        assert.equal(
          await page.evaluate(() => window.probeClickCount),
          1,
          'the control must reach the original native click',
        );
      } finally {
        await context.close();
      }
    },
  );
}

for (const condition of ['responsive transition', 'stable overflow', 'never settles']) {
  test(`ordinary artwork geometry: ${condition}`, { timeout: 10_000 }, async (t) => {
    const context = await suite.browser.newContext({ viewport: { width: 1280, height: 900 } });
    t.after(() => context.close());
    const page = await context.newPage();
    await page.setContent(`<style>
      #canvas { position:relative; width:360px; height:400px; }
      #media { width:360px; height:300px; }
      #tools { position:absolute; bottom:0; width:360px; height:50px; }
      @keyframes enter { from { transform:translateX(400px) } to { transform:translateX(0) } }
      @keyframes drift { from { transform:translateX(0) } to { transform:translateX(20px) } }
      @media(max-width:500px) { #tools { ${
        condition === 'responsive transition'
          ? 'animation:enter .35s linear'
          : condition === 'stable overflow'
            ? 'transform:translateX(20px)'
            : 'animation:drift .04s linear infinite alternate'
      } } }
      </style><main data-testid="workspace-content-review-surface">
        <section id="canvas" data-testid="workspace-review-artwork">
          <div id="media" data-testid="workspace-content-review-media"></div>
          <div id="tools" role="region" aria-label="作品画布工具"></div>
        </section></main>`);
    await page.setViewportSize({ width: 390, height: 844 });
    const name = `geometry-control-${condition.replaceAll(' ', '-')}`;
    if (condition === 'responsive transition') {
      await assertArtworkLayout(page, name);
    } else {
      await assert.rejects(assertArtworkLayout(page, name), (error) => {
        assert.match(
          error.message,
          condition === 'stable overflow' ? /controls and media stay inside their own canvas/ : /did not settle/,
        );
        for (const field of ['viewport', 'canvas', 'toolbar', 'media']) assert.match(error.message, new RegExp(field));
        return true;
      });
    }
  });
}

registerNativeSendAckCloseJourneys(async () => {
  await stopF309OrdinaryWorkspaceJourney(suite);
  suite = undefined;
});
