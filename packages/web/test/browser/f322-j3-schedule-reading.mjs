import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';

export async function readingSnapshot(page, settled = false) {
  if (settled) {
    await readingSnapshot(page);
    await page.evaluate(() => {
      window.__j3ChatSettling = null;
    });
    await page.waitForFunction(() => {
      const port = document.querySelector('[data-chat-container]');
      const viewport = port.getBoundingClientRect();
      const row = [...port.querySelectorAll('[data-message-id]')].find((row) => {
        const bounds = row.getBoundingClientRect();
        return bounds.bottom > viewport.top + 1 && bounds.top < viewport.bottom;
      });
      const key = JSON.stringify([
        port.scrollTop,
        port.scrollHeight,
        port.clientHeight,
        port.clientWidth,
        row?.dataset.messageId,
        row ? row.getBoundingClientRect().top - viewport.top : null,
      ]);
      const current = window.__j3ChatSettling;
      if (current?.key !== key) window.__j3ChatSettling = { key, since: performance.now() };
      return current?.key === key && performance.now() - current.since >= 150;
    });
  }
  return page.locator('[data-chat-container]').evaluate((port) => {
    const snapshot = () => {
      const viewport = port.getBoundingClientRect();
      const anchor = [...port.querySelectorAll('[data-message-id]')]
        .map((row) => ({
          id: row.dataset.messageId,
          top: row.getBoundingClientRect().top,
          bottom: row.getBoundingClientRect().bottom,
        }))
        .find((row) => row.bottom > viewport.top + 1 && row.top < viewport.bottom);
      return {
        scrollTop: port.scrollTop,
        scrollHeight: port.scrollHeight,
        height: port.clientHeight,
        width: port.clientWidth,
        anchor: anchor ? { id: anchor.id, offset: anchor.top - viewport.top } : null,
      };
    };
    const record = (event) => {
      const trace = (window.__j3ChatReadingTrace ??= []);
      if (trace.length < 100) trace.push({ event, time: performance.now(), ...snapshot() });
    };
    if (!port.__j3ReadingObserved) {
      port.__j3ReadingObserved = true;
      port.addEventListener('scroll', () => record('scroll'));
      new ResizeObserver(() => record('resize')).observe(port);
    }
    record('snapshot');
    return snapshot();
  });
}

export async function writeReadingFailure(page, evidence) {
  await page.screenshot({ path: path.join(evidence, 'j3-journey-failure.png'), fullPage: true });
  await writeFile(path.join(evidence, 'j3-journey-failure.html'), await page.content());
  await writeFile(
    path.join(evidence, 'j3-chat-reading-trace.json'),
    JSON.stringify(await page.evaluate(() => window.__j3ChatReadingTrace ?? []), null, 2),
  );
}

export async function assertMobileScheduleControls(page, panel, fixture, language) {
  const list = panel.getByTestId('schedule-unscheduled');
  const todo = list.locator('[data-schedule-state="todo"]');
  const summary = todo.locator(':scope > summary');
  await summary.scrollIntoViewIfNeeded();
  const wasOpen = await todo.evaluate((element) => element.open);
  await summary.press('Enter');
  assert.equal(await todo.evaluate((element) => element.open), !wasOpen);
  if (wasOpen) await summary.press('Enter');
  const last = list.locator(`[data-subject-ref="task:work:${fixture.undatedSampleIds.at(-1)}"] h3`);
  await last.scrollIntoViewIfNeeded();
  const lastBounds = await last.boundingBox();
  assert.ok(lastBounds && lastBounds.y >= 0 && lastBounds.y + lastBounds.height <= page.viewportSize().height);
  const recent = panel.getByTestId('schedule-recent-completed');
  await recent.getByRole('heading').scrollIntoViewIfNeeded();
  const recentBounds = await recent.getByRole('heading').boundingBox();
  assert.ok(recentBounds && recentBounds.y >= 0 && recentBounds.y + recentBounds.height <= page.viewportSize().height);
  await recent
    .getByText(language === 'en' ? 'No completions recorded in the last 7 days' : '最近 7 天暂无完成记录', {
      exact: true,
    })
    .waitFor();
}

