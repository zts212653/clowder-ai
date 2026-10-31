import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '../../../ppt-forge/node_modules/playwright/index.mjs';
import { registerDefaultEntryJourney } from './default-entry-journey.harness.mjs';
import { availablePort, stopChild, waitForHttp } from './f290-runtime-journey.harness.mjs';
import { CALENDAR_THREAD, createCalendarFixture } from './f310-work-calendar.fixture.mjs';
import { assertApprovalHistoryJourney } from './f322-j3-approval-history.mjs';
import { assertQualifiedMailboxCounts } from './f322-j3-attention.fixture.mjs';
import { assertPersonalMailboxJourney } from './f322-j3-personal-mailbox.mjs';
import { assertPersonalMailboxRaces } from './f322-j3-personal-races.mjs';
import { assertPersonalScheduleJourney } from './f322-j3-personal-schedule.mjs';
import {
  assertDifferentArtifactReadFailure,
  assertMobileScheduleControls,
  assertRecentArtifactReturnAndFailedRead,
  readingSnapshot,
  writeReadingFailure,
} from './f322-j3-schedule-reading.mjs';
import { createNextDevTestEnvironment } from './next-dev-test-environment.mjs';

const language = process.env.F322_J3_LANGUAGE ?? 'zh';
const theme = process.env.F322_J3_THEME ?? 'light';
assert.ok(['zh', 'en'].includes(language));
assert.ok(['light', 'dark'].includes(theme));
const label = (zh, en) => (language === 'en' ? en : zh);

