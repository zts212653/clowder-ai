import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { chromium } from 'playwright';
import { expressionFixture } from './f290-expression.fixture.mjs';
import { expressionHostFixture } from './f290-expression-voice.fixture.mjs';

const evidenceDirectory = process.env.F290_WORLD_IDENTITY_EVIDENCE_DIR;

async function capture(page, name) {
  if (!evidenceDirectory) return;
  await mkdir(evidenceDirectory, { recursive: true });
  await page.screenshot({ path: join(evidenceDirectory, `${name}.png`), fullPage: true });
}

async function dismissFirstEntry(frame) {
  const browse = frame.getByRole('button', { name: /先逛逛|Browse first/u });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (!(await browse.isVisible())) return;
    try {
      await browse.press('Enter', { timeout: 2_000 });
      return;
    } catch (error) {
      if (!(await browse.isVisible())) return;
      if (attempt === 1) throw error;
    }
  }
}

async function openGeneral(frame) {
  await dismissFirstEntry(frame);
  const textarea = frame.locator('.composer textarea');
  if (!(await textarea.isVisible())) {
    const general = frame.getByRole('button', { name: /general/u });
    await general.focus();
    await general.press('Enter');
  }
  await frame.locator('.composer[data-draft-ready="true"]').waitFor();
  return textarea;
}

async function restoredChannelComposer(frame) {
  const composer = frame.locator('.composer[data-draft-ready="true"]');
  await composer.waitFor();
  return composer.locator('textarea');
}

async function waitForCurrentWorld(frame, name) {
  await frame.getByRole('heading', { name, exact: true }).first().waitFor();
}

async function saveDraft(page, textarea, value) {
  const saved = page.waitForResponse(
    (response) => response.url().endsWith('/api/channel-state/draft') && response.status() === 200,
  );
  await textarea.fill(value);
  await saved;
}

function connectorConnection(fixture, humanId, collectiveId, suffix) {
  return {
    serviceUrl: fixture.url,
    serviceInstanceId: fixture.store.serviceInstanceId,
    collectiveId,
    connectionId: `con_${suffix}`,
    authorizedHumanId: humanId,
    endpointId: `ep_${suffix}`,
    endpointLabel: `测试 Café ${suffix}`,
    authorityStatus: 'connected',
    liveStatus: 'online',
    lastAckedSequence: 0,
    outbox: { queued: 0, accepted: 0 },
    route: { configured: true, revision: 1 },
    inbox: { persisted: 0, pending: 0, routed: 0, failed: 0 },
  };
}