export async function assertDifferentArtifactReadFailure(page, panel, fixture, language, evidence) {
  const list = panel.getByTestId('schedule-unscheduled');
  const previous = list.locator(`[data-subject-ref="task:work:${fixture.undatedSampleIds[9]}"]`);
  const attempted = list.locator(`[data-subject-ref="task:work:${fixture.undatedBlockedId}"]`);
  assert.equal(await previous.getAttribute('data-selected'), 'true');
  const open = attempted.getByRole('button', {
    name: language === 'en' ? 'Open artifact' : '打开成果',
    exact: true,
  });
  await open.scrollIntoViewIfNeeded();
  const departure = await list.evaluate((port) => port.scrollTop);
  fixture.forbidCatalog(true);
  const denied = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === `/api/threads/${fixture.threadId}/artifacts` && response.status() === 403,
  );
  await open.click();
  await denied;
  await page.getByRole('alert').filter({ hasText: '这份内容已更新或暂时不可用' }).waitFor();
  const returned = await list.evaluate((port) => port.scrollTop);
  assert.equal(await previous.getAttribute('data-selected'), 'true', 'failed read leaves the original descriptor');
  await writeFile(
    path.join(evidence, 'j3-different-artifact-failed-read.json'),
    JSON.stringify({ selected: fixture.undatedSampleIds[9], attempted: fixture.undatedBlockedId, departure, returned }),
  );
  assert.ok(Math.abs(returned - departure) <= 2, 'failed B read must not reveal the previous selected A');
  fixture.forbidCatalog(false);
  await page.getByRole('alert').getByRole('button', { name: '刷新', exact: true }).click();
}

export async function assertRecentArtifactReturnAndFailedRead(page, panel, fixture, language, evidence) {
  const label = (zh, en) => (language === 'en' ? en : zh);
  await panel.getByRole('button', { name: label('当前工作', 'Current work'), exact: true }).click();
  const recent = panel.getByTestId('schedule-recent-completed');
  const item = recent.locator(`[data-subject-ref="task:work:${fixture.taskId}"]`);
  await item.waitFor();
  await panel.getByRole('button', { name: label('月', 'Month'), exact: true }).click();
  await panel.getByRole('button', { name: label('下个月', 'Next month'), exact: true }).click();
  const calendar = panel.getByRole('region', { name: label('工作日历', 'Work calendar'), exact: true });
  const day = calendar.locator('[data-calendar-date]').nth(10);
  const selectedDay = await day.getAttribute('data-calendar-date');
  await day.press('Enter');
  const calendarText = await calendar.innerText();
  assert.match(
    await panel.getByTestId('schedule-worklist').getByRole('heading').first().innerText(),
    /未排期工作|unscheduled work/,
  );
  const open = item.getByRole('button', { name: label('打开成果', 'Open artifact'), exact: true });
  await open.scrollIntoViewIfNeeded();
  await recent.hover();
  await page.mouse.wheel(0, 80);
  await page.waitForFunction(() => document.querySelector('[data-testid="schedule-recent-completed"]').scrollTop > 0);
  const originTop = await recent.evaluate((element) => element.scrollTop);
  assert.ok(originTop > 0, 'the original recent-completion port really scrolls');
  await open.click();
  await page.getByText(fixture.sentinel, { exact: true }).waitFor();
  await page.getByRole('button', { name: /^(返回来源|Back to source)$/ }).click();
  await recent.waitFor();
  assert.equal(await calendar.getAttribute('data-view'), 'month');
  assert.equal(await calendar.innerText(), calendarText);
  assert.equal(await calendar.locator(`[data-calendar-date="${selectedDay}"]`).getAttribute('aria-pressed'), 'true');
  assert.equal(await item.getAttribute('data-selected'), 'true');
  const returnTop = await recent.evaluate((element) => element.scrollTop);
  assert.ok(Math.abs(returnTop - originTop) <= 2);
  fixture.forbidCatalog(true);
  const denied = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === `/api/threads/${fixture.threadId}/artifacts` && response.status() === 403,
  );
  await open.click();
  await denied;
  await page.getByRole('alert').filter({ hasText: '这份内容已更新或暂时不可用' }).waitFor();
  assert.equal(await calendar.getAttribute('data-view'), 'month');
  assert.equal(await item.getAttribute('data-selected'), 'true');
  const failedTop = await recent.evaluate((element) => element.scrollTop);
  await recent.hover();
  await page.mouse.wheel(0, -80);
  await page.waitForFunction(
    (before) => document.querySelector('[data-testid="schedule-recent-completed"]').scrollTop < before,
    failedTop,
  );
  const userTop = await recent.evaluate((element) => element.scrollTop);
  await page.setViewportSize({ width: 1420, height: 1000 });
  await page.setViewportSize({ width: 1440, height: 1000 });
  const afterResize = await recent.evaluate((element) => element.scrollTop);
  assert.ok(Math.abs(afterResize - userTop) <= 2, 'a failed read must not replay the old local reading point');
  await writeFile(
    path.join(evidence, 'j3-recent-and-failed-read.json'),
    JSON.stringify(
      { originTop, returnTop, failedTop, userTop, afterResize, selectedDay, originalReadStatus: 403 },
      null,
      2,
    ),
  );
  await page.screenshot({ path: path.join(evidence, 'j3-recent-and-failed-read.png') });
  fixture.forbidCatalog(false);
  await page.getByRole('alert').getByRole('button', { name: '刷新', exact: true }).click();
  await panel.getByRole('button', { name: label('已完成', 'Completed'), exact: true }).click();
}
