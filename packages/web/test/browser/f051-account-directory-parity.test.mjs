import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { catRegistry } from '@cat-cafe/shared';
import { chromium } from 'playwright';
import { resolveAgyQuotaExecutionOwner } from '../../../api/src/config/agy-quota-identity.ts';
import { recordAgyQuota } from '../../../api/src/config/agy-quota-store.ts';
import { toAllCatConfigs } from '../../../api/src/config/cat-config-loader.ts';
import { writeCatalogAccount } from '../../../api/src/config/catalog-accounts.ts';
import { resolveKimiQuotaExecutionOwner } from '../../../api/src/config/kimi-quota-identity.ts';
import { recordKimiQuota } from '../../../api/src/config/kimi-quota-store.ts';
import { readRuntimeCatCatalog } from '../../../api/src/config/runtime-cat-catalog.ts';
import { startFinalAccountPreview } from './f320-final-runtime.fixture.mjs';

let preview;
let browser;

const keychainIdentityInspector = async () => 'fixture-gemini-keychain-identity-v1';

before(async () => {
  preview = await startFinalAccountPreview({
    withClaude: true,
    withAgy: true,
    ownerUserId: 'fixture',
    agyKeychainIdentityInspector: keychainIdentityInspector,
    agyQuotaSampler: async () => {
      const sampledAt = Date.now();
      return {
        observedAt: sampledAt,
        items: [
          {
            label: 'Gemini · 每周使用限额',
            usedPercent: 28.4,
            percentKind: 'remaining',
            poolId: 'agy-gemini',
            resetsAt: new Date(sampledAt + 3 * 86_400_000).toISOString(),
          },
          {
            label: 'Claude / GPT · 每周使用限额',
            usedPercent: 91.2,
            percentKind: 'remaining',
            poolId: 'agy-claude-gpt',
            resetsAt: new Date(sampledAt + 2 * 86_400_000).toISOString(),
          },
        ],
      };
    },
    kimiQuotaSampler: async () => {
      const sampledAt = Date.now();
      return {
        observedAt: sampledAt,
        items: [
          {
            label: '5小时使用限额',
            usedPercent: 99,
            percentKind: 'used',
            poolId: 'kimi-rate-limit',
            resetsAt: new Date(sampledAt - 60_000).toISOString(),
          },
          {
            label: '每周使用限额',
            usedPercent: 10,
            percentKind: 'used',
            poolId: 'kimi-weekly',
            resetsAt: new Date(sampledAt + 3 * 86_400_000).toISOString(),
          },
        ],
      };
    },
  });

  const now = Date.now();
  const root = preview.root;

  // 1. Add Kimi ACP cat to runtime catalog so Kimi's "谁在用" column reflects active ACP cats
  const catalogPath = join(root, '.cat-cafe', 'cat-catalog.json');
  const catalog = JSON.parse(readFileSync(catalogPath, 'utf8'));
  catalog.breeds.push({
    id: 'turkish-van',
    catId: 'kimi31-pro',
    name: '梵花猫',
    displayName: '梵花猫',
    nickname: '墨墨',
    avatar: '/avatars/kimi.png',
    color: { primary: '#d97706', secondary: '#fcd34d' },
    mentionPatterns: ['@kimi31-pro'],
    roleDescription: 'fixture',
    defaultVariantId: 'kimi31-pro-default',
    variants: [
      {
        id: 'kimi31-pro-default',
        catId: 'kimi31-pro',
        carrier: 'acp',
        clientId: 'kimi',
        defaultModel: 'kimi-code/k3.1-pro',
        mcpSupport: true,
        accountRef: 'kimi-code-native',
        mentionPatterns: ['@kimi31-pro'],
        acp: { command: 'kimi', startupArgs: ['acp'] },
      },
    ],
  });
  catalog.roster['kimi31-pro'] = {
    family: 'turkish-van',
    roles: ['assistant'],
    lead: false,
    available: true,
    evaluation: 'fixture',
  };
  writeFileSync(catalogPath, JSON.stringify(catalog));
  writeFileSync(join(root, 'cat-template.json'), JSON.stringify(catalog));
  catRegistry.reset();
  for (const [id, config] of Object.entries(toAllCatConfigs(readRuntimeCatCatalog(root)))) {
    catRegistry.register(id, config);
  }

  // 2. Materialize builtin gemini AGY profile home & record 4-window dual-pool observation
  mkdirSync(join(root, '.cat-cafe', 'agy-profiles', 'gemini38'), { recursive: true });
  // Also materialize ssh_file token so Linux and macOS both resolve deterministically
  mkdirSync(join(root, '.cat-cafe', 'agy-profiles', 'gemini38', '.gemini', 'antigravity-cli'), { recursive: true });
  writeFileSync(
    join(root, '.cat-cafe', 'agy-profiles', 'gemini38', '.gemini', 'antigravity-cli', 'antigravity-oauth-token'),
    JSON.stringify({
      auth_method: 'consumer',
      token: {
        access_token: 'fixture',
        refresh_token: 'fixture-refresh',
        expiry: new Date(now + 2 * 3600_000).toISOString(),
      },
    }),
    { mode: 0o600 },
  );
  const geminiOwner = await resolveAgyQuotaExecutionOwner(root, 'gemini', {
    keychainIdentityInspector,
  });
  assert.ok(geminiOwner?.snapshot.credentialVersion);
  assert.equal(
    await recordAgyQuota({
      root,
      account: geminiOwner.snapshot,
      observedAt: now - 60_000,
      keychainIdentityInspector,
      items: [
        {
          label: 'Gemini · 每周使用限额',
          usedPercent: 34.98,
          percentKind: 'remaining',
          poolId: 'agy-gemini',
          resetsAt: new Date(now + 3 * 86_400_000).toISOString(),
        },
        {
          label: 'Gemini · 5小时使用限额',
          usedPercent: 97.65,
          percentKind: 'remaining',
          poolId: 'agy-gemini',
          resetsAt: new Date(now + 3 * 3600_000).toISOString(),
        },
        {
          label: 'Claude / GPT · 每周使用限额',
          usedPercent: 97.97,
          percentKind: 'remaining',
          poolId: 'agy-claude-gpt',
          resetsAt: new Date(now + 2 * 86_400_000).toISOString(),
        },
        {
          label: 'Claude / GPT · 5小时使用限额',
          usedPercent: 100,
          percentKind: 'remaining',
          poolId: 'agy-claude-gpt',
          resetsAt: new Date(now + 4 * 3600_000).toISOString(),
        },
      ],
    }),
    'stored',
  );

  // 3. Materialize kimi-code-native catalog account, .kimi-code login, & 2-window observation
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('KIMI_')) delete process.env[key];
  }
  writeCatalogAccount(root, 'kimi-code-native', {
    authType: 'oauth',
    clientId: 'kimi',
    displayName: 'Kimi Code Native',
  });
  mkdirSync(join(root, '.kimi-code', 'credentials'), { recursive: true });
  writeFileSync(
    join(root, '.kimi-code', 'config.toml'),
    '[providers.kimi-code]\ntype = "kimi"\n\n[providers.kimi-code.oauth]\nstorage = "file"\nkey = "kimi-code"\n',
  );
  writeFileSync(
    join(root, '.kimi-code', 'credentials', 'kimi-code.json'),
    JSON.stringify({ access_token: 'fixture' }),
    { mode: 0o600 },
  );
  const kimiOwner = resolveKimiQuotaExecutionOwner(root, 'kimi-code-native');
  assert.ok(kimiOwner?.snapshot.credentialVersion);
  assert.equal(
    recordKimiQuota({
      root,
      account: kimiOwner.snapshot,
      observedAt: now - 45_000,
      items: [
        {
          label: '5小时使用限额',
          usedPercent: 0,
          percentKind: 'used',
          poolId: 'kimi-rate-limit',
          resetsAt: new Date(now + 3 * 3600_000).toISOString(),
        },
        {
          label: '每周使用限额',
          usedPercent: 60,
          percentKind: 'used',
          poolId: 'kimi-weekly',
          resetsAt: new Date(now + 2 * 86_400_000).toISOString(),
        },
      ],
    }),
    true,
  );

  // 4. Register non-AGY Google Cloud (Vertex AI) and Google API Key accounts to verify strict isolation
  for (const body of [
    {
      displayName: 'Vertex 生产号',
      authType: 'oauth',
      clientId: 'google',
      googleCloudProjectId: 'fixture-vertex-project',
    },
    {
      displayName: 'Google 直连密钥',
      authType: 'api_key',
      clientId: 'google',
      apiKey: 'fixture-only',
    },
  ]) {
    const createRes = await fetch(`${preview.apiUrl}/api/accounts`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-cat-cafe-user': 'fixture',
      },
      body: JSON.stringify({ projectPath: root, ...body }),
    });
    assert.equal(createRes.status, 200, await createRes.text());
  }

  // 5. Pin gemini & kimi-code-native in sidebar preference
  const prefRes = await fetch(`${preview.apiUrl}/api/config/quota-pin`, {
    method: 'PUT',
    headers: {
      'content-type': 'application/json',
      'x-cat-cafe-user': 'fixture',
    },
    body: JSON.stringify({
      pinned: true,
      selectedAccountRefs: ['gemini', 'kimi-code-native'],
    }),
  });
  assert.equal(prefRes.status, 200, await prefRes.text());

  browser = await chromium.launch({ headless: true });
});