test(
  'the real Host keeps the current Human explicit across identity details, account switching and narrow layout',
  { timeout: 120_000 },
  async (t) => {
    const host = await expressionHostFixture({ appearanceControls: true });
    const fixture = await expressionFixture({ allowedHostOrigins: [host.url] });
    host.setService(fixture.url);
    const pairing = await fixture.store.createPairingIntent({
      sessionToken: fixture.creator.sessionToken,
      collectiveId: fixture.coordinates.collectiveId,
      hostOrigin: host.url,
      nonce: 'world-identity-owner-cafe',
    });
    const connection = await fixture.store.exchangePairingIntent({
      ...pairing,
      endpointLabel: '测试成员 A 的 Café',
    });
    await fixture.store.publishParticipation(connection.endpointCredential, {
      ...fixture.coordinates,
      connectionId: connection.connectionId,
      revision: 1,
      agents: [
        {
          catId: 'codex-sol',
          displayName: '小太阳·砚砚',
          description: '小太阳型攻坚猫',
          channelIds: ['general'],
        },
      ],
    });

    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    t.after(async () => {
      await context.close();
      await browser.close();
      await fixture.close();
      await host.close();
    });
    const errors = [];
    await context.addInitScript(
      ({ serviceOrigin, hostOrigin, token }) => {
        if (location.origin === hostOrigin) localStorage.setItem('cat-cafe:shell-presentation', 'v2');
        if (location.origin === serviceOrigin) {
          const key = `collective-session:${serviceOrigin}`;
          if (!sessionStorage.getItem(key)) sessionStorage.setItem(key, token);
        }
      },
      { serviceOrigin: fixture.url, hostOrigin: host.url, token: fixture.creator.sessionToken },
    );
    const page = await context.newPage();
    page.setDefaultTimeout(15_000);
    page.on('pageerror', (error) => errors.push(error.message));
    await page.route('**/*', (route) => {
      assert.ok(!['3001', '3002', '6399'].includes(new URL(route.request().url()).port));
      return route.continue();
    });
    await page.goto(`${host.url}/collective`, { waitUntil: 'networkidle' });
    const frame = page.frameLocator('iframe[title="Collective"]');
    await dismissFirstEntry(frame);

    const identity = frame.locator('summary[aria-label="当前身份：测试成员 A"]');
    await identity.waitFor();
    assert.match(await identity.innerText(), /测试成员 A/u);
    await identity.click();
    const card = frame.locator('.collective-identity-card');
    await card.waitFor();
    assert.match(await card.innerText(), /你在频道表达测试里是测试成员 A/u);
    assert.match(await card.innerText(), /用 GitHub 账号 @测试成员 A 登录/u);
    assert.match(await card.innerText(), /你的猫在这里/u);
    assert.match(await card.innerText(), /小太阳·砚砚/u);
    const geometry = await frame.locator('.collective-identity').evaluate((element) => {
      const summaryAvatar = element.querySelector('summary .avatar').getBoundingClientRect();
      const card = element.querySelector('.collective-identity-card').getBoundingClientRect();
      const cardAvatar = element.querySelector('.collective-identity-who .avatar').getBoundingClientRect();
      const pane = element.closest('.destination-pane').getBoundingClientRect();
      return {
        summaryAvatar: [summaryAvatar.width, summaryAvatar.height],
        cardWidth: card.width,
        cardLeft: card.left,
        cardRight: card.right,
        cardTop: card.top,
        cardBottom: card.bottom,
        paneLeft: pane.left,
        paneRight: pane.right,
        paneTop: pane.top,
        paneBottom: pane.bottom,
        cardAvatar: [cardAvatar.width, cardAvatar.height],
      };
    });
    assert.deepEqual(geometry.summaryAvatar, [16, 16]);
    assert.ok(geometry.cardWidth >= 250);
    assert.ok(geometry.cardLeft >= geometry.paneLeft + 4);
    assert.ok(geometry.cardRight <= geometry.paneRight - 4);
    assert.ok(geometry.cardTop >= geometry.paneTop, JSON.stringify(geometry));
    assert.ok(geometry.cardBottom <= geometry.paneBottom - 4, JSON.stringify(geometry));
    assert.deepEqual(geometry.cardAvatar, [28, 28]);
    await capture(page, 'identity-light-1440');

    await identity.press('Enter');
    await identity.press('Enter');
    await frame.getByRole('button', { name: '看我的成员资料', exact: true }).focus();
    await frame.getByRole('button', { name: '看我的成员资料', exact: true }).press('Enter');
    const profile = frame.getByRole('complementary', { name: '成员资料', exact: true });
    await profile.waitFor();
    await card.waitFor({ state: 'hidden' });
    assert.equal(await profile.getByRole('heading', { name: '测试成员 A', exact: true }).count(), 1);
    await profile.getByRole('button', { name: '关闭成员资料', exact: true }).click();

    const textarea = await openGeneral(frame);
    assert.equal(await textarea.getAttribute('placeholder'), '发到 # general · 频道表达测试的成员都看得到');
    await saveDraft(page, textarea, 'A 的私人草稿');

    await page.getByRole('button', { name: 'English', exact: true }).click();
    await frame.locator('html[lang="en"]').waitFor();
    const englishIdentity = frame.locator('summary[aria-label="Current identity: 测试成员 A"]');
    await englishIdentity.click();
    assert.match(await card.innerText(), /You are 测试成员 A in 频道表达测试/u);
    assert.match(await card.innerText(), /Signed in with GitHub as @测试成员 A/u);
    await englishIdentity.click();
    await page.getByRole('button', { name: '中文', exact: true }).click();
    await frame.locator('html[lang="zh-CN"]').waitFor();
    await page.getByRole('button', { name: 'Dark', exact: true }).click();
    await frame.locator('html[data-theme="dark"]').waitFor();
    await frame.locator('summary[aria-label="当前身份：测试成员 A"]').click();
    await capture(page, 'identity-dark-1440');
    await frame.locator('summary[aria-label="当前身份：测试成员 A"]').click();

    await page.setViewportSize({ width: 390, height: 844 });
    await frame.getByRole('button', { name: '频道导航', exact: true }).click();
    const narrowIdentity = frame.locator('summary[aria-label="当前身份：测试成员 A"]');
    await narrowIdentity.focus();
    await narrowIdentity.press('Enter');
    const narrow = await frame.locator('.collective-identity-card').evaluate((element) => {
      const bounds = element.getBoundingClientRect();
      return {
        left: bounds.left,
        right: bounds.right,
        viewport: innerWidth,
        scrollWidth: document.documentElement.scrollWidth,
      };
    });
    assert.ok(narrow.left >= 0 && narrow.right <= narrow.viewport);
    assert.ok(narrow.scrollWidth <= narrow.viewport + 1);
    await capture(page, 'identity-dark-390');

    await page.setViewportSize({ width: 1440, height: 1000 });
    const currentFrame = page.frames().find((candidate) => candidate.url().startsWith(fixture.url));
    assert.ok(currentFrame);
    const clientUrl = currentFrame.url();
    await frame.getByRole('button', { name: '换账号…', exact: true }).click();
    await frame.getByRole('heading', { name: '登录共同体', exact: true }).waitFor();
    assert.equal(
      await currentFrame.evaluate((origin) => sessionStorage.getItem(`collective-session:${origin}`), fixture.url),
      null,
    );
    assert.equal(currentFrame.url(), clientUrl, 'switching Human must preserve the current Service/world URL');

    await currentFrame.evaluate(({ origin, token }) => sessionStorage.setItem(`collective-session:${origin}`, token), {
      origin: fixture.url,
      token: fixture.member.sessionToken,
    });
    await page.reload({ waitUntil: 'networkidle' });
    await dismissFirstEntry(frame);
    await frame.locator('summary[aria-label="当前身份：测试成员 B"]').click();
    assert.match(await card.innerText(), /当前没有登记到这里的猫/u);
    await frame.locator('summary[aria-label="当前身份：测试成员 B"]').click();
    const memberDraft = await openGeneral(frame);
    assert.equal(await memberDraft.inputValue(), '', 'the second Human must not inherit the first Human draft');
    await saveDraft(page, memberDraft, 'B 的私人草稿');

    const memberFrame = page.frames().find((candidate) => candidate.url().startsWith(fixture.url));
    assert.ok(memberFrame);
    await memberFrame.evaluate(({ origin, token }) => sessionStorage.setItem(`collective-session:${origin}`, token), {
      origin: fixture.url,
      token: fixture.creator.sessionToken,
    });
    await page.reload({ waitUntil: 'networkidle' });
    await dismissFirstEntry(frame);
    await frame.locator('summary[aria-label="当前身份：测试成员 A"]').waitFor();
    const restoredDraft = await openGeneral(frame);
    assert.equal(await restoredDraft.inputValue(), 'A 的私人草稿');
    assert.deepEqual(errors, []);
  },
);

