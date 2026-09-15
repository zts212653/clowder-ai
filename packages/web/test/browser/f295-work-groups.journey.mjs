import assert from 'node:assert/strict';
import { ensureWorkspaceOpen } from './f307-workspace-open.mjs';

export async function runWorkGroupsJourney({ browser, baseUrl, viewport, threadId, liveExecutions, fixtureForApi }) {
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const command = {
    kind: 'managed_command',
    executionId: 'hold-background',
    threadId,
    threadTitle: 'Parallel sampling',
    catId: 'codex-astra',
    activity: 'full_gate',
    startedAt: 200,
    cancelability: { state: 'cancelable', target: { kind: 'managed_command', taskId: 'hold-background' } },
  };
  let executions = [...liveExecutions, command];
  const cancellations = [];
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/debug/callback-auth') {
      return route.fulfill({
        status: 403,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'forbidden' }),
      });
    }
    let body;
    if (url.pathname === '/api/executions/active') {
      body = { projectPath: '/project/cat-cafe', executions };
    } else if (url.pathname.endsWith('/executions/live/shared-parent/cancel')) {
      const { catId } = route.request().postDataJSON();
      cancellations.push(['live_invocation', catId, url.pathname]);
      executions = executions.filter((item) => item.kind !== 'live_invocation' || item.catId !== catId);
      body = { ok: true, cancelled: true };
    } else if (url.pathname === '/api/callbacks/hold-ball/hold-background') {
      assert.equal(route.request().method(), 'DELETE');
      cancellations.push(['managed_command', 'hold-background']);
      executions = executions.filter((item) => item.executionId !== 'hold-background');
      body = { ok: true, cancelled: true };
    } else {
      body = fixtureForApi(url);
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  });
  try {
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
    await page.getByRole('navigation', { name: '主导航' }).waitFor({ timeout: 20_000 });
    await page.locator('[data-chat-container]').waitFor();
    await ensureWorkspaceOpen(page);
    const surface = page.getByTestId('workspace-developing');
    await surface.getByRole('heading', { name: '2 件工作正在进行', exact: true }).waitFor();
    const rows = surface.getByTestId('workspace-running-object');
    assert.equal(await rows.count(), 2, 'a live turn and its background command share one cat/thread work row');
    const astra = rows.filter({ hasText: 'codex-astra' });
    assert.equal(await astra.count(), 1);
    assert.equal(await astra.getByRole('link', { name: 'Chat', exact: true }).count(), 1);
    assert.equal(await astra.getByTestId('workspace-running-activity').count(), 2);
    await astra.getByText('回复中', { exact: true }).waitFor();
    await astra.getByText('后台 · 全量门禁', { exact: true }).waitFor();
    await page.screenshot({ path: `/tmp/f295-work-groups-${viewport.width}.png` });

    await astra.getByRole('button', { name: 'Stop codex-astra live_invocation shared-parent', exact: true }).click();
    await astra.getByText('等待后台完成 · 全量门禁', { exact: true }).waitFor();
    assert.equal(await rows.count(), 2, 'stopping the turn preserves background work and the other cat');
    assert.equal(await astra.getByTestId('workspace-open-running-object').count(), 0);
    const stopCommand = astra.getByRole('button', {
      name: 'Stop codex-astra managed_command hold-background',
      exact: true,
    });
    assert.equal(await stopCommand.isEnabled(), true);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await ensureWorkspaceOpen(page);
    await astra.getByText('等待后台完成 · 全量门禁', { exact: true }).waitFor();
    assert.equal(await rows.count(), 2, 'reload keeps the grouped work count and waiting state');
    await astra.getByRole('link', { name: 'Chat', exact: true }).click();
    await page.waitForURL(`**/thread/${threadId}`);
    await page.getByTestId('f307-experience-workbench').waitFor({ state: 'hidden' });
    await ensureWorkspaceOpen(page);
    await stopCommand.click();
    await surface.getByRole('heading', { name: '一件工作正在进行', exact: true }).waitFor();
    assert.equal(await rows.count(), 1);
    assert.match(await rows.first().innerText(), /fable5/);
    assert.deepEqual(cancellations, [
      ['live_invocation', 'codex-astra', `/api/threads/${threadId}/executions/live/shared-parent/cancel`],
      ['managed_command', 'hold-background'],
    ]);
    assert.deepEqual(errors, []);
    console.log(
      `F295 work groups: ${baseUrl} (${viewport.width}px), 3 executions → 2 work rows; exact stops + reload PASS`,
    );
  } catch (error) {
    console.error('F295 work-group failure:', {
      url: page.url(),
      errors,
      body: (await page.locator('body').innerText()).slice(0, 6000),
    });
    await page.screenshot({ path: `/tmp/f295-work-groups-failure-${viewport.width}.png` });
    throw error;
  } finally {
    await context.close();
  }
}
