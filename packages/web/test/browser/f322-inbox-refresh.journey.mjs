import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';

function gate() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** Exercise the already edited native card while session and source reads finish separately. */
export async function assertInboxRefreshContinuity(page, row, evidence, labels) {
  // Wait for the preceding real PageDown to finish, without replacing that gesture with a scripted scroll.
  await row.evaluate(async (element) => {
    const message = element.querySelector('[data-testid="proposal-initial-message"] section');
    let previous = message.scrollTop,
      stable = 0;
    for (let frame = 0; frame < 120; frame++) {
      await new Promise(requestAnimationFrame);
      const current = message.scrollTop;
      stable = current === previous ? stable + 1 : 0;
      previous = current;
      if (stable === 3) return;
    }
    throw new Error('The preceding first-message keyboard scroll did not settle');
  });
  const session = gate(),
    read = gate();
  const sessionPath = '**/api/session';
  const readPath = '**/api/concierge/work/decisions?**';
  const sessionHandler = async (route) => {
    await session.promise;
    await route.continue();
  };
  const readHandler = async (route) => {
    if (!new URL(route.request().url()).searchParams.has('includeUserMentions')) return route.continue();
    await read.promise;
    await route.continue();
  };
  await page.route(sessionPath, sessionHandler);
  await page.route(readPath, readHandler);
  await row.evaluate((element) => {
    const panel = element.closest('[data-testid="mailbox-panel"]');
    const port = element.closest('[role="region"]');
    const message = element.querySelector('[data-testid="proposal-initial-message"] section');
    const trace = { frames: [], phase: 'before' };
    window.__inboxRefresh = trace;
    const sample = () => {
      trace.frames.push({
        phase: trace.phase,
        connected: element.isConnected,
        pin: element.querySelector('input[role="switch"]')?.checked,
        rows: panel.querySelectorAll('[data-testid="mailbox-item"]').length,
        messageConnected: message.isConnected,
        top: port.scrollTop,
        messageTop: message.scrollTop,
        cardY: element.getBoundingClientRect().y,
        count: panel.querySelector('[data-testid="mailbox-state-text"]')?.textContent,
        groups: [...panel.querySelectorAll('[data-testid^="mailbox-group-"] > h3')].map((node) => node.textContent),
      });
      trace.raf = requestAnimationFrame(sample);
    };
    sample();
  });
  const paint = () =>
    page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
  try {
    const sessionStarted = page.waitForRequest((request) => new URL(request.url()).pathname === '/api/session');
    const readStarted = page.waitForRequest((request) => {
      const url = new URL(request.url());
      return url.pathname === '/api/concierge/work/decisions' && url.searchParams.has('includeUserMentions');
    });
    await page.evaluate(() => {
      window.__inboxRefresh.phase = 'session-pending';
      window.dispatchEvent(new Event('cat-cafe:entrusted-work-projection-invalidated'));
    });
    await Promise.all([sessionStarted, readStarted]);
    await paint();
    assert.equal(await row.count(), 1, 'background session verification must keep the edited card');
    assert.equal(await row.getByRole('switch', { name: labels.pin, exact: true }).isChecked(), true);
    assert.equal(
      await row.getByTestId('approve-btn').isDisabled(),
      true,
      'display retention does not authorize a write',
    );
    const sessionResponse = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/session');
    session.resolve();
    await sessionResponse;
    await page.evaluate(() => {
      window.__inboxRefresh.phase = 'source-pending';
    });
    await paint();
    await page.screenshot({ path: path.join(evidence, 'refresh-in-flight.png'), fullPage: true });
    const readResponse = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return url.pathname === '/api/concierge/work/decisions' && url.searchParams.has('includeUserMentions');
    });
    read.resolve();
    assert.equal((await readResponse).status(), 200);
    await row.getByTestId('approve-btn').waitFor();
    await page.waitForFunction(
      () =>
        !document.querySelector('[data-testid="approval-item-inbox-native-approve"] [data-testid="approve-btn"]')
          ?.disabled,
    );
    await page.evaluate(() => {
      window.__inboxRefresh.phase = 'settled';
    });
    await paint();
    assert.equal(await row.getByRole('switch', { name: labels.pin, exact: true }).isChecked(), true);
    const frames = await page.evaluate(() => window.__inboxRefresh.frames);
    const first = frames[0];
    assert.ok(first.messageTop > 0, 'the pre-refresh baseline retains the real keyboard reading position');
    assert.ok(
      frames.every((frame) => frame.connected && frame.pin),
      'no painted frame may unmount the card or reset its pin',
    );
    assert.ok(
      frames.every((frame) => frame.count === first.count),
      'confirmed panel counts stay visible',
    );
    assert.ok(
      frames.every((frame) => JSON.stringify(frame.groups) === JSON.stringify(first.groups)),
      'group counts stay visible',
    );
    assert.ok(
      frames.every((frame) => Math.abs(frame.top - first.top) <= 1 && Math.abs(frame.cardY - first.cardY) <= 1),
      'panel position stays fixed',
    );
    assert.ok(
      frames.every((frame) => frame.messageConnected && frame.messageTop === first.messageTop),
      'the first-message reading position survives',
    );
  } finally {
    session.resolve();
    read.resolve();
    await page.evaluate(() => cancelAnimationFrame(window.__inboxRefresh.raf));
    await writeFile(
      path.join(evidence, 'refresh-frames.json'),
      JSON.stringify(await page.evaluate(() => window.__inboxRefresh.frames), null, 2),
    );
    await page.unroute(sessionPath, sessionHandler);
    await page.unroute(readPath, readHandler);
  }
}
