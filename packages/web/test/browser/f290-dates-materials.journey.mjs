import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { chromium } from 'playwright';
import { expressionFixture } from './f290-expression.fixture.mjs';
import { expressionHostFixture } from './f290-expression-voice.fixture.mjs';

const output = process.env.F290_BATCH2_EVIDENCE_DIR;
test(
  'original Project dates and explicit material sorting survive revision, revoke, refresh and restart through the real Host frame',
  { timeout: 180_000 },
  async (t) => {
    let available = true;
    const materialSource = {
      async execute(operation, authority) {
        await authority.reauthorize();
        if (!available) return { status: 'unavailable', reason: 'deleted' };
        const meeting = operation.publication.provider === 'feishu';
        return {
          status: 'available',
          sourceKey: meeting ? 'feishu:fixture-meeting' : 'issue:fixture/repo#1',
          sourceRef: meeting
            ? 'feishu://meeting-artifacts/minute/fixture?revision=fixture-generation'
            : 'https://github.com/fixture/repo/issues/1',
          witness: {
            digest: (meeting ? 'a' : 'b').repeat(64),
            readAt: new Date().toISOString(),
            ...(meeting ? { generationScope: 'fixture-generation' } : {}),
          },
          material: {
            kind: meeting ? 'meeting' : 'issue',
            title: meeting ? 'Meeting material (fixture)' : 'Issue material (fixture)',
            author: 'Fixture author',
            clauses: meeting
              ? [
                  {
                    clauseId: 'first',
                    text: 'Confirm the installation path. Friday was mentioned; no deadline was agreed.',
                  },
                  { clauseId: 'second', text: 'Keep the original source authority.' },
                ]
              : [{ clauseId: 'subject', text: 'Read the original Issue before deciding its destination.' }],
          },
        };
      },
    };
    const host = await expressionHostFixture({ appearanceControls: true });
    t.after(() => host.close());
    const fixture = await expressionFixture({ allowedHostOrigins: [host.url], materialSource });
    t.after(() => fixture.close());
    host.setService(fixture.url);
    const browser = await chromium.launch({
      headless: true,
      ...(process.env.F290_BROWSER_EXECUTABLE ? { executablePath: process.env.F290_BROWSER_EXECUTABLE } : {}),
    });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    t.after(async () => {
      await context.close();
      await browser.close();
    });
    const session = fixture.creator.sessionToken,
      coords = fixture.coordinates;
    let project = await fixture.store.createCollectiveProject(session, {
      ...coords,
      requestId: 'project',
      channelId: 'general',
      title: 'Original Project',
      purpose: 'Use the same Work, dates and current source.',
    });
    const created = await fixture.store.createCollectiveProjectTask(session, {
      ...coords,
      requestId: 'task',
      roadmapId: project.roadmapId,
      expectedRoadmapRevision: project.revision,
      channelId: 'general',
      title: 'Original task',
      intendedOutcome: 'Keep this task identity.',
      accountability: 'self',
    });
    project = created.roadmap;
    const pairing = await fixture.store.createPairingIntent({
      sessionToken: session,
      collectiveId: coords.collectiveId,
      hostOrigin: host.url,
      nonce: 'batch2-browser-explicit-pairing',
    });
    await fixture.store.exchangePairingIntent({ ...pairing, endpointLabel: 'Fixture Cafe' });
    await context.addInitScript(
      ({ origin, token }) => {
        if (location.origin === origin) sessionStorage.setItem(`collective-session:${origin}`, token);
      },
      { origin: fixture.url, token: session },
    );
    const page = await context.newPage(),
      errors = [];
    page.setDefaultTimeout(20_000);
    page.on('pageerror', (error) => errors.push(error.message));
    await page.route('**/*', (route) => {
      assert.ok(!['3001', '3002', '6399'].includes(new URL(route.request().url()).port));
      return route.continue();
    });
    const shot = async (name) => {
      if (output) {
        await mkdir(output, { recursive: true });
        await page.screenshot({ path: join(output, name + '.png'), fullPage: true });
      }
    };
    const frame = page.frameLocator('iframe[title="Collective"]');
    const openProject = async () => {
      const browse = frame.getByRole('button', { name: /先逛逛|Browse first/ });
      if (await browse.isVisible()) await browse.click();
      await frame.getByRole('button', { name: /^项目$|^Projects$/ }).click();
      await frame.getByRole('button', { name: /打开项目 · Original Project|Open project · Original Project/ }).click();
    };
    await page.goto(host.url + '/collective', { waitUntil: 'networkidle' });
    await openProject();
    await frame.locator('.project-plan-task').filter({ hasText: 'Original task' }).click();
    await frame.getByRole('button', { name: '改日期…', exact: true }).click();
    await frame.locator('.work-time-editor input[type="datetime-local"]').fill('2026-11-01T01:30');
    await frame.locator('.work-time-editor').getByLabel('时区', { exact: true }).fill('America/Los_Angeles');
    await shot('repeated-hour-choice-1440');
    await frame.getByLabel('这个时间出现两次', { exact: true }).selectOption('2026-11-01T09:30:00.000Z');
    await frame.getByRole('button', { name: '保存日期', exact: true }).click();
    await frame.locator('.work-time-editor').waitFor({ state: 'hidden' });
    const timed = fixture.store.listCollectiveCollaboration(session, coords.collectiveId).works[0];
    assert.equal(timed.time.businessDeadline.value, '2026-11-01T09:30:00.000Z');
    await shot('owner-date-1440');
    await frame.getByRole('button', { name: '关闭任务详情', exact: true }).click();
    const share = async (provider, sourceId) => {
      await frame.getByRole('button', { name: '分享材料…', exact: true }).click();
      const dialog = frame.getByRole('dialog', { name: '分享材料…', exact: true });
      await dialog.locator('select').nth(1).selectOption(provider);
      await dialog.getByRole('textbox').fill(sourceId);
      await dialog.getByRole('checkbox').check();
      await dialog.getByRole('button', { name: '分享并进入待分拣', exact: true }).click();
      await dialog.waitFor({ state: 'hidden' });
      await frame.locator('[data-material-id]').first().waitFor();
    };
    await share('github', 'issue:fixture/repo#1');
    await share('github', 'issue:fixture/repo#1');
    assert.equal(await frame.locator('[data-material-id]').count(), 1);
    await share('feishu', 'c'.repeat(64));
    const meeting = frame.locator('[data-material-id]').filter({ hasText: 'Meeting material (fixture)' });
    await meeting.getByRole('button', { name: '建成任务', exact: true }).first().click();
    const create = frame.getByRole('dialog', { name: '建成任务', exact: true });
    assert.match(await create.innerText(), /负责人：未分配.*截止：不设/s);
    await create.getByLabel('任务名', { exact: true }).fill('Confirmed from meeting');
    await create.getByRole('button', { name: '确认', exact: true }).click();
    await create.waitFor({ state: 'hidden' });
    await meeting.getByRole('button', { name: '并进已有任务', exact: true }).last().click();
    const merge = frame.getByRole('dialog', { name: '并进已有任务', exact: true });
    await merge.getByRole('radio', { name: 'Original task', exact: true }).check();
    await merge.getByRole('button', { name: '确认', exact: true }).click();
    await merge.waitFor({ state: 'hidden' });
    const result = fixture.store.listCollectiveCollaboration(session, coords.collectiveId);
    assert.equal(result.works.length, 2);
    const adopted = result.works.find((work) => work.title === 'Confirmed from meeting');
    assert.equal(adopted.accountableHumanId, undefined);
    assert.equal(adopted.assignment, undefined);
    assert.equal(adopted.time, undefined);
    assert.deepEqual(result.works.find((work) => work.workId === timed.workId).time, timed.time);
    await meeting
      .getByRole('button', { name: /Confirmed from meeting/ })
      .first()
      .click();
    await frame.getByRole('button', { name: '考虑把「Friday」设成截止…', exact: true }).click();
    await frame.locator('.work-time-editor').waitFor();
    assert.match(await frame.locator('.work-time-editor').innerText(), /现在还没有确认/);
    assert.equal(
      fixture.store
        .listCollectiveCollaboration(session, coords.collectiveId)
        .works.find((work) => work.workId === adopted.workId).time,
      undefined,
    );
    await frame.locator('.work-time-editor').getByRole('button', { name: '取消', exact: true }).click();
    await frame.getByRole('button', { name: '关闭任务详情', exact: true }).click();
    await shot('triage-zh-light-1440');
    await page.getByRole('button', { name: 'English', exact: true }).click();
    await frame.getByRole('heading', { name: /^To sort/ }).waitFor();
    await page.getByRole('button', { name: 'Dark', exact: true }).click();
    await frame.locator('html[data-theme="dark"]').waitFor();
    await shot('triage-en-dark-1440');
    await page.setViewportSize({ width: 390, height: 844 });
    await shot('triage-en-dark-390');
    assert.equal(await frame.locator('html').evaluate((element) => element.scrollWidth > innerWidth), false);
    available = false;
    await frame.getByRole('button', { name: 'Refresh', exact: true }).click();
    await frame.locator('[data-material-id]').waitFor({ state: 'hidden' });
    assert.equal(await frame.getByText('Meeting material (fixture)', { exact: true }).count(), 0);
    await fixture.restart();
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.reload({ waitUntil: 'networkidle' });
    await openProject();
    assert.equal(fixture.store.listCollectiveCollaboration(session, coords.collectiveId).works.length, 2);
    assert.deepEqual(errors, []);
    await page.setViewportSize({ width: 390, height: 844 });
    await shot('revoked-after-restart-390');
    if (output)
      await writeFile(
        join(output, 'journey.json'),
        JSON.stringify(
          {
            fixtureHuman: true,
            fixtureProviders: true,
            host: 'actual CollectiveLaunchSurface and appearance bridge',
            taskCount: 2,
            errors,
            checks: [
              'DST repeated-hour explicit choice',
              'duplicate publication',
              'unassigned/no-date create',
              'merge preserves date',
              'English/dark/390',
              'revoke and restart',
            ],
          },
          null,
          2,
        ) + '\n',
      );
  },
);
