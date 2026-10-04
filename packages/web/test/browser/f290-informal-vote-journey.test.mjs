import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { CollectiveServiceStore, startCollectiveServer } from '../../../collective-service/dist/index.js';
import { chromium } from '../../../ppt-forge/node_modules/playwright/index.mjs';
import { defaultHumanAuthProvider, seedDefaultCollective } from './f290-default-client.fixture.mjs';

test('two Human sessions cast and change a persistent source-linked informal Vote', { timeout: 45_000 }, async () => {
  const dataDirectory = await mkdtemp(path.join(tmpdir(), 'f290-vote-journey-'));
  const opened = await CollectiveServiceStore.open({
    dataDirectory,
    humanAuthProvider: defaultHumanAuthProvider(),
  });
  const seeded = await seedDefaultCollective(opened.store, opened.bootstrapSecret);
  const server = await startCollectiveServer({ store: opened.store, host: '127.0.0.1', port: 0 });
  const browser = await chromium.launch({ headless: true });
  const openClient = async (token) => {
    const context = await browser.newContext({ viewport: { width: 1100, height: 820 } });
    await context.addInitScript(
      ({ origin, sessionToken }) => sessionStorage.setItem(`collective-session:${origin}`, sessionToken),
      { origin: server.url, sessionToken: token },
    );
    const page = await context.newPage();
    await page.goto(server.url, { waitUntil: 'networkidle' });
    await page
      .getByRole('navigation', { name: '频道', exact: true })
      .getByRole('button', { name: /产品方向/ })
      .click();
    await page.getByText(seeded.first.body, { exact: true }).waitFor();
    return { context, page };
  };
  const owner = await openClient(seeded.owner.sessionToken);
  const member = await openClient(seeded.member.sessionToken);
  const sourceArticle = (page) => page.locator('article.message').filter({ hasText: seeded.first.body });
  try {
    const ownerSource = sourceArticle(owner.page);
    await ownerSource.hover();
    await ownerSource.getByRole('button', { name: '更多消息动作', exact: true }).click();
    await ownerSource.getByRole('menuitem', { name: '发起随手投票', exact: true }).click();
    await ownerSource.getByLabel('投票问题', { exact: true }).fill('候选版本周四还是周五交付？');
    await ownerSource.getByLabel('投票选项 1', { exact: true }).fill('周四');
    await ownerSource.getByLabel('投票选项 2', { exact: true }).fill('周五');
    await ownerSource.getByRole('button', { name: '发布投票', exact: true }).click();
    const ownerVote = ownerSource.getByRole('region', { name: /投票 · 候选版本/ });
    await ownerVote.getByText('随手问问 · 不形成决定', { exact: true }).waitFor();
    await ownerVote.getByRole('button', { name: /周五/ }).click();

    await member.page.reload({ waitUntil: 'networkidle' });
    const memberVote = sourceArticle(member.page).getByRole('region', { name: /投票 · 候选版本/ });
    await memberVote.getByRole('button', { name: /周四/ }).click();
    assert.equal(await memberVote.getByRole('button', { name: '结束投票', exact: true }).count(), 0);

    await owner.page.reload({ waitUntil: 'networkidle' });
    const refreshedOwnerVote = sourceArticle(owner.page).getByRole('region', { name: /投票 · 候选版本/ });
    await refreshedOwnerVote.getByRole('button', { name: /周四/ }).click();
    await refreshedOwnerVote.getByText('2 票', { exact: true }).waitFor();
    await refreshedOwnerVote.getByRole('button', { name: '结束投票', exact: true }).click();
    await refreshedOwnerVote.getByText('发起人已结束', { exact: true }).waitFor();
    assert.equal(await refreshedOwnerVote.getByRole('button', { name: /周四/ }).isDisabled(), true);

    const votes = opened.store.listCollectiveCollaboration(
      seeded.owner.sessionToken,
      seeded.coordinates.collectiveId,
    ).votes;
    assert.equal(votes.length, 1);
    assert.equal(votes[0].sourceEventId, seeded.first.eventId);
    assert.equal(votes[0].effect, 'preference_only');
    assert.equal(votes[0].status, 'closed');
    assert.equal(votes[0].ballots.length, 2);
  } finally {
    await owner.context.close();
    await member.context.close();
    await browser.close();
    await server.close();
    await rm(dataDirectory, { recursive: true });
  }
});