registerDefaultEntryJourney(
  {
    journeyId: 'f310-work-calendar',
    surfaceTestId: 'product-schedule-panel',
    title: `dates, progress, exact readable delivery and completed history (${language}/${theme})`,
    timeout: 180000,
  },
  async (journey, t) => {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
    const fixture = await createCalendarFixture();
    t.after(() => fixture.close());
    const webPort = await availablePort();
    const environment = await createNextDevTestEnvironment('f310-calendar', {
      API_SERVER_PORT: String(fixture.apiPort),
      NEXT_PUBLIC_API_URL: `http://127.0.0.1:${fixture.apiPort}`,
      FRONTEND_PORT: String(webPort),
    });
    t.after(() => environment.cleanup());
    const server = spawn(
      process.execPath,
      [
        path.resolve(root, 'scripts/sync-vendor-assets.mjs'),
        '--watch',
        '--',
        process.execPath,
        path.resolve(root, '../../node_modules/next/dist/bin/next'),
        'dev',
        '-H',
        '127.0.0.1',
        '-p',
        String(webPort),
      ],
      { cwd: root, env: environment.env, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    t.after(() => stopChild(server));
    const base = `http://127.0.0.1:${webPort}`;
    await waitForHttp(`${base}/thread/${CALENDAR_THREAD}`, server);
    const browser = await chromium.launch({ headless: true });
    t.after(() => browser.close());
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    await page.addInitScript(
      ({ language, theme }) => {
        localStorage.setItem('cat-cafe:shell-presentation', 'v2');
        localStorage.setItem('cat-cafe:shell-language', language);
        localStorage.setItem('theme', theme);
      },
      { language, theme },
    );
    let globalCatalogReads = 0;
    await page.route('**/api/artifacts', (route) => {
      globalCatalogReads++;
      return route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: '{"error":"Global catalog unavailable"}',
      });
    });
    page.on('pageerror', (error) => t.diagnostic(`browser error: ${error.message}`));
    page.on('response', async (response) => {
      if (response.url().includes('/api/entrusted-work/') && !response.ok())
        t.diagnostic(`owner read ${response.status()}: ${await response.text()}`);
    });
    let downloads = 0;
    page.on('download', () => downloads++);
    const openedFiles = [];
    page.on('request', (request) => {
      if (new URL(request.url()).pathname === fixture.artifactUrl) openedFiles.push(request.url());
    });
    const evidence = process.env.F310_EVIDENCE_DIR ?? path.join(tmpdir(), 'cat-cafe-evidence', 'f310-calendar');
    await mkdir(evidence, { recursive: true });
    try {
      await journey.enter(page, `${base}/thread/${CALENDAR_THREAD}`);
      await page.getByTestId('file-block-open').waitFor();
      await page.waitForFunction((expected) => document.documentElement.dataset.theme === expected, theme);
      const composer = page.locator('[data-testid="chat-input-composer-row"] textarea');
      await composer.fill('J3 原 Chat 草稿和选择位置');
      await composer.evaluate((input) => input.setSelectionRange(3, 8));
      await page.getByTestId('file-block-open').click();
      await page.getByText(fixture.sentinel, { exact: true }).waitFor();
      assert.ok(openedFiles.length > 0, 'the Chat file must open the same published file in Workspace');
      assert.equal(downloads, 0);
      await page.screenshot({ path: path.join(evidence, 'chat-artifact.png'), fullPage: true });
      await page.getByRole('button', { name: /^(返回来源|Back to source)$/, exact: true }).click();
      const workbench = page.getByTestId('f307-experience-workbench');
      if (await workbench.isVisible()) await page.getByTestId('workspace-panel-toggle').click();
      const reading = page.locator('[data-chat-container]');
      await reading.hover();
      await page.mouse.wheel(0, -2400);
      await page.waitForFunction(() => {
        const port = document.querySelector('[data-chat-container]');
        return port && port.scrollTop > 0 && port.scrollTop < port.scrollHeight - port.clientHeight - 100;
      });
      const originalReading = await readingSnapshot(page, true);
      assert.ok(originalReading.anchor);
      assert.ok(originalReading.scrollHeight > originalReading.height);
      await writeFile(path.join(evidence, 'j3-chat-reading-origin.json'), JSON.stringify(originalReading, null, 2));
      await page.getByTestId('mailbox-button').click();
      await assertQualifiedMailboxCounts(page, language, fixture.mentionCount);
      await page.getByTestId('mailbox-tab-schedule').press('Enter');
      await journey.arrive(page);
      const panel = page.getByTestId('product-schedule-panel');
      assert.equal(await page.getByTestId('mailbox-panel').count(), 0);
      await page.screenshot({ path: path.join(evidence, 'j3-mailbox-schedule-entry.png') });
      const entry = {
        sourceHead: process.env.F322_J3_SOURCE_HEAD ?? null,
        language,
        theme,
        actualTheme: await page.locator('html').getAttribute('data-theme'),
        width: (await panel.boundingBox()).width,
        workbench: await page.locator('[data-active-surface]').evaluate((element) => ({ ...element.dataset })),
        controlled: true,
      };
      await writeFile(path.join(evidence, 'j3-mailbox-schedule-entry.json'), JSON.stringify(entry, null, 2));
      assert.ok(entry.workbench.activeSurface);
      assert.equal(
        entry.workbench.mainAreaAttention,
        entry.workbench.activeSurface,
        'Schedule opens the original wide Workspace owner',
      );
      assert.equal(
        await panel
          .getByRole('region', { name: label('工作日历', 'Work calendar'), exact: true })
          .getAttribute('data-view'),
        'week',
      );
      const entryChatVisible = await reading.isVisible();
      const undated = panel.getByTestId('schedule-unscheduled');
      const undatedBlocked = undated.locator(`[data-subject-ref="task:work:${fixture.undatedBlockedId}"]`);
      assert.deepEqual(
        await undated
          .getByTestId('product-schedule-item')
          .evaluateAll((elements) => elements.map((element) => element.dataset.subjectRef).sort()),
        [fixture.undatedId, fixture.undatedBlockedId, ...fixture.undatedSampleIds, fixture.progress.taskId]
          .map((id) => `task:work:${id}`)
          .sort(),
        'Every undated work from the complete original read remains reachable',
      );
      assert.equal(
        await undated.getByTestId('product-schedule-item').first().getAttribute('data-subject-ref'),
        `task:work:${fixture.undatedBlockedId}`,
      );
      assert.equal(await panel.getByTestId('schedule-overdue').evaluate((element) => element.open), false);
      const todoGroup = undated.locator('[data-schedule-state="todo"]');
      await todoGroup.locator(':scope > summary').press('Enter');
      assert.equal(await todoGroup.evaluate((element) => element.open), false);
      await panel.getByRole('button', { name: label('下一周', 'Next week'), exact: true }).press('Enter');
      const calendarAnchor = await panel
        .getByRole('region', { name: label('本周安排', 'This week'), exact: true })
        .innerText();
      await undatedBlocked
        .getByRole('button', { name: label('打开成果', 'Open artifact'), exact: true })
        .press('Enter');
      await page.getByText(fixture.sentinel, { exact: true }).waitFor();
      await page.getByRole('button', { name: /^(返回来源|Back to source)$/, exact: true }).press('Enter');
      await undatedBlocked.waitFor();
      assert.equal(await undatedBlocked.getAttribute('data-selected'), 'true');
      assert.equal(
        await panel.getByRole('region', { name: label('本周安排', 'This week'), exact: true }).innerText(),
        calendarAnchor,
      );
      assert.equal(await todoGroup.evaluate((element) => element.open), false, 'return keeps the same folded group');
      assert.equal(entryChatVisible, true, 'the accepted desktop Schedule keeps original Chat visible at entry');
      await page.screenshot({ path: path.join(evidence, 'j3-week-artifact-back.png') });
      await panel.getByRole('button', { name: label('月', 'Month'), exact: true }).press('Enter');
      await panel.getByRole('button', { name: label('下个月', 'Next month'), exact: true }).press('Enter');
      const calendar = panel.getByRole('region', { name: label('工作日历', 'Work calendar'), exact: true });
      const monthAnchor = await calendar.innerText();
      const day = calendar.locator('[data-calendar-date]').nth(10);
      const chosenDay = await day.getAttribute('data-calendar-date');
      await day.press('Enter');
      await panel.getByRole('button', { name: label('展开成宽列表', 'Expand to a wide list'), exact: true }).click();
      await undated.locator('[data-schedule-state="todo"] > summary').press('Enter');
      const scrolledWork = undated.locator(`[data-subject-ref="task:work:${fixture.undatedSampleIds[9]}"]`);
      await scrolledWork
        .getByRole('button', { name: label('打开成果', 'Open artifact'), exact: true })
        .scrollIntoViewIfNeeded();
      await undated.evaluate((element) => {
        const trace = [];
        const capture = (event) => {
          if (trace.length < 100)
            trace.push({
              event,
              top: element.scrollTop,
              height: element.clientHeight,
              total: element.scrollHeight,
              width: element.clientWidth,
            });
        };
        window.__j3ScheduleListTrace = trace;
        element.addEventListener('scroll', () => capture('scroll'));
        const observer = new ResizeObserver(() => capture('resize'));
        observer.observe(element);
        capture('departure');
      });
      const listOrigin = await undated.evaluate((element) => ({
        top: element.scrollTop,
        height: element.clientHeight,
        total: element.scrollHeight,
      }));
      assert.ok(listOrigin.total > listOrigin.height && listOrigin.top > 0, 'the long undated list really scrolls');
      await scrolledWork.getByRole('button', { name: label('打开成果', 'Open artifact'), exact: true }).click();
      await page.getByText(fixture.sentinel, { exact: true }).waitFor();
      await page.getByRole('button', { name: /^(返回来源|Back to source)$/, exact: true }).click();
      await scrolledWork.waitFor();
      assert.equal(await scrolledWork.getAttribute('data-selected'), 'true');
      assert.equal(await calendar.count(), 0, 'artifact return retains the wide list');
      const listReturn = await undated.evaluate((element) => ({
        top: element.scrollTop,
        height: element.clientHeight,
        total: element.scrollHeight,
        width: element.clientWidth,
      }));
      const listTrace = await page.evaluate(() => window.__j3ScheduleListTrace);
      await writeFile(
        path.join(evidence, 'j3-list-scroll-return.json'),
        JSON.stringify({ listOrigin, listReturn, listTrace }, null, 2),
      );
      assert.ok(
        Math.abs(listReturn.top - listOrigin.top) <= 2,
        `same list scroll: ${JSON.stringify({ listOrigin, listReturn })}`,
      );
      await assertDifferentArtifactReadFailure(page, panel, fixture, language, evidence);
      await panel.getByRole('button', { name: label('返回列表', 'Return to list'), exact: true }).click();
      assert.equal(await calendar.getAttribute('data-view'), 'month');
      assert.equal(await calendar.innerText(), monthAnchor);
      assert.equal(await calendar.locator(`[data-calendar-date="${chosenDay}"]`).getAttribute('aria-pressed'), 'true');
      await page.screenshot({ path: path.join(evidence, 'j3-month-list-artifact-back.png') });
      await panel.getByRole('button', { name: label('周', 'Week'), exact: true }).click();
      await panel.getByRole('button', { name: label('回到本周', 'Back to this week') }).click();
      // The original actual-start fact may be yesterday just after local midnight.
      // Select its real marker, retaining the calendar filter instead of forcing the work into today.
      const started = new Date(fixture.actualStart);
      const key = `${started.getFullYear()}-${String(started.getMonth() + 1).padStart(2, '0')}-${String(started.getDate()).padStart(2, '0')}`;
      if ((await panel.locator(`[data-calendar-date="${key}"]`).count()) === 0)
        await panel.getByRole('button', { name: label('上一周', 'Previous week'), exact: true }).click();
      await panel.locator(`[data-calendar-date="${key}"]`).press('Enter');
      const work = page.locator(`[data-subject-ref="task:work:${fixture.taskId}"]`);
      await work.getByRole('heading', { name: fixture.title }).waitFor();
      assert.ok((await work.innerText()).includes(label('实际开始', 'Actual start')));
      assert.ok((await work.innerText()).includes(label('预计完成', 'Estimated completion')));
      assert.ok((await work.innerText()).includes(label('截止未定', 'Deadline not set')));
      assert.match(await work.innerText(), /检查完成后的成果回看/);
      await page.getByRole('region', { name: label('本周安排', 'This week'), exact: true }).waitFor();
      await page.setViewportSize({ width: 390, height: 844 });
      await assertMobileScheduleControls(page, panel, fixture, language);
      await work.scrollIntoViewIfNeeded();
      assert.ok((await work.getByRole('heading').boundingBox()).y < 750);
      assert.ok(await panel.evaluate((element) => element.scrollWidth <= element.clientWidth + 1));
      await page.screenshot({ path: path.join(evidence, 'active-mobile.png'), fullPage: true });
      await work.getByRole('button', { name: label('打开成果', 'Open artifact'), exact: true }).click();
      await page.getByText(fixture.sentinel, { exact: true }).waitFor();
      assert.equal(downloads, 0);
      await page.getByRole('button', { name: /^(返回来源|Back to source)$/, exact: true }).click();
      await work.waitFor();
      await fixture.complete();
      await panel.getByRole('button', { name: label('刷新', 'Refresh'), exact: true }).click();
      await page.getByRole('button', { name: label('已完成', 'Completed'), exact: true }).click();
      assert.equal(await panel.getByRole('group', { name: label('筛选工作', 'Filter work'), exact: true }).count(), 0);
      await work
        .locator('span')
        .filter({ hasText: language === 'en' ? /^Completed$/ : /^已完成$/ })
        .waitFor();
      assert.doesNotMatch(await work.innerText(), /已逾期|下一步|past the deadline|Next step/);
      await work.getByRole('button', { name: label('打开成果', 'Open artifact'), exact: true }).click();
      await page.getByText(fixture.sentinel, { exact: true }).waitFor();
      await page.getByRole('button', { name: /^(返回来源|Back to source)$/, exact: true }).click();
      await work
        .locator('span')
        .filter({ hasText: language === 'en' ? /^Completed$/ : /^已完成$/ })
        .waitFor();
      assert.equal(await work.getAttribute('data-selected'), 'true');
      await page.screenshot({ path: path.join(evidence, 'completed-mobile.png'), fullPage: true });
      await page.setViewportSize({ width: 1440, height: 1000 });
      await assertRecentArtifactReturnAndFailedRead(page, panel, fixture, language, evidence);
      fixture.republish();
      await panel.getByRole('button', { name: label('刷新', 'Refresh'), exact: true }).click();
      await work
        .getByText(label('交付材料未封存或已变更', 'Delivery materials are not archived or have changed'), {
          exact: true,
        })
        .waitFor();
      assert.equal(
        await work.getByRole('button', { name: label('打开成果', 'Open artifact'), exact: true }).count(),
        0,
      );
      fixture.unavailable(true);
      await panel.getByRole('button', { name: label('刷新', 'Refresh'), exact: true }).click();
      await panel
        .getByText(
          label('暂时无法读取工作与安排，请重试刷新。', 'Work and schedules are unavailable. Please refresh.'),
          { exact: true },
        )
        .waitFor();
      fixture.unavailable(false);
      await panel.getByRole('button', { name: label('刷新', 'Refresh'), exact: true }).click();
      await work.waitFor();
      assert.equal(globalCatalogReads, 0, 'opening a known work result must not depend on scanning all user artifacts');
      await page.setViewportSize({ width: 1440, height: 1000 });
      await page.getByTestId('workspace-panel-toggle').click();
      await reading.waitFor();
      const returnedReading = await readingSnapshot(page, true);
      await writeFile(path.join(evidence, 'j3-chat-reading-return.json'), JSON.stringify(returnedReading, null, 2));
      assert.equal(returnedReading.anchor?.id, originalReading.anchor.id);
      assert.ok(
        Math.abs(returnedReading.anchor.offset - originalReading.anchor.offset) <= 2,
        'original Chat reading point is preserved',
      );
      assert.equal(await composer.inputValue(), 'J3 原 Chat 草稿和选择位置');
      assert.deepEqual(await composer.evaluate((input) => [input.selectionStart, input.selectionEnd]), [3, 8]);
      await assertPersonalScheduleJourney(page, fixture, language, evidence);
      await assertPersonalMailboxRaces(page, fixture, language, evidence);
      await assertPersonalMailboxJourney(page, fixture, language, evidence);
      await assertApprovalHistoryJourney(page, fixture, language, evidence);
      t.diagnostic(
        JSON.stringify({
          baseUrl: base,
          defaultEntry: true,
          language,
          theme,
          chatFileOpen: true,
          exactHistory: true,
          downloads,
          productionWrites: 0,
          evidence,
        }),
      );
    } catch (error) {
      if (!page.isClosed()) {
        await writeReadingFailure(page, evidence);
      }
      await writeFile(
        path.join(evidence, 'j3-failure-state.json'),
        JSON.stringify(
          {
            sourceHead: process.env.F322_J3_SOURCE_HEAD ?? null,
            controlled: true,
            language,
            preferenceSnapshot: fixture.preferenceSnapshot(),
            mutations: fixture.mutations,
            targetDraft: fixture.getDraft(fixture.progress.threadId),
          },
          null,
          2,
        ),
      );
      throw error;
    }
  },
);
