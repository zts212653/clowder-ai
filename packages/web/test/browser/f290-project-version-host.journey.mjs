import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { chromium } from 'playwright';
import { expressionHostFixture } from './f290-expression-voice.fixture.mjs';
import { projectVersionFixture } from './f290-project-version-reference.fixture.mjs';

test(
  'real Host keeps exact original versions in common Workspace tabs, compares and returns to the project',
  { timeout: 240_000 },
  async (t) => {
    const host = await expressionHostFixture({ appearanceControls: true });
    t.after(() => host.close());
    const f = await projectVersionFixture({ allowedHostOrigins: [host.url], projectChannelId: 'project-room' });
    t.after(() => f.close());
    host.setService(f.url, {
      serviceInstanceId: f.coordinates.serviceInstanceId,
      connections: await f.connector.listConnections(),
    });
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    await context.addInitScript(
      ({ origin, token, hostOrigin }) => {
        if (location.origin === origin) sessionStorage.setItem(`collective-session:${origin}`, token);
        if (location.origin === hostOrigin) localStorage.setItem('cat-cafe:shell-presentation', 'v2');
      },
      { origin: f.url, token: f.creator.sessionToken, hostOrigin: host.url },
    );
    const page = await context.newPage(),
      errors = [];
    page.setDefaultTimeout(20_000);
    page.on('pageerror', (error) => errors.push(error.message));
    const output = process.env.F290_BATCH3_EVIDENCE_DIR;
    if (output) await mkdir(output, { recursive: true });
    t.after(async () => {
      if (output && !page.isClosed()) {
        await mkdir(output, { recursive: true });
        await page.screenshot({ path: join(output, 'host-last-state.png'), fullPage: true, animations: 'disabled' });
        await writeFile(join(output, 'host-browser-errors.json'), JSON.stringify(errors, null, 2));
        await writeFile(join(output, 'host-last-dom.txt'), await page.locator('body').innerText());
        for (const [index, child] of page.frames().entries())
          if (child !== page.mainFrame())
            await writeFile(join(output, `host-frame-${index}.txt`), await child.locator('body').innerText());
      }
      await context.close();
      await browser.close();
    });
    await page.goto(host.url + '/collective', { waitUntil: 'networkidle' });
    const frame = page.frameLocator('iframe[title="Collective"]');
    const browse = frame.getByRole('button', { name: /先逛逛|Browse first/ });
    await Promise.any([browse.waitFor(), frame.getByRole('button', { name: /^项目$|^Projects$/ }).waitFor()]);
    if (await browse.isVisible()) await browse.click();
    await frame.getByRole('button', { name: /^项目$|^Projects$/ }).click();
    await frame.getByRole('button', { name: new RegExp(`打开项目 · ${f.a.title}`) }).click();
    await frame.getByRole('button', { name: /^作品/ }).click();
    await frame.getByRole('button', { name: '引用作品…', exact: true }).click();
    await frame
      .getByRole('dialog')
      .getByRole('button', { name: /插件接入指南/ })
      .click();
    const attach = frame.getByRole('dialog', { name: '引用作品', exact: true });
    await attach.getByRole('combobox').selectOption('2');
    await attach.getByRole('button', { name: '引用 v2', exact: true }).click();
    await attach.waitFor({ state: 'hidden' });
    await f.publish(4, '补充 Windows 路径');
    await frame.getByText('有新版 v4', { exact: true }).waitFor();
    await frame.getByRole('button', { name: '打开本项目用的 v2', exact: true }).click();
    const surface = page.locator('[data-testid="collective-document-surface"]:visible');
    await surface
      .getByTestId('workspace-file-viewer')
      .getByText(/正文标记 OWNER-V2/)
      .waitFor();
    assert.equal(
      await surface
        .getByTestId('workspace-file-viewer')
        .getByText(/正文标记 OWNER-V4/)
        .count(),
      0,
    );
    assert.ok(
      (await page.getByTestId('f307-workbench').count()) ||
        (await page.locator('[data-workbench-surface-id]').count()) ||
        (await page.getByRole('tab').count()),
    );
    if (output)
      await page.screenshot({
        path: join(output, 'host-original-v2-1440.png'),
        fullPage: true,
        animations: 'disabled',
      });
    await surface.getByRole('button', { name: '返回原项目', exact: true }).click();
    await frame.getByRole('button', { name: '打开本项目用的 v2', exact: true }).waitFor();
    await frame.getByRole('button', { name: '换用…', exact: true }).click();
    const swap = frame.getByRole('dialog', { name: '换用作品版本', exact: true });
    await swap.getByText('补充 Windows 路径', { exact: true }).waitFor();
    await swap.getByRole('button', { name: '并排比较这两版', exact: true }).click();
    await surface
      .locator('[data-owner-revision="2"]')
      .getByText(/OWNER-V2/)
      .waitFor();
    await surface
      .locator('[data-owner-revision="4"]')
      .getByText(/OWNER-V4/)
      .waitFor();
    if (output)
      await page.screenshot({
        path: join(output, 'host-compare-v2-v4-1440.png'),
        fullPage: true,
        animations: 'disabled',
      });
    const discussionRead = page.waitForResponse((response) => {
      if (new URL(response.url()).pathname !== '/api/artifacts/owner/request' || response.status() !== 200)
        return false;
      const request = response.request().postDataJSON();
      return request?.action === 'read' && request.ownerRevision === 4;
    });
    await surface
      .locator('[data-owner-revision="4"]')
      .getByRole('button', { name: '讨论、批注与请猫修改', exact: true })
      .click();
    const original = await (await discussionRead).json();
    assert.equal(original.value.ownerRevision, 4);
    assert.match(original.value.text, /正文标记 OWNER-V4/);
    await frame
      .locator('.shared-artifact-footer')
      .getByText(/第 4 版/)
      .waitFor();
    if (output)
      await page.screenshot({
        path: join(output, 'host-compare-v4-discussion-1440.png'),
        fullPage: true,
        animations: 'disabled',
      });
    await frame.getByRole('button', { name: '返回原项目', exact: true }).click();
    await frame.getByRole('button', { name: '打开本项目用的 v2', exact: true }).waitFor();
    await frame.getByRole('button', { name: '换用…', exact: true }).click();
    await swap.getByRole('button', { name: '并排比较这两版', exact: true }).click();
    await surface
      .locator('[data-owner-revision="4"]')
      .getByText(/OWNER-V4/)
      .waitFor();
    await surface.getByRole('button', { name: '版本记录', exact: true }).click();
    await surface.getByRole('region', { name: '版本记录' }).getByText('加入首次启动说明', { exact: true }).waitFor();
    await surface.getByRole('region', { name: '版本记录' }).getByRole('button', { name: 'v3', exact: true }).click();
    await surface
      .locator('[data-owner-revision="3"]')
      .getByText(/OWNER-V3/)
      .waitFor();
    await surface.getByRole('button', { name: '返回原项目', exact: true }).click();
    await frame.getByRole('button', { name: '换用…', exact: true }).click();
    await swap.getByRole('button', { name: '换用 v4', exact: true }).click();
    await swap.waitFor({ state: 'hidden' });
    await frame.getByRole('button', { name: '打开本项目用的 v4', exact: true }).click();
    await surface
      .getByTestId('workspace-file-viewer')
      .getByText(/正文标记 OWNER-V4/)
      .waitFor();
    f.setOwnerAvailable(false);
    await page.locator('[data-testid="collective-document-unavailable"]:visible').waitFor({ timeout: 30_000 });
    assert.equal(await page.getByText(/正文标记 OWNER-V4/).count(), 0);
    f.setOwnerAvailable(true);
    await surface
      .getByTestId('workspace-file-viewer')
      .getByText(/正文标记 OWNER-V4/)
      .waitFor({ timeout: 30_000 });
    const selectedParagraph = surface.getByTestId('workspace-file-viewer').getByText(/正文标记 OWNER-V4/);
    await selectedParagraph.evaluate((element) => {
      const range = document.createRange();
      range.selectNodeContents(element);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      document.dispatchEvent(new Event('selectionchange'));
      element.dispatchEvent(new MouseEvent('pointerup', { bubbles: true }));
    });
    await page.getByTestId('workspace-markdown-selection-add-to-chat').click();
    await frame
      .getByRole('group', { name: '作品引用', exact: true })
      .getByText(/第 4 版/)
      .waitFor();
    const comment = '请把这段说明写得更清楚，先保留为草稿。';
    const quoteGroup = frame.getByRole('group', { name: '作品引用', exact: true });
    const composer = frame.locator('form.composer').filter({ has: quoteGroup });
    await composer.locator('textarea').fill(comment);
    assert.equal(await composer.locator('textarea').inputValue(), comment);
    assert.equal(
      (await f.store.listEventsForHuman(f.creator.sessionToken, f.coordinates.collectiveId)).filter(
        (event) => event.body === comment,
      ).length,
      0,
    );
    if (output)
      await page.screenshot({
        path: join(output, 'host-original-composer-draft.png'),
        fullPage: true,
        animations: 'disabled',
      });

    await frame.getByRole('button', { name: '返回原项目', exact: true }).click();
    await frame.getByRole('button', { name: '打开本项目用的 v4', exact: true }).waitFor();
    await page.reload({ waitUntil: 'networkidle' });
    const reopenProject = async () => {
      await frame.getByRole('button', { name: /^项目$|^Projects$/ }).click();
      await frame
        .getByRole('button', { name: new RegExp(`打开项目 · ${f.a.title}|Open project · ${f.a.title}`) })
        .click();
      await frame.getByRole('button', { name: /^作品|^Works/ }).click();
      await frame.getByRole('button', { name: '打开本项目用的 v4', exact: true }).click();
      await surface
        .getByTestId('workspace-file-viewer')
        .getByText(/正文标记 OWNER-V4/)
        .waitFor();
    };
    await reopenProject();
    await surface.getByRole('button', { name: '讨论、批注与请猫修改', exact: true }).click();
    await quoteGroup.getByText(/第 4 版/).waitFor();
    assert.equal(await composer.locator('textarea').inputValue(), comment);
    assert.equal(
      (await f.store.listEventsForHuman(f.creator.sessionToken, f.coordinates.collectiveId)).filter(
        (event) => event.body === comment,
      ).length,
      0,
    );
    await composer.getByRole('button', { name: '发送', exact: true }).click();
    let feedback;
    for (let attempt = 0; attempt < 100; attempt++) {
      feedback = (await f.store.listEventsForHuman(f.creator.sessionToken, f.coordinates.collectiveId)).filter(
        (event) => event.body === comment,
      );
      if (feedback.length) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(feedback.length, 1);
    await frame.getByRole('button', { name: '返回原项目', exact: true }).click();
    await frame.getByRole('button', { name: '打开本项目用的 v4', exact: true }).click();
    await surface
      .getByTestId('workspace-file-viewer')
      .getByText(/正文标记 OWNER-V4/)
      .waitFor();
    await surface.getByText(/批注 · 1/).waitFor();
    const beforeAccess = f.store
      .listArtifacts(f.creator.sessionToken, f.coordinates)
      .find((artifact) => artifact.artifactId === f.artifact.artifactId);
    await f.store.revokeArtifactAccess(f.creator.sessionToken, {
      ...f.coordinates,
      artifactId: f.artifact.artifactId,
      humanId: f.creator.human.humanId,
      expectedAccessRevision: beforeAccess.accessRevision,
      requestId: 'browser-revoke-reader',
    });
    await page.locator('[data-testid="collective-document-unavailable"]:visible').waitFor();
    assert.equal(await surface.count(), 0);
    await f.store.updateArtifactAccess(f.creator.sessionToken, {
      ...f.coordinates,
      artifactId: f.artifact.artifactId,
      humanId: f.creator.human.humanId,
      expectedAccessRevision: beforeAccess.accessRevision + 1,
      requestId: 'browser-restore-reader',
      access: beforeAccess.canApply ? 'apply' : 'read',
    });
    await surface
      .getByTestId('workspace-file-viewer')
      .getByText(/正文标记 OWNER-V4/)
      .waitFor();
    const serviceId = f.coordinates.serviceInstanceId,
      artifactId = f.artifact.artifactId;
    await f.restartOwner();
    await f.restart();
    await page.reload({ waitUntil: 'networkidle' });
    await reopenProject();
    assert.equal(f.store.serviceInstanceId, serviceId);
    assert.equal(f.artifact.artifactId, artifactId);
    await surface.getByText(/批注 · 1/).waitFor();
    await page.getByRole('button', { name: 'English', exact: true }).click();
    await surface.getByRole('button', { name: 'Back to project', exact: true }).waitFor();
    await page.getByRole('button', { name: 'Dark', exact: true }).click();
    await page.setViewportSize({ width: 390, height: 844 });
    const discussionBox = await surface
      .getByRole('button', { name: 'Discuss, annotate or request a change', exact: true })
      .boundingBox();
    assert.ok(discussionBox && discussionBox.height <= 36);
    if (output)
      await page.screenshot({
        path: join(output, 'host-original-v4-en-dark-390.png'),
        fullPage: true,
        animations: 'disabled',
      });
    await surface.getByRole('button', { name: 'Back to project', exact: true }).click();
    await frame.getByRole('button', { name: 'Open this project’s v4', exact: true }).waitFor();
    assert.equal(await frame.locator('html').evaluate((element) => element.scrollWidth > innerWidth), false);
    const share = frame.getByRole('button', { name: /Share material|分享材料/ });
    const shareBox = await share.boundingBox();
    assert.ok(shareBox && shareBox.height < 45);
    if (output)
      await page.screenshot({
        path: join(output, 'host-project-v4-en-dark-390.png'),
        fullPage: true,
        animations: 'disabled',
      });
    await frame.getByRole('button', { name: /New task|新建任务/, exact: true }).click();
    const taskForm = frame.locator('.project-authoring-form:visible');
    const formBox = await taskForm.boundingBox();
    assert.ok(formBox && formBox.width > 300);
    if (output)
      await page.screenshot({
        path: join(output, 'host-project-new-task-en-dark-390.png'),
        fullPage: true,
        animations: 'disabled',
      });
    await page.getByRole('button', { name: '中文', exact: true }).click();
    await page.getByRole('button', { name: 'Light', exact: true }).click();
    await frame.locator('html[data-theme="light"]').waitFor();
    if (output)
      await page.screenshot({
        path: join(output, 'host-project-new-task-zh-light-390.png'),
        fullPage: true,
        animations: 'disabled',
      });
    assert.deepEqual(errors, []);
  },
);
