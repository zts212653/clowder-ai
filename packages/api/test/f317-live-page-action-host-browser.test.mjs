import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { after, before, test } from 'node:test';
import puppeteer from 'puppeteer-core';
import { loadChromium } from '../../../scripts/f317-page-action/browser-binary.mjs';
import { startFixtureServer } from '../../../scripts/f317-page-action/serve.mjs';
import { pageActionGrantSha256 } from '../src/domains/concierge/action/LivePageAction.ts';
import { fixture, scope, startedActionCall } from './helpers/f317-page-action-fixture.ts';

const { createCdpPageActionPort } = await import(
  process.env.F317_TEST_COMPILED_ACTOR === '1'
    ? '../dist/domains/concierge/action/CdpPageActionPort.js'
    : '../src/domains/concierge/action/CdpPageActionPort.ts'
);

let browser;
let server;
let url;
before(async () => {
  ({ server, url } = await startFixtureServer());
  const chromium = await loadChromium();
  browser = await puppeteer.launch({ headless: true, executablePath: chromium.executablePath() });
});
after(async () => {
  await browser?.close();
  await new Promise((resolve) => server?.close(resolve));
});

async function hostBrowserEpisode(run) {
  const page = await browser.newPage();
  let call;
  try {
    await page.goto(url);
    const sessions = [];
    let bindingHook;
    const createSession = page.createCDPSession.bind(page);
    page.createCDPSession = async () => {
      const session = await createSession();
      session.on('Runtime.bindingCalled', () => bindingHook?.());
      sessions.push(session);
      return session;
    };
    const f = fixture();
    const started = await startedActionCall(f);
    call = started.call;
    const spec = {
      targets: [{ id: 'note', selector: '#note-input', operation: 'fill' }],
      readback: { selector: '#readback', kind: 'text' },
    };
    const port = createCdpPageActionPort(page, spec);
    const target = (await port.inspect()).candidates.find((candidate) => candidate.id === 'note');
    assert.ok(target);
    const approval = {
      approvalId: 'fixture-cdp-owner-approval',
      permissionScope: 'fixture-note-only',
      expiresAtMs: Date.now() + 60_000,
      origin: new URL(url).origin,
      url,
      targetId: 'note',
      operation: 'fill',
      value: 'approved text',
      expectedReadback: JSON.stringify({ open: false, note: 'approved text', deleted: false }),
    };
    const requestRevision = createHash('sha256')
      .update(JSON.stringify([f.source.id, f.source.content]))
      .digest('hex');
    started.approvalLedger.issue({
      approvalId: approval.approvalId,
      scope,
      requestSourceRef: `${scope.threadId}#${f.source.id}`,
      requestRevision,
      actionSha256: pageActionGrantSha256({
        origin: approval.origin,
        url,
        requestRevision,
        actions: [
          {
            targetId: target.id,
            operation: 'fill',
            value: approval.value,
            fingerprint: target.fingerprint,
            expectedReadback: approval.expectedReadback,
          },
        ],
      }),
      permissionScope: approval.permissionScope,
      expiresAtMs: approval.expiresAtMs,
    });
    const selector = {
      async select() {
        return { kind: 'act', targetId: 'note', operation: 'fill', value: approval.value };
      },
    };
    return await run({
      page,
      call,
      port,
      spec,
      sessions,
      approval,
      target,
      requestMessageId: f.source.id,
      selector,
      onBinding: (hook) => {
        bindingHook = hook;
      },
    });
  } finally {
    await call?.stop();
    await page.close();
  }
}

test('the Live Host seam drives a real approved Chromium fill and reads the page result', async () => {
  await hostBrowserEpisode(async ({ page, call, port, sessions, approval, requestMessageId, selector }) => {
    const result = await call.boundaryContexts.runPageAction({ requestMessageId, approval, port, selector });
    const readback = JSON.parse(await page.$eval('#readback', (element) => element.textContent));
    assert.equal(result.status, 'applied');
    assert.equal(result.after, approval.expectedReadback);
    assert.equal(readback.note, approval.value);
    assert.equal(sessions.length, 1);
    assert.ok(sessions[0].detached, 'the Host action must close the real CDP session');
  });
});

test('Host stop at the browser commit fence drains without changing the real page', async () => {
  await hostBrowserEpisode(async ({ page, call, port, sessions, approval, requestMessageId, selector, onBinding }) => {
    let stopping;
    onBinding(() => {
      stopping ??= call.stop();
    });
    const result = await call.boundaryContexts.runPageAction({ requestMessageId, approval, port, selector });
    assert.ok(stopping, 'the browser must reach its final Host fence');
    await stopping;
    const readback = JSON.parse(await page.$eval('#readback', (element) => element.textContent));
    assert.equal(result.status, 'cancelled');
    assert.equal(readback.note, '');
    assert.ok(sessions[0].detached, 'stop must release the real CDP session');
  });
});

test('the Live approval ledger rejects an old grant after the browser actor is rebuilt', async () => {
  await hostBrowserEpisode(
    async ({ page, call, port, spec, sessions, approval, target, requestMessageId, selector }) => {
      await port.close();
      await page.evaluate(() => {
        const old = document.querySelector('#note-input');
        const replacement = old.cloneNode(true);
        old.replaceWith(replacement);
        replacement.addEventListener('input', () => {
          window.replacementEffect = true;
        });
      });
      const rebuilt = createCdpPageActionPort(page, spec);
      const rebuiltTarget = (await rebuilt.inspect()).candidates.find((candidate) => candidate.id === 'note');
      assert.ok(rebuiltTarget);
      assert.notEqual(rebuiltTarget.fingerprint, target.fingerprint);
      await assert.rejects(
        call.boundaryContexts.runPageAction({ requestMessageId, approval, port: rebuilt, selector }),
        /approval unavailable/,
      );
      const readback = JSON.parse(await page.$eval('#readback', (element) => element.textContent));
      const replacementEffect = await page.evaluate(() => Boolean(window.replacementEffect));
      assert.equal(readback.note, '');
      assert.equal(replacementEffect, false);
      assert.equal(sessions.length, 2);
      assert.ok(sessions.every((session) => session.detached));
    },
  );
});
