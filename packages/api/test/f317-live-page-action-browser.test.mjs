import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { after, before, test } from 'node:test';
import { loadChromium } from '../../../scripts/f317-page-action/browser-binary.mjs';
import { createBrowserPort } from '../../../scripts/f317-page-action/browser-port.mjs';
import { startFixtureServer } from '../../../scripts/f317-page-action/serve.mjs';
import { pageActionGrantSha256, runLivePageAction } from '../src/domains/concierge/action/LivePageAction.ts';

let browser;
let server;
let url;
before(async () => {
  ({ server, url } = await startFixtureServer());
  const chromium = await loadChromium();
  browser = await chromium.launch({ headless: true });
});
after(async () => {
  await browser?.close();
  await new Promise((resolve) => server?.close(resolve));
});

async function liveEpisode(beforeCommit) {
  const page = await browser.newPage();
  try {
    await page.goto(url);
    const browserPort = createBrowserPort(page);
    const snapshot = await browserPort.inspect();
    const target = snapshot.candidates.find((candidate) => candidate.id === 'note-input');
    assert.ok(target);
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
      authorityId: 'fixture-grant-1',
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
    const result = await runLivePageAction({
      admission: {
        scope,
        request,
        grant,
        signal: controller.signal,
        readCurrent: async () => ({
          scope,
          request: {
            sourceRef: request.sourceRef,
            revision: request.revision,
            textSha256: createHash('sha256').update(request.text).digest('hex'),
            kind: 'direct_owner',
          },
          grant: {
            authorityId: grant.authorityId,
            permissionScope: grant.permissionScope,
            expiresAtMs: grant.expiresAtMs,
            actionSha256: pageActionGrantSha256(grant.action),
          },
        }),
      },
      selector: {
        async select() {
          return { kind: 'act', targetId: target.id, operation: 'fill', value: 'approved text' };
        },
      },
      port: {
        inspect: () => browserPort.inspect(),
        async perform(choice, fingerprint, resourceUrl, revision, fence) {
          await beforeCommit?.(controller);
          const state = await fence();
          if (state !== 'current') return state;
          return browserPort.perform(choice, fingerprint, resourceUrl, revision);
        },
      },
    });
    const readback = JSON.parse(await page.locator('#readback').textContent());
    return { result, readback };
  } finally {
    await page.close();
  }
}

test('a Host-bound local episode fills the real DOM and reads its actual result', async () => {
  const { result, readback } = await liveEpisode();
  assert.equal(result.status, 'applied');
  assert.equal(readback.note, 'approved text');
});

test('stopping the Host before the local browser task commits leaves the page unchanged', async () => {
  const { result, readback } = await liveEpisode(async (controller) => controller.abort('stopped'));
  assert.equal(result.status, 'cancelled');
  assert.equal(readback.note, '');
});
