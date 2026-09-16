/* Browser journey for the first-run prototype.
 *
 *   node --test site/onboarding-first-run/journey.browser.test.mjs
 *
 * Opens index.html over file:// in Chromium and walks the journey the way a user would.
 * Playwright is resolved like the other browser tests in this repo; set PLAYWRIGHT_MODULE to
 * point elsewhere. Every claim in DEMO-CONTRACT.md §9 has a test here. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const pwPath =
  process.env.PLAYWRIGHT_MODULE || path.resolve(here, '../../packages/ppt-forge/node_modules/playwright/index.mjs');
const { chromium } = await import(pathToFileURL(pwPath).href);
const PAGE = pathToFileURL(path.join(here, 'index.html')).href;

let browser;
before(async () => {
  browser = await chromium.launch();
});
after(async () => {
  await browser?.close();
});

async function open(query) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${PAGE}?${query}`);
  return { page, errors };
}
const stateOf = (page) => page.evaluate(() => window.__onb);
const until = (page, fn, arg) => page.waitForFunction(fn, arg, { timeout: 60000 });

async function jumpTo(page, fixture, scene) {
  await page.selectOption('#devFixture', fixture);
  await page.selectOption('#devScene', scene);
}

describe('first-run journey', () => {
  it('goes from first launch to a first real message, and keeps it after a refresh', async () => {
    const { page, errors } = await open('fresh=1&speed=12&fixture=one-ready&variant=after');
    await page.waitForSelector('#stageCopy.shown');
    assert.equal((await stateOf(page)).stage, 'intro');
    await page.click('#startBtn');

    // The demo is scripted: three bubbles, the review changes the result.
    await page.waitForSelector('#narrateNext');
    const bubbles = await page.$$eval('#messages .msg[data-cat]', (rows) => rows.map((r) => r.dataset.cat));
    assert.deepEqual(bubbles, ['ragdoll', 'maine', 'ragdoll'], 'draft, review, improved result');
    assert.ok(await page.$('#messages ins'), 'the improved wording is visibly marked');
    assert.equal((await stateOf(page)).demo, 'done');

    // Setup: the logged-in client is preselected, so the user can continue.
    await page.click('#narrateNext');
    await page.waitForSelector('#setupNext:not([disabled])');
    await page.click('#setupNext');
    await until(page, () => window.__onb?.stage === 'chat');
    const s = await stateOf(page);
    assert.deepEqual(s.members, [{ cat: 'siamese', client: 'claude' }], 'the narrator becomes the only member');

    // Scene 8: the reminder is already there on arrival, and it does not block speaking.
    await page.waitForFunction(() => !document.getElementById('input').disabled);
    assert.ok(await page.isVisible('#hint'), 'the entrance reminder shows once the real window opens');

    // A sentinel that exists nowhere in the fixtures must become a message.
    const sentinel = `sentinel-${randomUUID()}`;
    await page.fill('#input', sentinel);
    await page.click('#send');
    await until(page, () => window.__onb?.firstExchange === 'done');
    const userText = await page.textContent('#messages [data-role="user-message"] .bubble');
    assert.equal(userText, sentinel);

    // Recovery claim: reopen without ?fresh and the conversation is still there.
    await page.goto(`${PAGE}?speed=12`);
    await page.waitForSelector('#messages [data-role="user-message"]');
    assert.equal(await page.textContent('#messages [data-role="user-message"] .bubble'), sentinel);
    assert.equal((await stateOf(page)).firstExchange, 'done');
    assert.equal(await page.isVisible('#stageCopy.shown'), false, 'the demo does not replay');
    assert.deepEqual(errors, []);
    await page.close();
  });

  it('does not treat a click on "log in" as a login, even across a refresh', async () => {
    const { page, errors } = await open('fresh=1&speed=12');
    await jumpTo(page, 'one-login', 'setup');
    await page.waitForSelector('[data-login="codex"]');
    assert.equal(await page.isDisabled('#setupNext'), true);
    await page.click('[data-login="codex"]');
    await until(page, () => window.__onb?.clients.codex.login === 'pending');
    assert.equal(await page.isDisabled('#setupNext'), true, 'pending is not logged in');

    await page.goto(`${PAGE}?speed=12`);
    await page.waitForSelector('#setupNext');
    assert.equal((await stateOf(page)).clients.codex.login, 'pending', 'still pending after refresh');
    assert.equal(await page.isDisabled('#setupNext'), true);

    await page.click('#devLoginOk');
    await page.waitForSelector('#setupNext:not([disabled])');
    assert.equal((await stateOf(page)).clients.codex.login, 'done');
    assert.deepEqual(errors, []);
    await page.close();
  });

  it('stops honestly with no client, and continues from setup after installing', async () => {
    const { page, errors } = await open('fresh=1&speed=12');
    await jumpTo(page, 'none', 'setup');
    await page.waitForSelector('#setupEmpty');
    assert.equal(await page.isDisabled('#setupNext'), true);
    await page.selectOption('#devFixture', 'one-ready');
    await page.click('#redetect');
    await page.waitForSelector('#setupNext:not([disabled])');
    const s = await stateOf(page);
    assert.equal(s.stage, 'setup', 'redetect continues here instead of replaying the demo');
    assert.deepEqual(errors, []);
    await page.close();
  });

  it('with the tour placed before speaking, the composer waits for the tour', async () => {
    const { page, errors } = await open('fresh=1&speed=12&variant=before');
    await jumpTo(page, 'one-ready', 'chat');
    await page.waitForSelector('#tourNext');
    assert.equal(await page.isDisabled('#input'), true);
    await page.click('#tourNext');
    await page.click('#tourNext');
    await page.waitForFunction(() => !document.getElementById('input').disabled);
    assert.equal((await stateOf(page)).tourDone, true);
    assert.deepEqual(errors, []);
    await page.close();
  });

  it('pausing freezes the script', async () => {
    const { page } = await open('fresh=1&speed=2');
    await page.waitForSelector('#stageCopy.shown', { timeout: 60000 });
    await page.click('#startBtn');
    await page.waitForSelector('#messages .msg');
    await page.keyboard.press('Space');
    const count = await page.$$eval('#messages .msg', (r) => r.length);
    const typed = await page.$$eval('#messages .bubble', (b) => b.map((x) => x.textContent).join('|'));
    await page.waitForTimeout(1500);
    assert.equal(await page.$$eval('#messages .msg', (r) => r.length), count);
    assert.equal(await page.$$eval('#messages .bubble', (b) => b.map((x) => x.textContent).join('|')), typed);
    await page.close();
  });
});
