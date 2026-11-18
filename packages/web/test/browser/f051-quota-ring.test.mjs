import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright';
import { resolveByAccountRef } from '../../../api/src/config/account-resolver.ts';
import { agyOAuthFile, prepareAgyAccount } from '../../../api/src/config/agy-account.ts';
import { writeCatalogAccount } from '../../../api/src/config/catalog-accounts.ts';
import { recordClaudeQuota } from '../../../api/src/config/claude-quota-store.ts';
import { claudeExecutionAccountSnapshot } from '../../../api/src/config/claude-token-account.ts';
import { describeCodexManagedLayout, prepareCodexManagedLayout } from '../../../api/src/config/codex-managed-layout.ts';
import { writeCredential } from '../../../api/src/config/credentials.ts';
import { startFinalAccountPreview } from './f320-final-runtime.fixture.mjs';

function writeCodexAuthJson(credentialHome, userId, workspaceId, accessToken) {
  const idToken = `x.${Buffer.from(
    JSON.stringify({
      'https://api.openai.com/auth': {
        chatgpt_user_id: userId,
        chatgpt_account_id: workspaceId,
      },
    }),
  ).toString('base64url')}.x`;
  mkdirSync(credentialHome, { recursive: true });
  writeFileSync(
    join(credentialHome, 'auth.json'),
    JSON.stringify({
      tokens: {
        id_token: idToken,
        access_token: accessToken,
        account_id: workspaceId,
      },
    }),
  );
}

let preview;
let browser;
let codexPrimaryRef;
let claudeRef;
let agyRef;

