import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { after, before, test } from 'node:test';
import puppeteer from 'puppeteer-core';
import { loadChromium } from '../../../scripts/f317-page-action/browser-binary.mjs';
import { startFixtureServer } from '../../../scripts/f317-page-action/serve.mjs';
import { pageActionGrantSha256, runLivePageAction } from '../src/domains/concierge/action/LivePageAction.ts';

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

async function replaceNoteWithDifferentListener(page) {
  await page.evaluate(() => {
    const old = document.querySelector('#note-input');
    const replacement = old.cloneNode(true);
    old.replaceWith(replacement);
    replacement.addEventListener('input', (event) => {
      window.replacementEffect = true;
      document.querySelector('#readback').textContent = JSON.stringify({
        open: false,
        note: event.target.value,
        deleted: false,
      });
    });
  });
}

async function episode(atFinalFence, prepareAction) {
  const page = await browser.newPage();
  try {
    await page.goto(url);
    const sessions = [];
    const openSession = page.createCDPSession.bind(page);
    page.createCDPSession = async () => {
      const session = await openSession();
      sessions.push(session);
      return session;
    };
    const spec = {
      targets: [{ id: 'note-input', selector: '#note-input', operation: 'fill' }],
      readback: { selector: '#readback', kind: 'text' },
    };
    const port = createCdpPageActionPort(page, spec);
    const snapshot = await port.inspect();
    const target = snapshot.candidates.find((item) => item.id === 'note-input');
    assert.ok(target);
    assert.match(target.fingerprint, /^sha256:[0-9a-f]{64}$/);
    assert.ok(!target.fingerprint.includes('note-input'));
    const controller = new AbortController();
    const scope = {
      userId: 'fixture-owner',
      threadId: 'fixture-thread',
      catId: 'codex6-sol',
      invocationId: 'fixture-invocation',
      callId: 'fixture-call',
      generation: 1,
    };
    const request = { sourceRef: 'fixture-thread#direct-owner-request', revision: 'r1', text: 'Fill the note' };
    const grant = {
      authorityId: 'fixture-grant',
      permissionScope: 'fixture-note',
      expiresAtMs: Date.now() + 60_000,
      action: {
        origin: new URL(url).origin,
        url,
        requestRevision: 'r1',
        actions: [
          {
            targetId: target.id,
            operation: 'fill',
            value: 'approved text',
            fingerprint: target.fingerprint,
            expectedReadback: JSON.stringify({ open: false, note: 'approved text', deleted: false }),
          },
        ],
      },
    };
    const actionPort = (await prepareAction?.({ page, port, spec, target })) ?? port;
    let reads = 0;
    let hostRevision = request.revision;
    let hostGrantId = grant.authorityId;
    const result = await runLivePageAction({
      admission: {
        scope,
        request,
        grant,
        signal: controller.signal,
        async readCurrent() {
          reads++;
          if (reads === 6)
            await atFinalFence?.({
              page,
              controller,
              changeRevision: (revision) => {
                hostRevision = revision;
              },
              revokeGrant: () => {
                hostGrantId = 'revoked';
              },
            });
          return {
            scope,
            request: {
              sourceRef: request.sourceRef,
              revision: hostRevision,
              textSha256: createHash('sha256').update(request.text).digest('hex'),
              kind: 'direct_owner',
            },
            grant: {
              authorityId: hostGrantId,
              permissionScope: grant.permissionScope,
              expiresAtMs: grant.expiresAtMs,
              actionSha256: pageActionGrantSha256(grant.action),
            },
          };
        },
      },
      selector: {
        async select() {
          return { kind: 'act', targetId: target.id, operation: 'fill', value: 'approved text' };
        },
      },
      port: actionPort,
    });
    assert.ok(reads >= (actionPort === port ? 6 : 3), 'action must recheck current Host authority');
    assert.equal(sessions.length, actionPort === port ? 1 : 2);
    assert.ok(
      sessions.every((session) => session.detached),
      'all browser CDP sessions must close before returning',
    );
    const readback = JSON.parse(await page.$eval('#readback', (element) => element.textContent));
    const replacementEffect = await page.evaluate(() => Boolean(window.replacementEffect));
    return { result, readback, replacementEffect };
  } finally {
    await page.close();
  }
}

test('CDP isolated-world actor fills the real DOM and reads the action-specific result', async () => {
  const { result, readback } = await episode(async ({ page }) => {
    await page.evaluate(() => {
      window.actionRequestRevision = 'page-forged-r999';
    });
  });
  assert.equal(result.status, 'applied');
  assert.equal(readback.note, 'approved text');
});

test('Host stop during the browser commit fence prevents the DOM effect', async () => {
  const { result, readback } = await episode(async ({ controller }) => controller.abort('stopped'));
  assert.equal(result.status, 'cancelled');
  assert.equal(readback.note, '');
});

test('target replacement while browser waits for Host fence is stale before effect', async () => {
  const { result, readback } = await episode(async ({ page }) => {
    await page.evaluate(() => document.querySelector('#note-input').setAttribute('data-revision', 'changed'));
  });
  assert.equal(result.status, 'stale');
  assert.equal(readback.note, '');
});

test('markup-identical replacement with new event semantics cannot reuse the old target grant', async () => {
  const { result, readback, replacementEffect } = await episode(async ({ page }) => {
    await replaceNoteWithDifferentListener(page);
  });
  assert.equal(result.status, 'stale');
  assert.equal(readback.note, '');
  assert.equal(replacementEffect, false);
});

test('a rebuilt actor cannot reuse a prior actor grant for an identical replacement node', async () => {
  let oldFingerprint;
  let rebuiltFingerprint;
  const { result, readback, replacementEffect } = await episode(undefined, async ({ page, port, spec, target }) => {
    oldFingerprint = target.fingerprint;
    await port.close();
    await replaceNoteWithDifferentListener(page);
    const rebuilt = createCdpPageActionPort(page, spec);
    rebuiltFingerprint = (await rebuilt.inspect()).candidates[0]?.fingerprint;
    return rebuilt;
  });
  assert.equal(result.status, 'stale');
  assert.equal(readback.note, '');
  assert.equal(replacementEffect, false);
  assert.notEqual(rebuiltFingerprint, oldFingerprint);
});

test('owner revision change during the browser commit fence prevents the effect', async () => {
  const { result, readback } = await episode(async ({ changeRevision }) => changeRevision('r2'));
  assert.equal(result.status, 'changed_request');
  assert.equal(readback.note, '');
});

test('grant revocation during the browser commit fence prevents the effect', async () => {
  const { result, readback } = await episode(async ({ revokeGrant }) => revokeGrant());
  assert.equal(result.status, 'denied');
  assert.equal(readback.note, '');
});

test('stop unwinds a never-settling Host read at the browser commit fence', async () => {
  const pending = episode(async ({ controller }) => {
    setTimeout(() => controller.abort('stopped'), 10);
    await new Promise(() => {});
  });
  const outcome = await Promise.race([
    pending,
    new Promise((resolve) => setTimeout(() => resolve({ result: { status: 'timeout_after_abort' } }), 500)),
  ]);
  assert.equal(outcome.result.status, 'cancelled');
  assert.equal(outcome.readback.note, '');
});