test(
  'one Host history entry owns each world while refresh recovery remains Human-bound and retryable',
  { timeout: 120_000 },
  async (t) => {
    const host = await expressionHostFixture({ worldRail: true });
    const fixture = await expressionFixture({ allowedHostOrigins: [host.url] });
    const worldB = await fixture.store.createCollective({
      sessionToken: fixture.creator.sessionToken,
      name: '频道表达测试乙',
    });
    const me = await fixture.store.getHumanProjection(fixture.creator.sessionToken);
    host.setService(fixture.url, {
      serviceInstanceId: fixture.store.serviceInstanceId,
      connections: [
        connectorConnection(fixture, me.human.humanId, fixture.coordinates.collectiveId, 'world_a'),
        connectorConnection(fixture, me.human.humanId, worldB.collectiveId, 'world_b'),
      ],
    });

    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    t.after(async () => {
      await context.close();
      await browser.close();
      await fixture.close();
      await host.close();
    });
    await context.addInitScript(
      ({ serviceOrigin, hostOrigin, token }) => {
        if (location.origin === hostOrigin) localStorage.setItem('cat-cafe:shell-presentation', 'v2');
        if (location.origin === serviceOrigin) {
          sessionStorage.setItem(`collective-session:${serviceOrigin}`, token);
        }
      },
      { serviceOrigin: fixture.url, hostOrigin: host.url, token: fixture.creator.sessionToken },
    );
    const page = await context.newPage();
    page.setDefaultTimeout(15_000);
    const pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    await page.route('**/*', (route) => {
      assert.ok(!['3001', '3002', '6399'].includes(new URL(route.request().url()).port));
      return route.continue();
    });
    await page.goto(`${host.url}/collective`, { waitUntil: 'networkidle' });
    const frame = page.frameLocator('iframe[title="Collective"]');
    const rail = page.getByRole('navigation', { name: 'Fixture world rail' });
    const worldAName = '频道表达测试';
    await rail.getByRole('button', { name: worldAName, exact: true }).waitFor();
    await rail.getByRole('button', { name: worldB.name, exact: true }).waitFor();
    const initialHistoryLength = await page.evaluate(() => history.length);

    await rail.getByRole('button', { name: worldAName, exact: true }).click();
    await page.waitForURL((url) => url.searchParams.get('collectiveId') === fixture.coordinates.collectiveId);
    await waitForCurrentWorld(frame, worldAName);
    await frame.locator('[data-testid="collective-home"]').waitFor();
    assert.equal(await page.evaluate(() => history.length), initialHistoryLength + 1);

    await rail.getByRole('button', { name: worldB.name, exact: true }).click();
    await page.waitForURL((url) => url.searchParams.get('collectiveId') === worldB.collectiveId);
    await waitForCurrentWorld(frame, worldB.name);
    await frame.locator('[data-testid="collective-home"]').waitFor();
    assert.equal(await page.evaluate(() => history.length), initialHistoryLength + 2);

    await rail.getByRole('button', { name: worldAName, exact: true }).click();
    await page.waitForURL((url) => url.searchParams.get('collectiveId') === fixture.coordinates.collectiveId);
    await waitForCurrentWorld(frame, worldAName);
    await capture(page, 'continuity-a-return-before-channel');
    await frame.locator('[data-testid="collective-home"]').waitFor();
    assert.equal(await page.evaluate(() => history.length), initialHistoryLength + 3);

    await openGeneral(frame);

    await rail.getByRole('button', { name: worldB.name, exact: true }).click();
    await page.waitForURL((url) => url.searchParams.get('collectiveId') === worldB.collectiveId);
    await waitForCurrentWorld(frame, worldB.name);
    await openGeneral(frame);
    assert.equal(await page.evaluate(() => history.length), initialHistoryLength + 4);

    await rail.getByRole('button', { name: worldAName, exact: true }).click();
    await page.waitForURL((url) => url.searchParams.get('collectiveId') === fixture.coordinates.collectiveId);
    await waitForCurrentWorld(frame, worldAName);
    assert.equal(
      await (await restoredChannelComposer(frame)).getAttribute('placeholder'),
      '发到 # general · 频道表达测试的成员都看得到',
    );
    assert.equal(await page.evaluate(() => history.length), initialHistoryLength + 5);

    await page.goBack({ waitUntil: 'commit' });
    await page.waitForURL((url) => url.searchParams.get('collectiveId') === worldB.collectiveId);
    await waitForCurrentWorld(frame, worldB.name);
    assert.equal(
      await (await restoredChannelComposer(frame)).getAttribute('placeholder'),
      '发到 # general · 频道表达测试乙的成员都看得到',
    );

    await page.goForward({ waitUntil: 'commit' });
    await page.waitForURL((url) => url.searchParams.get('collectiveId') === fixture.coordinates.collectiveId);
    await waitForCurrentWorld(frame, worldAName);
    assert.equal(
      await (await restoredChannelComposer(frame)).getAttribute('placeholder'),
      '发到 # general · 频道表达测试的成员都看得到',
    );

    const serviceApiPattern = `${fixture.url}/api/**`;
    let blockedServiceRequests = 0;
    await page.route(serviceApiPattern, (route) => {
      blockedServiceRequests += 1;
      return route.abort('failed');
    });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await rail.getByRole('button', { name: worldAName, exact: true }).waitFor();
    await rail.getByRole('button', { name: worldB.name, exact: true }).waitFor();
    const unavailable = page.getByTestId('collective-world-unavailable');
    await unavailable.waitFor();
    assert.ok(blockedServiceRequests > 0, 'the declared Service failure must reach a real Client API request');
    const [surfaceBox, unavailableBox] = await Promise.all([
      page.getByTestId('collective-launch-surface').boundingBox(),
      unavailable.boundingBox(),
    ]);
    assert.ok(surfaceBox && unavailableBox, 'the unavailable surface must have visible geometry');
    assert.ok(
      Math.abs(unavailableBox.x - surfaceBox.x) < 1 &&
        Math.abs(unavailableBox.y - surfaceBox.y) < 1 &&
        Math.abs(unavailableBox.width - surfaceBox.width) < 1 &&
        Math.abs(unavailableBox.height - surfaceBox.height) < 1,
      'the unavailable surface must cover the Host room instead of rendering below its iframe',
    );
    await capture(page, 'continuity-unavailable');
    assert.match(await unavailable.innerText(), /暂时无法打开频道表达测试/u);
    assert.doesNotMatch(await unavailable.innerText(), /Failed to fetch/u);
    assert.doesNotMatch(await page.locator('body').innerText(), /Collective 客户端暂时不可用/u);

    await page.unroute(serviceApiPattern);
    await unavailable.getByRole('button', { name: '重试', exact: true }).click();
    await unavailable.waitFor({ state: 'hidden' });
    assert.equal(
      await (await openGeneral(frame)).getAttribute('placeholder'),
      '发到 # general · 频道表达测试的成员都看得到',
    );
    assert.deepEqual(pageErrors, []);
  },
);
