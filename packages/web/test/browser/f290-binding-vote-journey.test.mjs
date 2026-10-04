import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { CollectiveServiceStore, startCollectiveServer } from '../../../collective-service/dist/index.js';
import { chromium } from '../../../ppt-forge/node_modules/playwright/index.mjs';
import { defaultHumanAuthProvider, seedDefaultCollective } from './f290-default-client.fixture.mjs';

test(
  'an accountable Human freezes and settles a two-Human Roadmap Decision without mutating the route',
  { timeout: 45_000 },
  async () => {
    const dataDirectory = await mkdtemp(path.join(tmpdir(), 'f290-binding-vote-journey-'));
    const opened = await CollectiveServiceStore.open({ dataDirectory, humanAuthProvider: defaultHumanAuthProvider() });
    const seeded = await seedDefaultCollective(opened.store, opened.bootstrapSecret);
    const proposed = await opened.store.proposeCollectiveWork(seeded.owner.sessionToken, {
      ...seeded.coordinates,
      requestId: 'browser-binding-work',
      sourceEventId: seeded.first.eventId,
    });
    const work = await opened.store.commitCollectiveWork(seeded.owner.sessionToken, {
      ...seeded.coordinates,
      requestId: 'browser-binding-work-commit',
      workId: proposed.workId,
      expectedRevision: proposed.revision,
    });
    const roadmap = await opened.store.createCollectiveRoadmap(seeded.owner.sessionToken, {
      ...seeded.coordinates,
      requestId: 'browser-binding-roadmap',
      sourceEventId: seeded.first.eventId,
      title: '候选版本路线',
      purpose: '验证冻结规则只形成 Decision。',
      workIds: [work.workId],
    });
    const server = await startCollectiveServer({ store: opened.store, host: '127.0.0.1', port: 0 });
    const browser = await chromium.launch({ headless: true });
    const openRoadmap = async (token) => {
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
      await page.getByRole('button', { name: 'Roadmap', exact: true }).click();
      await page.getByRole('heading', { name: roadmap.title, exact: true }).waitFor();
      return { context, page };
    };
    const owner = await openRoadmap(seeded.owner.sessionToken);
    const member = await openRoadmap(seeded.member.sessionToken);
    try {
      await owner.page.getByRole('button', { name: '发起有约束力的判断', exact: true }).click();
      await owner.page.getByLabel('投票问题', { exact: true }).fill('候选版本按哪个日期交付？');
      await owner.page.getByLabel('投票选项 1', { exact: true }).fill('周四');
      await owner.page.getByLabel('投票选项 2', { exact: true }).fill('周五');
      await owner.page.getByRole('button', { name: '冻结并开票', exact: true }).click();
      await owner.page.getByText('2 位冻结投票人 · 2 人参与且同一选项 2 票才通过', { exact: true }).waitFor();

      await member.page.reload({ waitUntil: 'networkidle' });
      await member.page
        .getByRole('navigation', { name: '频道', exact: true })
        .getByRole('button', { name: /产品方向/ })
        .click();
      await member.page.getByRole('button', { name: 'Roadmap', exact: true }).click();
      const memberVote = member.page.getByRole('article', { name: /有约束力的判断/ });
      await memberVote.getByRole('button', { name: /周四/ }).click();
      assert.equal(await memberVote.getByRole('button', { name: '结算为 Decision', exact: true }).count(), 0);

      await owner.page.reload({ waitUntil: 'networkidle' });
      await owner.page
        .getByRole('navigation', { name: '频道', exact: true })
        .getByRole('button', { name: /产品方向/ })
        .click();
      await owner.page.getByRole('button', { name: 'Roadmap', exact: true }).click();
      const ownerVote = owner.page.getByRole('article', { name: /有约束力的判断/ });
      await ownerVote.getByRole('button', { name: /周四/ }).click();
      await ownerVote.getByRole('button', { name: '结算为 Decision', exact: true }).click();
      await ownerVote.getByRole('region', { name: 'Decision · 周四', exact: true }).waitFor();
      await ownerVote.getByText('路线未被自动修改。', { exact: false }).waitFor();

      const projection = opened.store.listCollectiveCollaboration(
        seeded.owner.sessionToken,
        seeded.coordinates.collectiveId,
      );
      assert.equal(projection.decisions.length, 1);
      assert.equal(projection.decisions[0].statement, '周四');
      assert.deepEqual(projection.roadmaps[0], roadmap);
    } finally {
      await owner.context.close();
      await member.context.close();
      await browser.close();
      await server.close();
      await rm(dataDirectory, { recursive: true });
    }
  },
);