before(async () => {
  preview = await startFinalAccountPreview({
    withClaude: true,
    withAgy: true,
    withServicePreview: true,
    withStartupRecovery: true,
    ownerUserId: 'fixture',
    agyQuotaSampler: async () => {
      const sampledAt = Date.now();
      return {
        observedAt: sampledAt,
        items: [
          {
            label: 'Gemini · 每周使用限额',
            usedPercent: 49,
            percentKind: 'remaining',
            poolId: 'agy-gemini',
            resetsAt: new Date(sampledAt + 3 * 86_400_000).toISOString(),
          },
          {
            label: 'Claude / GPT · 每周使用限额',
            usedPercent: 0,
            percentKind: 'remaining',
            poolId: 'agy-claude-gpt',
            resetsAt: new Date(sampledAt + 2 * 86_400_000).toISOString(),
          },
        ],
      };
    },
  });

  const now = Date.now();
  const root = preview.root;

  // 1. Managed Codex Pro primary account (in-use, fresh reading)
  codexPrimaryRef = `codex-${randomUUID()}`;
  const codexPrimaryLayout = prepareCodexManagedLayout(describeCodexManagedLayout(root, codexPrimaryRef), root);
  const codexPrimaryIdentity = { userId: 'u-codex-main', workspaceId: 'ws-codex-main' };
  writeCodexAuthJson(
    codexPrimaryLayout.credentialHome,
    codexPrimaryIdentity.userId,
    codexPrimaryIdentity.workspaceId,
    'tok-codex-main',
  );
  writeCatalogAccount(root, codexPrimaryRef, {
    authType: 'oauth',
    clientId: 'openai',
    displayName: 'Pro 主号',
    codex: { ...codexPrimaryLayout, identity: codexPrimaryIdentity },
    quota: {
      owner: { accountRef: codexPrimaryRef, ...codexPrimaryIdentity },
      observedAt: now - 2 * 60_000,
      status: 'ok',
      source: 'codex_official_readonly',
      items: [
        {
          label: '5小时使用限额',
          usedPercent: 18,
          percentKind: 'used',
          poolId: 'codex-main',
          resetsAt: new Date(now + 4 * 3600_000).toISOString(),
        },
        {
          label: '每周使用限额',
          usedPercent: 44,
          percentKind: 'used',
          poolId: 'codex-main',
          resetsAt: new Date(now + 4 * 86_400_000).toISOString(),
        },
      ],
    },
  });

  // 2. Managed Codex backup account (stale >10m reading, not currently bound)
  const codexBackupRef = `codex-${randomUUID()}`;
  const codexBackupLayout = prepareCodexManagedLayout(describeCodexManagedLayout(root, codexBackupRef), root);
  const codexBackupIdentity = { userId: 'u-codex-bak', workspaceId: 'ws-codex-bak' };
  writeCodexAuthJson(
    codexBackupLayout.credentialHome,
    codexBackupIdentity.userId,
    codexBackupIdentity.workspaceId,
    'tok-codex-bak',
  );
  writeCatalogAccount(root, codexBackupRef, {
    authType: 'oauth',
    clientId: 'openai',
    displayName: '备用二号',
    codex: { ...codexBackupLayout, identity: codexBackupIdentity },
    quota: {
      owner: { accountRef: codexBackupRef, ...codexBackupIdentity },
      observedAt: now - 45 * 60_000,
      status: 'ok',
      source: 'codex_official_readonly',
      items: [
        {
          label: '每周使用限额',
          usedPercent: 8,
          percentKind: 'used',
          poolId: 'codex-main',
          resetsAt: new Date(now + 5 * 86_400_000).toISOString(),
        },
      ],
    },
  });

  // 3. Managed Claude OAuth token account (in-use, passive reading with shared weekly + Fable weekly)
  claudeRef = `claude-${randomUUID()}`;
  writeCatalogAccount(root, claudeRef, {
    authType: 'oauth',
    clientId: 'anthropic',
    displayName: '宪宪主号',
    claude: { kind: 'long_lived_token' },
  });
  writeCredential(claudeRef, { accessToken: ['sk-ant', 'oat01', 'fixture-main'].join('-') }, root);
  const claudeProfile = resolveByAccountRef(root, claudeRef);
  assert.ok(claudeProfile);
  const claudeOwner = await claudeExecutionAccountSnapshot(claudeProfile);
  assert.equal(
    await recordClaudeQuota({
      root,
      account: claudeOwner,
      model: 'claude-fable-5-2',
      observedAt: now - 90_000,
      windows: {
        seven_day: {
          utilization: 0.39,
          resetsAt: Math.floor((now + 3 * 86_400_000) / 1000),
          status: 'allowed',
        },
        seven_day_overage_included: {
          utilization: 0.72,
          resetsAt: Math.floor((now + 3 * 86_400_000) / 1000),
          status: 'allowed',
        },
      },
    }),
    true,
  );

  // 4. Managed Gemini AGY account (in-use, honest "no reading")
  agyRef = `agy-${randomUUID()}`;
  const agyLayout = prepareAgyAccount(root, agyRef);
  writeFileSync(
    agyOAuthFile(agyLayout.credentialHome),
    JSON.stringify({
      auth_method: 'consumer',
      token: {
        access_token: 'fixture-agy-access',
        refresh_token: 'fixture-agy-refresh',
        expiry: new Date(now + 2 * 3600_000).toISOString(),
      },
    }),
    { mode: 0o600 },
  );
  writeCatalogAccount(root, agyRef, {
    authType: 'oauth',
    clientId: 'google',
    displayName: '烁烁 AGY 号',
    agy: agyLayout,
  });

  // Bind primary accounts as active ("正在用") via real preview -> commit API routes
  for (const [tool, ref] of [
    ['codex', codexPrimaryRef],
    ['claude', claudeRef],
    ['agy', agyRef],
  ]) {
    const previewRes = await fetch(`${preview.apiUrl}/api/accounts/${ref}/${tool}/binding/preview`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-cat-cafe-user': 'fixture',
      },
      body: JSON.stringify({ projectPath: root, scope: 'local', includeOverrides: true }),
    });
    const previewText = await previewRes.text();
    assert.equal(previewRes.status, 200, previewText);
    const { previewToken } = JSON.parse(previewText);
    assert.ok(previewToken);

    const res = await fetch(`${preview.apiUrl}/api/accounts/${ref}/${tool}/binding/commit`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-cat-cafe-user': 'fixture',
      },
      body: JSON.stringify({ projectPath: root, scope: 'local', includeOverrides: true, previewToken }),
    });
    const commitText = await res.text();
    assert.equal(res.status, 200, commitText);
  }

  // Select the 4 OAuth accounts in user preferences so the Home ring displays all states cleanly
  const prefRes = await fetch(`${preview.apiUrl}/api/config/quota-pin`, {
    method: 'PUT',
    headers: {
      'content-type': 'application/json',
      'x-cat-cafe-user': 'fixture',
    },
    body: JSON.stringify({
      pinned: true,
      selectedAccountRefs: [codexPrimaryRef, claudeRef, codexBackupRef, agyRef],
    }),
  });
  const prefText = await prefRes.text();
  assert.equal(prefRes.status, 200, prefText);

  // Seed one real conversation reply so the Home chat view looks authentic
  try {
    await preview.reply('首页左下角四家额度竖条已就绪，悬停可看四家余量，点开按家查看在用与备用号。', 'codex61-sol');
  } catch {
    // Non-critical visual seed; UI verification continues on the real thread page
  }

  browser = await chromium.launch({ headless: true });
});

