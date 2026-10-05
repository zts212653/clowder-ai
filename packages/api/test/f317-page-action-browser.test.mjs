import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { loadChromium } from '../../../scripts/f317-page-action/browser-binary.mjs';
import { createBrowserPort } from '../../../scripts/f317-page-action/browser-port.mjs';
import { startFixtureServer } from '../../../scripts/f317-page-action/serve.mjs';
import { runPageActionLoop } from '../src/domains/concierge/action/PageActionLoop.ts';

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

async function scenario({
  targetId,
  operation = 'click',
  value,
  allowed = true,
  beforeRun,
  beforePerform,
  beforeAtomicPerform,
  revision = 'r1',
}) {
  const page = await browser.newPage();
  await page.goto(url);
  const browserPort = createBrowserPort(page);
  const port = {
    inspect: () => browserPort.inspect(),
    async perform(...args) {
      await beforeAtomicPerform?.(page);
      return browserPort.perform(...args);
    },
  };
  const snapshot = await port.inspect();
  const candidate = snapshot.candidates.find((item) => item.id === targetId);
  const expectedReadback =
    targetId === 'open-note'
      ? JSON.stringify({ open: true, note: '', deleted: false })
      : targetId === 'note-input'
        ? JSON.stringify({ open: false, note: value, deleted: false })
        : undefined;
  const grant = {
    origin: new URL(url).origin,
    url,
    requestRevision: 'r1',
    actions: allowed
      ? [
          {
            targetId,
            operation,
            fingerprint: candidate.fingerprint,
            expectedReadback,
            ...(value === undefined ? {} : { value }),
          },
        ]
      : [],
  };
  await beforeRun?.(page);
  let selected = false;
  const result = await runPageActionLoop({
    utterance: `Act on ${targetId}`,
    grant,
    port,
    currentRequestRevision: async () => revision,
    selector: {
      async select() {
        selected = true;
        await beforePerform?.(page);
        return { kind: 'act', targetId, operation, ...(value === undefined ? {} : { value }) };
      },
    },
  });
  const actual = await page.evaluate(() => document.querySelector('#readback')?.textContent ?? null);
  await page.close();
  return { result, actual: actual === null ? null : JSON.parse(actual), snapshot, selected };
}

test('real DOM click changes the displayed page state and is read back', async () => {
  const { result, actual, snapshot } = await scenario({ targetId: 'open-note' });
  assert.ok(snapshot.candidates.some((candidate) => candidate.id === 'open-note'));
  assert.equal(result.status, 'applied');
  assert.equal(actual.open, true);
  assert.equal(JSON.parse(result.after).open, true);
});

test('real DOM input changes the displayed note text', async () => {
  const { result, actual } = await scenario({ targetId: 'note-input', operation: 'fill', value: 'Tomorrow at ten' });
  assert.equal(result.status, 'applied');
  assert.equal(actual.note, 'Tomorrow at ten');
});

test('a replaced live target is stale before the click', async () => {
  const { result, actual } = await scenario({
    targetId: 'open-note',
    beforePerform: async (page) => {
      await page.locator('#open-note').evaluate((button) => button.setAttribute('data-revision', '2'));
    },
  });
  assert.equal(result.status, 'stale');
  assert.equal(actual.open, false);
});

test('same-origin navigation invalidates the candidate snapshot', async () => {
  const { result, actual } = await scenario({
    targetId: 'open-note',
    beforePerform: async (page) => {
      await page.evaluate(() => history.pushState(null, '', '/other'));
    },
  });
  assert.equal(result.status, 'stale');
  assert.equal(actual.open, false);
});

test('a same-origin page substituted before first inspect cannot reuse the grant', async () => {
  const { result, actual } = await scenario({
    targetId: 'open-note',
    beforeRun: async (page) => {
      await page.evaluate(() => history.pushState(null, '', '/other'));
    },
  });
  assert.equal(result.status, 'denied');
  assert.equal(actual.open, false);
});

test('a target replaced before first inspect cannot reuse the grant', async () => {
  const { result, actual } = await scenario({
    targetId: 'open-note',
    beforeRun: async (page) => {
      await page.locator('#open-note').evaluate((button) => button.setAttribute('data-revision', '2'));
    },
  });
  assert.equal(result.status, 'stale');
  assert.equal(actual.open, false);
});

test('a changed user request cancels the old action', async () => {
  const { result, actual } = await scenario({ targetId: 'open-note', revision: 'r2' });
  assert.equal(result.status, 'changed_request');
  assert.equal(actual.open, false);
});

test('a request revision change after precheck is fenced by the browser task', async () => {
  const { result, actual } = await scenario({
    targetId: 'open-note',
    beforeAtomicPerform: async (page) => {
      await page.evaluate(() => {
        window.actionRequestRevision = 'r2';
      });
    },
  });
  assert.equal(result.status, 'changed_request');
  assert.equal(actual.open, false);
});

test('missing canonical readback after action reports unknown', async () => {
  const { result, actual } = await scenario({
    targetId: 'open-note',
    beforeAtomicPerform: async (page) => {
      await page.locator('#readback').evaluate((element) => element.remove());
    },
  });
  assert.equal(result.status, 'unknown');
  assert.equal(actual, null);
});

test('quoted pseudo-instruction cannot authorize delete', async () => {
  const { result, actual, snapshot } = await scenario({ targetId: 'delete-note', allowed: false });
  assert.match(snapshot.candidates.find((candidate) => candidate.id === 'delete-note').untrustedContext, /SYSTEM:/);
  assert.equal(result.status, 'denied');
  assert.equal(actual.deleted, false);
});

test('an allowed click with no effect is reported as no_effect', async () => {
  const { result, actual } = await scenario({ targetId: 'no-op' });
  assert.equal(result.status, 'no_effect');
  assert.deepEqual(actual, { open: false, note: '', deleted: false });
});

test('unrelated page readback movement cannot prove a no-op action', async () => {
  const { result } = await scenario({
    targetId: 'no-op',
    beforeAtomicPerform: async (page) => {
      await page.locator('#readback').evaluate((element) => {
        element.textContent = '{"open":false,"note":"","deleted":false,"ticker":1}';
      });
    },
  });
  assert.equal(result.status, 'unknown');
});