after(async () => {
  await browser?.close();
  await preview?.close();
});

test(
  'renders 1:1 AGY dual-pool and Kimi meters in /settings?s=accounts and sidebar QuotaRingPopover, syncs inline refresh, and isolates non-AGY Google rows',
  { timeout: 180_000 },
  async () => {
    const evidenceDir = process.env.F051_EVIDENCE_DIR;
    if (evidenceDir) mkdirSync(evidenceDir, { recursive: true });

    const pageErrors = [];
    const quotaPosts = [];

    const context = await browser.newContext({
      viewport: { width: 1440, height: 960 },
      deviceScaleFactor: 2,
    });
    const page = await context.newPage();
    page.on('pageerror', (err) => pageErrors.push(err.message));
    page.on('request', (req) => {
      if (req.method() === 'POST' && req.url().includes('/quota')) {
        quotaPosts.push(new URL(req.url()).pathname);
      }
    });

    await page.goto(`${preview.url}/settings?s=accounts&shell=v2`, { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => localStorage.setItem('cat-cafe:shell-language', 'zh'));
    await page.reload({ waitUntil: 'domcontentloaded' });

    const geminiRow = page.locator('[data-account-id="gemini"]');
    const kimiRow = page.locator('[data-account-id="kimi-code-native"]');
    await geminiRow.waitFor({ state: 'visible', timeout: 45_000 });
    await kimiRow.waitFor({ state: 'visible', timeout: 45_000 });
    await geminiRow.locator('[role="meter"]').first().waitFor({ state: 'visible', timeout: 30_000 });
    await kimiRow.locator('[role="meter"]').first().waitFor({ state: 'visible', timeout: 30_000 });

    if (evidenceDir) {
      await page.screenshot({
        path: join(evidenceDir, '01-desktop-accounts-directory.png'),
        fullPage: true,
      });
    }

    const readRowSnapshot = async (row) =>
      row.evaluate((el) => ({
        provider: el.querySelector('td:nth-child(1)')?.textContent?.trim() ?? '',
        statusLabel: el.querySelector('.account-state')?.textContent?.trim() ?? '',
        quotaCellText: el.querySelector('.account-quota-cell')?.textContent?.trim() ?? '',
        followersText: el.querySelector('.account-followers')?.textContent?.trim() ?? '',
        accountMeters: [...el.querySelectorAll('[role="meter"]')].map((m) => m.getAttribute('aria-valuenow')),
        windowLabels: [...el.querySelectorAll('.account-quota-label')].map((l) => l.textContent?.trim() ?? ''),
        tightestCount: el.querySelectorAll('.account-quota-window[data-tightest="true"]').length,
        hasSwitchButton: [...el.querySelectorAll('button')].some((b) => b.textContent?.trim() === '换成这个'),
      }));

    const geminiBefore = await readRowSnapshot(geminiRow);
    const kimiBefore = await readRowSnapshot(kimiRow);

    assert.equal(geminiBefore.statusLabel, '已登录', JSON.stringify(geminiBefore));
    assert.equal(geminiBefore.quotaCellText.includes('这一家没有额度接口'), false, JSON.stringify(geminiBefore));
    assert.equal(geminiBefore.quotaCellText.includes('读不到'), false, JSON.stringify(geminiBefore));
    assert.deepEqual(geminiBefore.accountMeters, ['35', '98', '98', '100']);
    assert.equal(geminiBefore.tightestCount, 2);
    assert.ok(geminiBefore.windowLabels.includes('Gemini · 本周'));
    assert.ok(geminiBefore.windowLabels.includes('Claude / GPT · 本周'));

    assert.equal(kimiBefore.statusLabel, '已登录', JSON.stringify(kimiBefore));
    assert.equal(kimiBefore.quotaCellText.includes('这一家没有额度接口'), false, JSON.stringify(kimiBefore));
    assert.equal(kimiBefore.quotaCellText.includes('读不到'), false, JSON.stringify(kimiBefore));
    assert.deepEqual(kimiBefore.accountMeters, ['100', '40']);
    assert.ok(kimiBefore.followersText.includes('正在用'), JSON.stringify(kimiBefore));
    assert.ok(kimiBefore.followersText.includes('1 只猫'), JSON.stringify(kimiBefore));
    assert.equal(kimiBefore.hasSwitchButton, false);

    // Verify non-AGY Google rows are strictly isolated
    const vertexRow = page.locator('[data-account-id^="google-cloud-"]');
    const googleKeyRow = page.locator('[data-account-id]').filter({
      hasText: 'Google 直连密钥',
    });
    await vertexRow.waitFor({ state: 'visible' });
    await googleKeyRow.waitFor({ state: 'visible' });
    const vertexSnap = await readRowSnapshot(vertexRow);
    const googleKeySnap = await readRowSnapshot(googleKeyRow);
    assert.equal(vertexSnap.provider, 'Google Cloud（Vertex AI · fixture-vertex-project）');
    assert.equal(vertexSnap.accountMeters.length, 0);
    assert.ok(vertexSnap.quotaCellText.includes('这一家没有额度接口'));
    assert.equal(vertexSnap.hasSwitchButton, false);
    assert.equal(googleKeySnap.statusLabel, '密钥已填');
    assert.equal(googleKeySnap.accountMeters.length, 0);
    assert.ok(googleKeySnap.quotaCellText.includes('余额请到服务商那里看'));

    // Open sidebar QuotaRingPopover on the exact same page — zero passive POSTs!
    assert.equal(quotaPosts.length, 0);
    const ringBtn = page.getByTestId('quota-ring-button');
    await ringBtn.waitFor({ state: 'visible', timeout: 30_000 });
    await ringBtn.click();
    const popover = page.getByTestId('quota-ring-popover');
    await popover.waitFor({ state: 'visible', timeout: 15_000 });
    assert.equal(quotaPosts.length, 0);

    const readCardMeters = async (accountId) =>
      popover
        .locator(`[data-quota-account="${accountId}"] [role="meter"]`)
        .evaluateAll((els) => els.map((el) => el.getAttribute('aria-valuenow')));

    const geminiCardBefore = await readCardMeters('gemini');
    const kimiCardBefore = await readCardMeters('kimi-code-native');

    assert.deepEqual(geminiBefore.accountMeters, geminiCardBefore);
    assert.deepEqual(kimiBefore.accountMeters, kimiCardBefore);

    if (evidenceDir) {
      await page.screenshot({
        path: join(evidenceDir, '02-desktop-accounts-with-sidebar-popover.png'),
        fullPage: true,
      });
    }

    // Close popover, click inline refresh on Gemini row inside /settings?s=accounts, then re-verify BOTH surfaces updated!
    await page.keyboard.press('Escape');
    await popover.waitFor({ state: 'detached', timeout: 10_000 });
    await geminiRow.getByRole('button', { name: '刷新额度', exact: true }).click();
    await page.waitForFunction(
      () => {
        const meters = [
          ...(document.querySelector('[data-account-id="gemini"]')?.querySelectorAll('[role="meter"]') ?? []),
        ].map((m) => m.getAttribute('aria-valuenow'));
        return meters.length === 2 && meters[0] === '28' && meters[1] === '91';
      },
      null,
      { timeout: 15_000 },
    );
    assert.deepEqual(quotaPosts, ['/api/accounts/gemini/agy/quota']);

    await ringBtn.click();
    await popover.waitFor({ state: 'visible' });
    await page.waitForFunction(
      () =>
        [...(document.querySelector('[data-quota-account="gemini"]')?.querySelectorAll('[role="meter"]') ?? [])]
          .map((m) => m.getAttribute('aria-valuenow'))
          .join(',') === '28,91',
      null,
      { timeout: 10_000 },
    );
    const geminiAfter = await readRowSnapshot(geminiRow);
    const geminiCardAfter = await readCardMeters('gemini');
    assert.deepEqual(geminiAfter.accountMeters, ['28', '91']);
    assert.deepEqual(geminiAfter.accountMeters, geminiCardAfter);

    if (evidenceDir) {
      await page.screenshot({
        path: join(evidenceDir, '03-desktop-after-inline-refresh.png'),
        fullPage: true,
      });
    }

    // Verify 390px narrow layout preserves dual-pool separation (data-tightest=true on both pools),
    // hides elapsed 1% Kimi window while keeping active 90% Kimi window visible, and has no horizontal overflow
    await page.keyboard.press('Escape');
    await popover.waitFor({ state: 'detached', timeout: 10_000 });
    await kimiRow.getByRole('button', { name: '刷新额度', exact: true }).click();
    await page.waitForFunction(
      () =>
        [...(document.querySelector('[data-account-id="kimi-code-native"]')?.querySelectorAll('[role="meter"]') ?? [])]
          .map((m) => m.getAttribute('aria-valuenow'))
          .join(',') === '1,90',
      null,
      { timeout: 15_000 },
    );

    await page.setViewportSize({ width: 390, height: 844 });
    const visibleGeminiWindowsOnMobile = await geminiRow
      .locator('.account-quota-window')
      .evaluateAll((els) =>
        els.filter((el) => getComputedStyle(el).display !== 'none').map((el) => el.textContent?.trim() ?? ''),
      );
    assert.equal(visibleGeminiWindowsOnMobile.length, 2, JSON.stringify(visibleGeminiWindowsOnMobile));
    assert.ok(visibleGeminiWindowsOnMobile.some((t) => t.includes('Gemini ·')));
    assert.ok(visibleGeminiWindowsOnMobile.some((t) => t.includes('Claude / GPT ·')));

    const visibleKimiMetersOnMobile = await kimiRow
      .locator('.account-quota-window')
      .evaluateAll((els) =>
        els
          .filter((el) => getComputedStyle(el).display !== 'none')
          .map((el) => el.querySelector('[role="meter"]')?.getAttribute('aria-valuenow')),
      );
    assert.deepEqual(visibleKimiMetersOnMobile, ['90']);
    const mobileNoHorizontalOverflow = await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    );
    assert.equal(mobileNoHorizontalOverflow, true);

    if (evidenceDir) {
      await page.screenshot({
        path: join(evidenceDir, '04-mobile-390-accounts-directory.png'),
        fullPage: true,
      });
    }

    assert.deepEqual(pageErrors, []);

    if (evidenceDir) {
      const proof = {
        verifiedAt: new Date().toISOString(),
        desktopViewport: { width: 1440, height: 960 },
        mobileViewport: { width: 390, height: 844 },
        initialParity: {
          geminiAccountMeters: geminiBefore.accountMeters,
          geminiCardMeters: geminiCardBefore,
          geminiStatus: geminiBefore.statusLabel,
          kimiAccountMeters: kimiBefore.accountMeters,
          kimiCardMeters: kimiCardBefore,
          kimiStatus: kimiBefore.statusLabel,
          kimiFollowers: kimiBefore.followersText,
        },
        afterInlineRefreshParity: {
          quotaPosts,
          geminiAccountMeters: geminiAfter.accountMeters,
          geminiCardMeters: geminiCardAfter,
        },
        nonAgyGoogleIsolation: {
          vertexProvider: vertexSnap.provider,
          vertexMeters: vertexSnap.accountMeters,
          vertexQuotaText: vertexSnap.quotaCellText,
          googleApiKeyStatus: googleKeySnap.statusLabel,
          googleApiKeyMeters: googleKeySnap.accountMeters,
          googleApiKeyQuotaText: googleKeySnap.quotaCellText,
        },
        mobile390: {
          visibleGeminiWindowsOnMobile,
          visibleKimiMetersOnMobile,
          noHorizontalOverflow: mobileNoHorizontalOverflow,
        },
        pageErrors,
      };
      writeFileSync(join(evidenceDir, 'account-directory-green-proof.json'), `${JSON.stringify(proof, null, 2)}\n`);
    }

    await context.close();
  },
);