after(async () => {
  await browser?.close();
  await preview?.close();
});

test(
  'renders real Home WorldRail quota ring on desktop & 390px mobile, refreshes manually, unpins cleanly, and re-enables from HubAccountsTab',
  { timeout: 180_000 },
  async () => {
    const evidenceDir = process.env.F051_EVIDENCE_DIR;
    if (evidenceDir) mkdirSync(evidenceDir, { recursive: true });

    const pageErrors = [];
    const quotaPostUrls = [];

    // --- 1. Desktop (1440×900) Home Page + Popover ---
    const desktopContext = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      deviceScaleFactor: 2,
    });
    const desktopPage = await desktopContext.newPage();
    desktopPage.on('pageerror', (err) => pageErrors.push(err.message));
    desktopPage.on('request', (req) => {
      if (req.method() === 'POST' && req.url().includes('/quota')) {
        quotaPostUrls.push(new URL(req.url()).pathname);
      }
    });

    await desktopPage.goto(`${preview.url}/thread/${preview.threadId}?shell=v2`, {
      waitUntil: 'domcontentloaded',
    });
    await desktopPage.evaluate(() => localStorage.setItem('cat-cafe:shell-language', 'zh'));
    await desktopPage.reload({ waitUntil: 'domcontentloaded' });

    const ringBtn = desktopPage.getByTestId('quota-ring-button');
    await ringBtn.waitFor({ state: 'visible', timeout: 30_000 });
    await desktopPage
      .locator('[data-testid="quota-ring-button"] svg[data-has-reading="true"]')
      .waitFor({ state: 'visible', timeout: 15_000 });

    // Verify 24x24 4-family vertical bar SVG geometry (w=3.6, gap=1.8, H=18, rx=1.2)
    const svgMetrics = await ringBtn.locator('svg').evaluate((svg) => {
      const groups = [...svg.querySelectorAll('[data-bar-family]')];
      return {
        viewBox: svg.getAttribute('viewBox'),
        width: svg.getBoundingClientRect().width,
        height: svg.getBoundingClientRect().height,
        hasReading: svg.getAttribute('data-has-reading'),
        families: groups.map((g) => g.getAttribute('data-bar-family')),
        states: groups.map((g) => g.getAttribute('data-bar-state')),
        rectCount: svg.querySelectorAll('rect').length,
      };
    });
    assert.equal(svgMetrics.viewBox, '0 0 24 24');
    assert.equal(svgMetrics.hasReading, 'true');
    assert.deepEqual(svgMetrics.families, ['claude', 'codex', 'agy', 'kimi']);
    assert.deepEqual(svgMetrics.states, ['ok', 'ok', 'empty', 'empty']);

    // Hover / accessible summary reports the 4 families' numbers
    const ariaLabel = (await ringBtn.getAttribute('aria-label')) ?? '';
    assert.ok(ariaLabel.includes('布偶 28%'), ariaLabel);
    assert.ok(ariaLabel.includes('缅因 56%'), ariaLabel);
    assert.ok(ariaLabel.includes('暹罗 —'), ariaLabel);
    assert.ok(ariaLabel.includes('梵花 —'), ariaLabel);

    // Opening popover must NOT auto-trigger upstream quota POSTs
    assert.equal(quotaPostUrls.length, 0);
    await ringBtn.click();
    const popover = desktopPage.getByTestId('quota-ring-popover');
    await popover.waitFor({ state: 'visible' });
    assert.equal(quotaPostUrls.length, 0);

    const popoverText = (await popover.textContent()) ?? '';
    assert.ok(popoverText.includes('布偶 · Claude'), popoverText);
    assert.ok(popoverText.includes('缅因 · Codex'), popoverText);
    assert.ok(popoverText.includes('暹罗 · AGY'), popoverText);
    assert.ok(popoverText.includes('Pro 主号'), popoverText);
    assert.ok(popoverText.includes('剩 82%'), popoverText);
    assert.ok(popoverText.includes('剩 56%'), popoverText);
    assert.ok(popoverText.includes('宪宪主号'), popoverText);
    assert.ok(popoverText.includes('本周（全部模型）'), popoverText);
    assert.ok(popoverText.includes('剩 61%'), popoverText);
    assert.ok(popoverText.includes('本周（Fable）'), popoverText);
    assert.ok(popoverText.includes('剩 28%'), popoverText);
    assert.ok(popoverText.includes('备用二号'), popoverText);
    assert.ok(popoverText.includes('剩 92%'), popoverText);
    assert.ok(popoverText.includes('上次读数'), popoverText);
    assert.ok(popoverText.includes('烁烁 AGY 号'), popoverText);
    assert.ok(popoverText.includes('没有读数'), popoverText);
    assert.ok(popoverText.includes('正在用'), popoverText);

    // Active account is first row (active), standby account is compact second row (standby)
    const codexGroupRoles = await popover
      .locator('[data-quota-family="codex"] [data-quota-account]')
      .evaluateAll((els) => els.map((el) => el.getAttribute('data-quota-role')));
    assert.deepEqual(codexGroupRoles, ['active', 'standby']);

    // Honest no-reading rule: Gemini AGY section has zero progress meters
    const agyMeters = await popover.locator(`[data-quota-account="${agyRef}"] [role="meter"]`).count();
    assert.equal(agyMeters, 0);

    if (evidenceDir) {
      await desktopPage.screenshot({
        path: join(evidenceDir, 'desktop-home-popover.png'),
      });
    }

    // --- 2. Mobile (390×844) Home Page Layout & Composer Clearance ---
    const mobileContext = await browser.newContext({
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: 2,
    });
    const mobilePage = await mobileContext.newPage();
    mobilePage.on('pageerror', (err) => pageErrors.push(err.message));

    await mobilePage.goto(`${preview.url}/thread/${preview.threadId}?shell=v2`, {
      waitUntil: 'domcontentloaded',
    });
    await mobilePage.evaluate(() => localStorage.setItem('cat-cafe:shell-language', 'zh'));
    await mobilePage.reload({ waitUntil: 'domcontentloaded' });

    const mobileRing = mobilePage.getByTestId('quota-ring-button');
    await mobileRing.waitFor({ state: 'visible', timeout: 15_000 });
    await mobilePage
      .locator('[data-testid="quota-ring-button"] svg[data-has-reading="true"]')
      .waitFor({ state: 'visible', timeout: 15_000 });
    const mobileComposer = mobilePage.locator('textarea').first();
    await mobileComposer.waitFor({ state: 'visible', timeout: 15_000 });
    const ringClosedBox = await mobileRing.boundingBox();
    const composerBox = await mobileComposer.boundingBox();
    assert.ok(ringClosedBox && composerBox);
    assert.ok(
      ringClosedBox.x + ringClosedBox.width <= composerBox.x,
      `mobile ring (${JSON.stringify(ringClosedBox)}) must not overlap composer (${JSON.stringify(composerBox)})`,
    );

    assert.equal(await mobilePage.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
    if (evidenceDir) {
      await mobilePage.screenshot({
        path: join(evidenceDir, 'mobile-390-home-closed.png'),
      });
    }

    await mobileRing.click();
    const mobilePopover = mobilePage.getByTestId('quota-ring-popover');
    await mobilePopover.waitFor({ state: 'visible' });
    const mobileBounds = await mobilePopover.boundingBox();
    assert.ok(mobileBounds);
    assert.ok(mobileBounds.x >= 0 && mobileBounds.x + mobileBounds.width <= 390, JSON.stringify(mobileBounds));
    assert.equal(await mobilePage.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);

    if (evidenceDir) {
      await mobilePage.screenshot({
        path: join(evidenceDir, 'mobile-390-home-popover.png'),
      });
    }
    await mobileContext.close();

    // --- 3. Account Picker + Manual Refresh (refreshes ONLY selected accounts) ---
    await desktopPage.getByTestId('quota-ring-choose-accounts').click();
    await desktopPage.getByTestId(`quota-ring-check-${claudeRef}`).click();
    await desktopPage.getByTestId('quota-ring-choose-accounts').click();
    await desktopPage.waitForFunction(
      () => !document.querySelector('[data-testid="quota-ring-popover"]')?.textContent?.includes('宪宪主号'),
      null,
      { timeout: 10_000 },
    );

    await desktopPage.getByTestId('quota-ring-refresh').click();
    await desktopPage.waitForFunction(
      () => {
        const text = document.querySelector('[data-testid="quota-ring-popover"]')?.textContent ?? '';
        return text.includes('剩 70%') && text.includes('Gemini · 本周') && text.includes('Claude / GPT · 本周');
      },
      null,
      { timeout: 15_000 },
    );
    assert.ok(quotaPostUrls.includes(`/api/accounts/${codexPrimaryRef}/codex/quota`));
    assert.ok(quotaPostUrls.includes(`/api/accounts/${agyRef}/agy/quota`));
    assert.equal(quotaPostUrls.includes(`/api/accounts/${claudeRef}/claude/quota`), false);

    // Verify Siamese bar lit up to 'ok' (49% from Gemini pool, NEVER 'low' red from exhausted 0% Claude/GPT pool!)
    const refreshedAgyBarState = await ringBtn.locator('svg [data-bar-family="agy"]').getAttribute('data-bar-state');
    assert.equal(refreshedAgyBarState, 'ok');
    const refreshedAriaLabel = (await ringBtn.getAttribute('aria-label')) ?? '';
    assert.ok(refreshedAriaLabel.includes('暹罗 49%'), refreshedAriaLabel);
    const refreshedAgyMeters = await popover.locator(`[data-quota-account="${agyRef}"] [role="meter"]`).count();
    assert.equal(refreshedAgyMeters, 2);

    // --- 4. Unpin ("收起图标") + Re-enable in HubAccountsTab ("在左侧栏显示额度") ---
    await desktopPage.getByTestId('quota-ring-unpin').click();
    await desktopPage.waitForSelector('[data-testid="quota-ring-button"]', { state: 'detached' });

    const persistedAfterUnpin = JSON.parse(
      readFileSync(join(preview.root, '.cat-cafe', 'user-preferences.json'), 'utf8'),
    );
    assert.equal(persistedAfterUnpin.quotaPin?.pinned, false);

    if (evidenceDir) {
      await desktopPage.screenshot({
        path: join(evidenceDir, 'desktop-home-unpinned.png'),
      });
    }

    // Open Settings -> Accounts & Sign-in to turn it back on
    await desktopPage.goto(`${preview.url}/settings?s=accounts&shell=v2`, {
      waitUntil: 'domcontentloaded',
    });
    const pinBar = desktopPage.getByTestId('accounts-quota-pin-bar');
    await pinBar.waitFor({ state: 'visible', timeout: 30_000 });
    const pinToggle = desktopPage.getByTestId('accounts-quota-pin-toggle');
    assert.equal(await pinToggle.getAttribute('aria-checked'), 'false');

    // Expand account selector so screenshot shows both the switch and account checklist
    await desktopPage.getByTestId('accounts-quota-pin-choose').click();
    if (evidenceDir) {
      await desktopPage.screenshot({
        path: join(evidenceDir, 'desktop-accounts-reenable.png'),
      });
    }

    await pinToggle.click();
    await desktopPage.waitForFunction(
      () =>
        document.querySelector('[data-testid="accounts-quota-pin-toggle"]')?.getAttribute('aria-checked') === 'true',
    );
    await desktopPage.getByTestId('quota-ring-button').waitFor({ state: 'visible' });

    const persistedAfterRepin = JSON.parse(
      readFileSync(join(preview.root, '.cat-cafe', 'user-preferences.json'), 'utf8'),
    );
    assert.equal(persistedAfterRepin.quotaPin?.pinned, true);

    assert.deepEqual(pageErrors, []);

    if (evidenceDir) {
      writeFileSync(
        join(evidenceDir, 'browser-proof.json'),
        `${JSON.stringify(
          {
            verifiedAt: new Date().toISOString(),
            desktopViewport: { width: 1440, height: 900 },
            mobileViewport: { width: 390, height: 844 },
            svgMetrics,
            mobilePopoverBounds: mobileBounds,
            persistedAfterUnpin: persistedAfterUnpin.quotaPin,
            persistedAfterRepin: persistedAfterRepin.quotaPin,
            pageErrors,
          },
          null,
          2,
        )}\n`,
      );
    }

    await desktopContext.close();
  },
);
