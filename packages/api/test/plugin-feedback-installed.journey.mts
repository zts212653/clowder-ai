import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { startInstalledFeedbackFixture, withPrivatePngMetadata } from './fixtures/feedback-installed-harness.mts';

const fixture = await startInstalledFeedbackFixture();
const { artifactRoot, playwright, url, targets, issues, ledger } = fixture;
const browser = await playwright.chromium.launch({
  headless: true,
  ...(process.env.FEEDBACK_CHROMIUM ? { executablePath: process.env.FEEDBACK_CHROMIUM } : {}),
});
let currentPage: Awaited<ReturnType<typeof browser.newPage>> | undefined;
const browserErrors: string[] = [];
try {
  const context = await browser.newContext({ viewport: { width: 1200, height: 980 }, acceptDownloads: true });
  await context.route('https://gitlab.example.test/**', (route: { fulfill(input: object): Promise<void> }) =>
    route.fulfill({ contentType: 'text/html', body: '<h1>Isolated Issue fixture</h1>' }),
  );
  const page = await context.newPage();
  currentPage = page;
  page.on('pageerror', (error: Error) => browserErrors.push(error.message));
  await page.addInitScript(
    'Object.defineProperty(navigator,"clipboard",{value:{writeText:async value=>{window.copied=value},write:async()=>{window.copiedImage=true}}});',
  );
  await page.goto(url);
  assert.equal(await page.locator('#workspace').innerHTML(), '');
  let png = Buffer.from(
    await page.evaluate(() => {
      const canvas = document.createElement('canvas');
      canvas.width = 512;
      canvas.height = 512;
      const context = canvas.getContext('2d')!;
      const pixels = context.createImageData(512, 512);
      for (let i = 0; i < pixels.data.length; i += 65536) crypto.getRandomValues(pixels.data.subarray(i, i + 65536));
      context.putImageData(pixels, 0, 0);
      return canvas.toDataURL('image/png').split(',')[1];
    }),
    'base64',
  );
  png = withPrivatePngMetadata(png);
  assert.ok(png.toString('base64').length > 1_048_576, 'large screenshot must exceed the actual CAS value budget');
  await page.getByRole('button', { name: '问题反馈', exact: true }).click();
  const panel = page.frameLocator('iframe[title="问题反馈"]');
  const newFeedback = () => panel.locator('header').getByRole('button', { name: '新建反馈', exact: true }).click();
  const history = () => panel.locator('header').getByRole('button', { name: '反馈记录', exact: true }).click();
  assert.equal(await panel.getByLabel('标题（选填）').inputValue(), '');
  assert.equal(await panel.getByText('请描述发生前的操作、实际现象与预期结果', { exact: false }).count(), 0);
  await panel.getByLabel('标题（选填）').fill('未投递的 Bug');
  await panel.getByLabel('描述').fill('第一条还没有投递');
  await panel.getByRole('button', { name: '保存草稿', exact: true }).click();
  await panel.getByText('草稿已保存到反馈记录', { exact: true }).waitFor();
  await page.getByRole('button', { name: '关闭插件面板', exact: true }).click();
  await page.getByRole('button', { name: '问题反馈', exact: true }).click();
  assert.equal(await panel.getByLabel('描述').inputValue(), '');
  await history();
  await panel
    .locator('.history-item')
    .filter({ hasText: 'bug: 未投递的 Bug' })
    .getByRole('button', { name: '继续填写' })
    .click();
  assert.equal(await panel.getByLabel('描述').inputValue(), '第一条还没有投递');
  await newFeedback();
  await panel.getByRole('radio', { name: '功能建议', exact: true }).check();
  await panel.getByLabel('标题（选填）').fill('独立的功能建议');
  await panel.getByLabel('描述').fill('希望支持批量导出');
  await page.screenshot({ path: join(artifactRoot, 'new-feedback.png'), fullPage: true });
  await history();
  await panel.locator('.history-item').filter({ hasText: 'feat: 独立的功能建议' }).waitFor();
  assert.equal(await panel.locator('.history-item').count(), 2);
  await page.screenshot({ path: join(artifactRoot, 'feedback-history.png'), fullPage: true });
  await panel
    .locator('.history-item')
    .filter({ hasText: 'bug: 未投递的 Bug' })
    .getByRole('button', { name: '继续填写' })
    .click();
  assert.equal(await panel.getByLabel('描述').inputValue(), '第一条还没有投递');
  await newFeedback();
  await panel.locator('input[type=file]').setInputFiles({ name: 'image-only.png', mimeType: 'image/png', buffer: png });
  await panel.getByRole('button', { name: '直接反馈', exact: true }).click();
  await panel.getByLabel('报告正文预览').waitFor();
  assert.equal(await panel.getByLabel('报告正文预览').innerText(), '');
  assert.equal(await panel.locator('.picture img').count(), 1);
  await newFeedback();
  await panel
    .getByLabel('标题（选填）')
    .fill('中文反馈测试')
    .catch(async (error) => {
      await page.screenshot({ path: join(artifactRoot, 'failure.png'), fullPage: true });
      await writeFile(
        join(artifactRoot, 'failure-dom.json'),
        JSON.stringify(
          {
            main: await page.content(),
            frames: await Promise.all(page.frames().map(async (f) => ({ url: f.url(), html: await f.content() }))),
          },
          null,
          2,
        ),
      );
      throw error;
    });
  await panel.getByLabel('描述').fill('点击按钮后超时 api_key=user-secret-canary');
  await panel.locator('input[type=file]').setInputFiles({ name: 'test.png', mimeType: 'image/png', buffer: png });
  await panel.getByRole('button', { name: '直接反馈', exact: true }).click();
  await panel.getByText('我已检查完整报告和所有图片').waitFor();
  const previewSource = await panel.locator('.picture img').getAttribute('src');
  const approvedPng = Buffer.from(previewSource!.split(',')[1], 'base64');
  assert.ok(!approvedPng.includes(Buffer.from('private-metadata-canary')));
  await panel.getByRole('button', { name: '复制报告正文', exact: true }).click();
  await page.waitForFunction(() => typeof (window as unknown as { copied?: string }).copied === 'string');
  assert.ok(
    !(await page.evaluate(() => (window as unknown as { copied: string }).copied)).includes('user-secret-canary'),
  );
  await panel.getByRole('button', { name: '复制图片', exact: true }).click();
  await page.waitForFunction(() => (window as unknown as { copiedImage: boolean }).copiedImage === true);
  assert.equal(await page.evaluate(() => (window as unknown as { copiedImage: boolean }).copiedImage), true);
  const downloadPromise = page.waitForEvent('download');
  await panel.getByRole('link', { name: '下载原图' }).click();
  const download = await downloadPromise;
  await download.saveAs(join(artifactRoot, 'downloaded.png'));
  assert.deepEqual(await readFile(join(artifactRoot, 'downloaded.png')), png);
  await panel.getByRole('checkbox', { name: '我已检查完整报告和所有图片' }).check();
  const popupPromise = page.waitForEvent('popup');
  await panel.getByRole('link', { name: '手动创建', exact: true }).click();
  const popup = await popupPromise;
  await popup.waitForLoadState();
  assert.equal(popup.url(), targets[0]!.issueCreateUrl);
  await popup.close();
  assert.equal(fixture.posts(), 0, 'manual navigation never creates an Issue');
  await panel.getByRole('button', { name: '确认上传', exact: true }).click();
  await panel.getByRole('link', { name: '打开 Issue', exact: true }).waitFor();
  assert.equal(
    await panel.getByRole('link', { name: '打开 Issue', exact: true }).getAttribute('href'),
    'https://gitlab.example.test/team/clowder-ai/-/issues/1',
  );
  assert.equal(fixture.posts(), 1);
  assert.deepEqual(fixture.uploadedBytes(), approvedPng, 'upload must match the reviewed send copy');
  assert.match(issues.get('1')!.description, /https:\/\/gitlab.example.test\/team\/clowder-ai\/uploads\//);
  await page.screenshot({ path: join(artifactRoot, 'automatic-result.png'), fullPage: true });
  await panel.getByRole('button', { name: '继续反馈', exact: true }).click();
  await panel.getByLabel('标题（选填）').fill('分析反馈测试');
  await panel.getByLabel('描述').fill('api_key=analysis-user-secret');
  await panel.getByRole('button', { name: '生成分析报告', exact: true }).click();
  await panel.getByText('查看将发送的脱敏材料', { exact: true }).click();
  await panel.getByLabel('脱敏分析材料').waitFor();
  const materials = await panel.getByLabel('脱敏分析材料').inputValue();
  assert.ok(
    !materials.includes('log-secret-canary') &&
      !materials.includes('Alice') &&
      !materials.includes('analysis-user-secret'),
  );
  await panel.getByRole('button', { name: '开始分析', exact: true }).click();
  await panel.getByRole('button', { name: '停止等待，保留草稿', exact: true }).click();
  await panel.getByRole('button', { name: '重新准备材料', exact: true }).click();
  await panel.getByRole('button', { name: '开始分析', exact: true }).click();
  const analysisFrame = await (await page.locator('iframe[title="问题反馈"]').elementHandle())!.contentFrame();
  assert.ok(analysisFrame);
  await analysisFrame.evaluate(() => {
    (window as unknown as { analysisNode: Element | null }).analysisNode = document.querySelector('.content');
  });
  await page.waitForTimeout(2200);
  assert.equal(
    await analysisFrame.evaluate(
      () => (window as unknown as { analysisNode: Element | null }).analysisNode === document.querySelector('.content'),
    ),
    true,
    'status polling must preserve the same content node',
  );
  await page.getByRole('button', { name: '关闭插件面板', exact: true }).click();
  await page.getByRole('button', { name: '问题反馈', exact: true }).click();
  await panel.getByLabel('标题（选填）').waitFor();
  assert.equal(await panel.getByLabel('标题（选填）').inputValue(), '', 'opening never occupies the new form');
  await panel.getByLabel('标题（选填）').fill('分析同时的新问题');
  await panel.getByLabel('描述').fill('另一条反馈独立保存');
  await history();
  const analysisRow = () => panel.locator('.history-item').filter({ hasText: 'bug: 分析反馈测试' });
  await analysisRow().getByText('分析完成 · 待投递', { exact: true }).waitFor();
  await panel
    .locator('.history-item')
    .filter({ hasText: 'bug: 分析同时的新问题' })
    .getByRole('button', { name: '继续填写' })
    .click();
  assert.equal(await panel.getByLabel('描述').inputValue(), '另一条反馈独立保存');
  await history();
  await analysisRow().getByRole('button', { name: '继续投递' }).click();
  await panel.getByText('我已检查完整报告和所有图片').waitFor();
  assert.equal(fixture.modelRuns(), 2, 'only the explicit restart invokes again; reopening does not');
  assert.ok(fixture.modelPrompt().endsWith(materials));
  assert.ok(!(await panel.getByLabel('报告正文预览').innerText()).includes('model-secret-canary'));
  assert.equal(await panel.getByRole('checkbox', { name: '同意将上述脱敏材料' }).count(), 0);
  await page.screenshot({ path: join(artifactRoot, 'analysis-report.png'), fullPage: true });
  await history();
  await panel
    .locator('.history-item')
    .filter({ hasText: 'bug: 分析同时的新问题' })
    .getByRole('button', { name: '继续填写' })
    .click();
  assert.equal(await panel.getByRole('button', { name: '查看本条分析报告', exact: true }).count(), 0);
  assert.equal(await panel.getByLabel('描述').inputValue(), '另一条反馈独立保存');
  await history();
  await panel
    .locator('.history-item')
    .filter({ hasText: 'bug: 分析后的标题' })
    .getByRole('button', { name: '继续投递' })
    .click();
  await page.setViewportSize({ width: 420, height: 850 });
  await page.screenshot({ path: join(artifactRoot, 'narrow-report.png'), fullPage: true });
  await page.setViewportSize({ width: 1200, height: 980 });
  fixture.failNextRead();
  await panel.getByRole('checkbox', { name: '我已检查完整报告和所有图片' }).check();
  await panel.getByRole('button', { name: '确认上传', exact: true }).click();
  const pendingLink = panel.getByRole('link', { name: /已创建，待核验/ });
  await pendingLink.waitFor();
  assert.match((await pendingLink.getAttribute('href')) ?? '', /\/issues\/2$/);
  assert.equal(fixture.posts(), 2);
  await page.screenshot({ path: join(artifactRoot, 'created-pending-readback.png'), fullPage: true });
  await newFeedback();
  await panel.getByLabel('标题（选填）').fill('待核对期间的新反馈');
  await panel.getByLabel('描述').fill('不会被旧投递锁住');
  await history();
  await panel
    .locator('.history-item')
    .filter({ hasText: '投递结果待核对' })
    .getByRole('button', { name: '核对结果' })
    .click();
  await panel.getByRole('button', { name: '核对提交结果', exact: true }).click();
  await panel.getByRole('link', { name: '打开 Issue', exact: true }).waitFor();
  assert.equal(fixture.posts(), 2, 'readback retry cannot create again');
  await panel.getByRole('button', { name: '继续反馈', exact: true }).click();
  await panel.getByLabel('标题（选填）').fill('部分附件失败');
  await panel.getByLabel('描述').fill('retain receipts');
  await panel.locator('input[type=file]').setInputFiles([
    { name: 'one.png', mimeType: 'image/png', buffer: png },
    { name: 'two.png', mimeType: 'image/png', buffer: png },
  ]);
  await panel.getByRole('button', { name: '直接反馈', exact: true }).click();
  await panel.getByRole('checkbox', { name: '我已检查完整报告和所有图片' }).check();
  fixture.failSecondUpload();
  await panel.getByRole('button', { name: '确认上传', exact: true }).click();
  await panel.getByRole('button', { name: '保留回执，返回编辑', exact: true }).waitFor();
  assert.equal(fixture.posts(), 2, 'partial attachment failure must not create an Issue');
  assert.ok(
    (await fixture.journals()).some(
      (value) =>
        value &&
        typeof value === 'object' &&
        'uploads' in value &&
        Array.isArray(value.uploads) &&
        value.uploads.length === 1,
    ),
  );
  await panel.getByRole('button', { name: '保留回执，返回编辑', exact: true }).click();
  await panel.getByLabel('标题（选填）').fill('恢复后可继续编辑');
  await writeFile(
    join(artifactRoot, 'receipt.json'),
    JSON.stringify(
      {
        checks: [
          'explicitly saved draft survives close and reopen',
          'opening a draft after an analyzed record clears the prior analysis',
          'blank new form instead of resuming an old report',
          'unfinished drafts coexist and switch without overwriting',
          'bug and feat title prefixes persist',
          'image-only feedback is accepted',
          'history exposes analysis completion waiting for delivery',
          'new feedback while an old analysis runs',
          'unknown delivery fences only its own feedback',
          'fresh npm archive install',
          'actual Host entry + opaque iframe',
          'manual popup without publication',
          'inline sanitized copy',
          'binary PNG copy',
          'original download SHA256',
          'automatic screenshot upload + remote readback URL',
          'prepared sanitized Agent input',
          'post-analysis sanitization',
          'ordinary analysis survives panel reopen without another invocation',
          'stopping the wait exposes a working prepare-again action',
          'narrow layout',
          'hidden PNG metadata excluded from send copy',
          'reviewed send copy equals uploaded bytes',
          'known Issue link shown while readback pending',
          'readback reconciliation never reposts',
          'partial upload receipt survives',
          'partial upload edit recovery without creating Issue',
          'large screenshot through real Host storage encoder',
          'polling preserves content DOM without busy flicker',
          'Markdown report preview without a redundant analysis checkbox',
        ],
        posts: fixture.posts(),
        archiveSha256: ledger.archiveSha256,
      },
      null,
      2,
    ),
  );
  process.stdout.write('PASS: 30 packed-plugin / Host browser journey checks\n');
} catch (error) {
  if (currentPage) {
    await currentPage.screenshot({ path: join(artifactRoot, 'failure.png'), fullPage: true });
    await writeFile(
      join(artifactRoot, 'failure-dom.json'),
      JSON.stringify(
        {
          errors: browserErrors,
          frames: await Promise.all(
            currentPage
              .frames()
              .map(async (f) => ({ url: f.url(), html: await f.content(), text: await f.locator('body').innerText() })),
          ),
        },
        null,
        2,
      ),
    );
  }
  throw error;
} finally {
  await browser.close();
  await fixture.stop();
}
