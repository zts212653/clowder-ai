import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = fileURLToPath(new URL('../../../../artifacts/superagent-live', import.meta.url));
const entry = JSON.parse(await readFile(`${root}/active-entry.json`, 'utf8'));
const sources = JSON.parse(await readFile(`${root}/sample-sources.json`, 'utf8'));
const instance = JSON.parse(await readFile(`${root}/instance.json`, 'utf8'));
const origin = `http://127.0.0.1:${instance.webPort}`;
const api = `http://127.0.0.1:${instance.apiPort}`;
assert.ok(process.env.SUPERAGENT_ARCHIVE_PATH, 'the exact replacement artifact must be supplied');
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  storageState: `${root}/browser-state.json`,
  viewport: { width: 1440, height: 1000 },
});
await context.route(/^https?:\/\/(localhost|127\.0\.0\.1):\d+\//, async (route) => {
  const url = new URL(route.request().url());
  if (![String(instance.webPort), String(instance.apiPort)].includes(url.port)) return route.abort();
  await route.continue();
});
const page = await context.newPage();
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
const view = async () =>
  (await (await context.request.get(`${api}/api/plugin-conversations`)).json()).entries.find(
    (row) => row.instanceId === entry.instanceId,
  );
const works = async () => {
  const directory = await (await context.request.get(`${api}/api/threads`)).json();
  const tasks = (
    await Promise.all(
      directory.threads.map(
        async (thread) =>
          (await (await context.request.get(`${api}/api/tasks?threadId=${thread.id}&kind=work`)).json()).tasks ?? [],
      ),
    )
  ).flat();
  return tasks.filter((task) => task.subjectKey?.startsWith(`superagent:${entry.instanceId}:`));
};
const send = async (key, content) => {
  assert.equal(existsSync(`${root}/${key}.json`), false, 'observe the existing paid invocation before retrying');
  const hydrated = page.waitForResponse(
    (response) =>
      response.url().endsWith(`/api/threads/${sources[1].id}`) &&
      response.request().method() === 'GET' &&
      response.ok(),
  );
  await page.goto(`${origin}/thread/${sources[1].id}?shell=v2`, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await hydrated;
  await page.locator('textarea').last().fill('');
  await page.locator('textarea').last().pressSequentially(content, { delay: 1 });
  const publication = page.waitForResponse(
    (response) => response.url().endsWith('/api/messages') && response.request().method() === 'POST',
  );
  await page
    .getByRole('button', { name: /^(发送|发送消息)$/ })
    .last()
    .click();
  const response = await publication;
  assert.ok(response.ok(), await response.text());
  await writeFile(
    `${root}/${key}.json`,
    JSON.stringify(
      {
        threadId: sources[1].id,
        content,
        actualContent: response.request().postDataJSON().content,
        sentAt: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
  assert.equal(
    response.request().postDataJSON().content,
    content,
    'the actual human input must match the intended source',
  );
};
const until = async (predicate) => {
  const deadline = Date.now() + 8 * 60 * 1000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    const current = await view();
    if (current.status === 'error') throw new Error(current.detail);
    await page.waitForTimeout(5000);
  }
  throw new Error('Continuation did not reach its expected outcome; inspect the existing invocation');
};
try {
  await page.goto(`${origin}/settings?s=plugins&plugin=official.superagent&shell=v2`, {
    waitUntil: 'domcontentloaded',
    timeout: 90000,
  });
  if (!process.argv.includes('--installed')) {
    await page.getByRole('button', { name: /安装插件/ }).click();
    const uploaded = page.waitForResponse(
      (response) => response.url().endsWith('/install/upload') && response.request().method() === 'POST',
      { timeout: 120000 },
    );
    await page.locator('input[type=file]').first().setInputFiles(process.env.SUPERAGENT_ARCHIVE_PATH);
    const response = await uploaded;
    if (response.status() === 409) await page.getByRole('button', { name: '确认替换', exact: true }).click();
    else assert.ok(response.ok(), await response.text());
  }
  await page.getByRole('button', { name: '暂停新接单与派发', exact: true }).waitFor({ timeout: 120000 });
  await until(async () => (await view()).status === 'listening');
  const before = await works();
  const installed = (await (await context.request.get(`${api}/api/plugin-manager/plugins`)).json()).plugins.find(
    (plugin) => plugin.pluginId === 'official.superagent',
  );
  assert.equal(
    installed.packageDigest,
    `sha512-${createHash('sha512')
      .update(await readFile(process.env.SUPERAGENT_ARCHIVE_PATH))
      .digest('base64')}`,
  );
  assert.equal(before.length, 2);
  const paused = page.waitForResponse(
    (response) => response.url().endsWith('/actions/pause/pause') && response.request().method() === 'POST',
  );
  await page.getByRole('button', { name: '暂停新接单与派发', exact: true }).click();
  assert.ok((await paused).ok());
  await until(async () => (await view()).status === 'paused');
  assert.equal((await view()).threadId, entry.threadId);
  await page.screenshot({ path: `${root}/real-paused.png`, fullPage: true });
  const resumed = page.waitForResponse(
    (response) => response.url().endsWith('/actions/activity/enable') && response.request().method() === 'POST',
  );
  await page.getByRole('button', { name: '确认并开始跟进', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: '确认', exact: true }).click();
  assert.ok((await resumed).ok());
  await until(async () => (await view()).status === 'listening');
  await writeFile(
    `${root}/browser-lifecycle.json`,
    JSON.stringify(
      {
        verified: ['real-tgz-replacement', 'pause', 'resume', 'same-main-and-work'],
        mainThreadId: entry.threadId,
        taskIds: before.map((task) => task.id),
      },
      null,
      2,
    ),
  );
  console.log('Replacement, pause and resume preserved the Bot and both Work items');
  const clarify = process.argv.includes('--clarify');
  const feedback = clarify
    ? '上一条中 test draft only 是验收脚本遗留的草稿标记，我现在明确答复：正式接受 greeting.txt 原事项的结果；notes.md 保留 # 验收修订 和末尾单个换行。请助手沿 notes.md 原 Work 和原工作线程继续，让原执行成员只复核现有文件并通过插件回报结果，不再改文件、不新建事项、不提交发布。我会在收到该结果后明确接受 notes.md。当前来源会话的成员只转述反馈，请勿代替原工作线程执行或关闭 Task。'
    : `上次两项样例中，greeting.txt 的内容已读回验证，我接受这个结果；notes.md 需要沿原事项继续，把标题改为 # 验收修订 并保留末尾单个换行。请继续原 Work 和工作线程，不要新建事项。只修改 notes.md，不提交、不发布、不安装依赖，完成后回到本会话告知，等我接受。`;
  await send(clarify ? 'native-feedback-clarification' : 'native-feedback-request', feedback);
  console.log('Cross-conversation feedback submitted once');
  const note = before.find((task) => task.title.includes('notes.md'));
  const greeting = before.find((task) => task.title.includes('greeting.txt'));
  assert.ok(note && greeting);
  await until(async () => {
    const now = await works();
    assert.deepEqual(
      now.map((task) => task.id).sort(),
      before.map((task) => task.id).sort(),
      'feedback must preserve the original canonical Work',
    );
    const currentNote = now.find((task) => task.id === note.id);
    assert.equal(currentNote.threadId, note.threadId);
    return (
      (await readFile(`${root}/sample-work/notes.md`, 'utf8')) === '# 验收修订\n' &&
      now.find((task) => task.id === greeting.id)?.entrustedWork?.closure.state === 'satisfied' &&
      currentNote.entrustedWork?.progress?.summary?.includes('修订') &&
      currentNote.entrustedWork?.progress?.nextStep === '等待用户验收' &&
      currentNote.entrustedWork?.progress?.sourceRef !== note.entrustedWork?.progress?.sourceRef &&
      currentNote.status === 'blocked'
    );
  });
  assert.equal((await works()).find((task) => task.id === note.id).entrustedWork.closure.state, 'open');
  assert.equal(await readFile(`${root}/sample-work/greeting.txt`, 'utf8'), 'hello superagent\n');
  await send(
    'native-acceptance-request',
    '我已经读回 notes.md，确认标题为 # 验收修订、末尾单个换行。这个修改结果验收通过，我接受 notes.md 原事项的交付。',
  );
  await until(
    async () =>
      (await works()).every((task) => task.entrustedWork?.closure.state === 'satisfied') &&
      (await view()).badgeCount === 0,
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: `${root}/real-continuation-mobile.png`, fullPage: true });
  await writeFile(
    `${root}/native-continuation-result.json`,
    JSON.stringify(
      {
        verified: [
          'real-native-feedback',
          'cross-conversation-continuation',
          'same-task-and-worker-thread',
          'actual-revised-file',
          'original-conversation-result',
          'explicit-test-owner-acceptance',
          'badge-cleared',
        ],
        taskIds: before.map((task) => task.id),
        mainThreadId: entry.threadId,
        errors,
      },
      null,
      2,
    ),
  );
  assert.deepEqual(errors, []);
  console.log('Real feedback and acceptance completed on the same two Work items');
} finally {
  await page.screenshot({ path: `${root}/continuation-last.png`, fullPage: true });
  await writeFile(
    `${root}/continuation-last.txt`,
    `${await page.locator('body').innerText()}\nComposer: ${JSON.stringify(await page.locator('textarea').evaluateAll((nodes) => nodes.map((node) => ({ value: node.value, disabled: node.disabled }))))}`,
  );
  await browser.close();
}
