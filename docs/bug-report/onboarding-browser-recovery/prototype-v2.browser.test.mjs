import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const require = createRequire(resolve('packages/web/package.json'));
const { chromium } = require('playwright');
const root = resolve('docs/bug-report/onboarding-browser-recovery/artifacts/2026-10-08/prototype-v2');
const html = pathToFileURL(resolve('docs/design/bootcamp-onboarding-prototype-v2.html')).href;
await mkdir(root, { recursive: true });

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));

try {
  await page.goto(html);
  await page.getByRole('button', { name: '开始看演示' }).click();
  await page.waitForFunction(() => document.querySelector('#typed').value.length > 12);
  await page.getByRole('button', { name: '暂停' }).click();
  const pausedText = await page.locator('#typed').inputValue();
  await page.waitForTimeout(150);
  assert.equal(await page.locator('#typed').inputValue(), pausedText, '暂停应冻结自动打字');
  await page.screenshot({ path: resolve(root, '01-typing-paused.png'), fullPage: true });

  await page.getByRole('button', { name: '播放演示' }).click();
  await page.waitForFunction(() => document.querySelector('#typed').value.length > 25);
  await page.waitForFunction(() => document.querySelector('.scene[data-scene="5"]').classList.contains('active'), null, { timeout: 15000 });
  assert.match(await page.locator('.scene.active').innerText(), /刚才是演示/);
  assert.match(await page.locator('[data-scene="4"]').innerText(), /几只猫会互相搭把手/);
  await page.screenshot({ path: resolve(root, '02-collaboration-improved-result.png'), fullPage: true });

  await page.getByRole('button', { name: '下一步：配置我的伙伴' }).click();
  await page.locator('#fixture').selectOption('none');
  assert.equal(await page.locator('#confirmClients').isDisabled(), true, '零 client 不可越过配置门禁');
  assert.match(await page.locator('#clients').innerText(), /未检测到 client/);
  await page.screenshot({ path: resolve(root, '03-no-client-gate.png'), fullPage: true });

  await page.locator('#fixture').selectOption('one');
  assert.equal(await page.locator('#clients .client').count(), 1);
  assert.equal(await page.locator('#confirmClients').isDisabled(), false);
  await page.screenshot({ path: resolve(root, '03-one-client-ready.png'), fullPage: true });

  await page.locator('#fixture').selectOption('many');
  assert.equal(await page.locator('#clients .client').count(), 4);
  assert.equal(await page.locator('#confirmClients').isDisabled(), false);
  await page.locator('#clients [data-login]').click();
  assert.match(await page.locator('#clients').innerText(), /等待 CLI 登录完成/);
  for (const index of ['0', '1', '3']) {
    await page.locator(`#clients input[data-i="${index}"]`).uncheck();
  }
  assert.equal(await page.locator('#confirmClients').isDisabled(), true, 'pending client 不能绕过登录门禁');
  await page.locator('#clients [data-complete]').click();
  assert.equal(await page.locator('#confirmClients').isDisabled(), false);
  await page.locator('#clients input[data-i="2"]').check();
  await page.locator('#clients input[data-i="3"]').check();
  await page.locator('#confirmClients').click();
  assert.match(await page.locator('#handoffTitle').innerText(), /Kimi Code.*Gemini CLI/);
  assert.doesNotMatch(await page.locator('#handoffTitle').innerText(), /Claude Code|Codex/);
  await page.getByRole('button', { name: '进入真实主界面' }).click();
  const composer = page.locator('#message');
  assert.equal(await composer.isVisible(), true);
  assert.equal(await page.locator('#tip').isVisible(), true);
  const tipBox = await page.locator('#tip').boundingBox();
  const composerBox = await composer.boundingBox();
  assert.ok(tipBox.y + tipBox.height <= composerBox.y, '提醒不能遮挡输入框');
  await composer.fill('请帮我规划一个欢迎页面');
  await page.getByRole('button', { name: '发送' }).click();
  assert.match(await page.locator('#realChat').innerText(), /请帮我规划一个欢迎页面/);
  await page.screenshot({ path: resolve(root, '04-real-chat-and-nonblocking-tip.png'), fullPage: true });

  await page.getByRole('button', { name: '查看可选协作训练' }).click();
  const expected = ['需求卡', '页面方案', '文件与预览', '审查与改进', '交付清单'];
  for (let i = 0; i < expected.length; i += 1) {
    assert.match(await page.locator('#optionalBody').innerText(), new RegExp(expected[i]));
    const text = await page.locator('#optionalBody').innerText();
    if (i === 0) assert.match(text, /背景：.*目标：.*范围：.*验收：/s);
    if (i === 1) assert.match(text, /预约体验/);
    if (i === 2) assert.match(text, /welcome.html.*本地预览通过/s);
    if (i === 3) assert.match(text, /@ 缅因猫.*含义不清/s);
    if (i === 4) assert.match(text, /手机布局.*审查意见已处理/s);
    await page.screenshot({ path: resolve(root, `05-optional-stage-${i + 8}.png`), fullPage: true });
    await page.locator('#optionalAction').click();
  }
  assert.match(await page.locator('#optionalBody').innerText(), /阶段 8–12 · 已交付/);
  await page.screenshot({ path: resolve(root, '06-optional-journey-complete.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: resolve(root, '07-mobile-complete.png'), fullPage: true });
  await page.reload();
  assert.match(await page.locator('.scene.active').innerText(), /可选训练路径/);
  assert.match(await page.locator('#optionalBody').innerText(), /已交付/);
  assert.equal(await page.locator('#tip').isVisible(), false, '用户关闭的入口提醒刷新后不应重新出现');

  const bounds = await page.locator('.shell').evaluate((element) => ({
    scrollWidth: element.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  assert.ok(bounds.scrollWidth <= bounds.clientWidth + 1, `移动布局横向溢出: ${JSON.stringify(bounds)}`);
  assert.deepEqual(errors, [], `浏览器运行错误: ${errors.join('; ')}`);
  console.log(`PASS: demo, pause, zero/one/multiple client paths, login gate, handoff, free chat, optional stages 8-12, reload, mobile. Screenshots: ${root}`);
} finally {
  await browser.close();
}
