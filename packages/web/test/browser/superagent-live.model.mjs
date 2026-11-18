import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = fileURLToPath(new URL('../../../../artifacts/superagent-live', import.meta.url));
const entry = JSON.parse(await readFile(`${root}/active-entry.json`, 'utf8'));
const origin = 'http://127.0.0.1:5220';
const api = 'http://127.0.0.1:3219';
const sample = `${root}/sample-work`.replaceAll('\\', '/');
const retry = process.argv.includes('--retry-after-queue-fix');
const observe = process.argv.includes('--observe-existing');
const requestPath = `${root}/${retry ? 'native-retry-request' : 'native-request'}.json`;
if (!observe) assert.equal(existsSync(requestPath), false, 'inspect the original invocation before another paid test');
if (retry) assert.ok(existsSync(`${root}/native-request.json`), 'retry requires the failed original request');
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  storageState: `${root}/browser-state.json`,
  viewport: { width: 1440, height: 1000 },
});
const page = await context.newPage();
await page.route('**/*', async (route) => {
  const url = new URL(route.request().url());
  if (['localhost', '127.0.0.1'].includes(url.hostname) && !['3219', '5220'].includes(url.port)) return route.abort();
  await route.continue();
});
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
try {
  await page.goto(`${origin}/thread/${entry.threadId}?shell=v2`, { waitUntil: 'domcontentloaded', timeout: 90000 });
  const input = page.locator('textarea').last();
  await input.waitFor({ timeout: 60000 });
  const original = retry ? JSON.parse(await readFile(`${root}/native-request.json`, 'utf8')) : undefined;
  const content = original
    ? `上次两件事都还没有开始，请沿原委托继续跟进，不要重复建项。原委托：${original.content}`
    : `作为我的 Superagent，请接住两件独立小事并分别交给工作线程：一，在 ${sample} 写 greeting.txt，内容为 hello superagent 并带一个换行，读取验证；二，在同目录写 notes.md，内容为 # 验收样例 并带一个换行，检查标题。只改这两个样例文件，不提交、不发布、不安装依赖，完成后带回结果等我验收。`;
  if (!observe) {
    await input.fill(content);
    await page
      .getByRole('button', { name: /^(发送|发送消息)$/ })
      .last()
      .click();
    await writeFile(
      requestPath,
      JSON.stringify(
        {
          mainThreadId: entry.threadId,
          content,
          sentAt: new Date().toISOString(),
          memberId: 'codex-acceptance',
          nativeStateRoot: `${root}/home/.codex`,
          retryReason: retry
            ? 'original native turn found no subscription inbox; Queue publication has now been fixed'
            : undefined,
        },
        null,
        2,
      ),
    );
    console.log('Real user request submitted; coordinator judgment and both workers use the configured native member');
  }
  const deadline = Date.now() + 8 * 60 * 1000;
  let previous = '';
  while (Date.now() < deadline) {
    const directory = await (await context.request.get(`${api}/api/threads`)).json();
    const threads = directory.threads ?? directory;
    const tasks = (
      await Promise.all(
        threads.map(
          async (thread) =>
            (await (await context.request.get(`${api}/api/tasks?threadId=${thread.id}&kind=work`)).json()).tasks ?? [],
        ),
      )
    )
      .flat()
      .filter((task) => task.subjectKey?.startsWith(`superagent:${entry.instanceId}:`));
    const status = JSON.stringify(
      tasks.map((task) => ({
        id: task.id,
        title: task.title,
        status: task.status,
        closure: task.entrustedWork?.closure.state,
      })),
    );
    if (status !== previous) {
      console.log(status);
      previous = status;
    }
    const current = (await (await context.request.get(`${api}/api/plugin-conversations`)).json()).entries.find(
      (row) => row.pluginId === 'official.superagent',
    );
    if (current.status === 'error') throw new Error(current.detail);
    if (
      tasks.length === 2 &&
      current.badgeCount >= 2 &&
      existsSync(`${sample}/greeting.txt`) &&
      existsSync(`${sample}/notes.md`)
    ) {
      assert.equal(await readFile(`${sample}/greeting.txt`, 'utf8'), 'hello superagent\n');
      assert.equal(await readFile(`${sample}/notes.md`, 'utf8'), '# 验收样例\n');
      assert.ok(tasks.every((task) => task.entrustedWork?.closure.state === 'open'));
      await writeFile(
        `${root}/native-model-result.json`,
        JSON.stringify(
          {
            kind: 'real-host-native-model',
            model: 'gpt-6.1-sol',
            mainThreadId: entry.threadId,
            taskIds: tasks.map((task) => task.id),
            executionThreads: tasks.map((task) => task.threadId),
            errors,
            verified: [
              'real-coordinator-judgment',
              'two-canonical-work',
              'independent-worker-execution',
              'actual-file-content',
              'in-place-result',
              'await-human-acceptance',
            ],
          },
          null,
          2,
        ),
      );
      console.log('Real native workers wrote and verified both expected files; both Work items await human acceptance');
      break;
    }
    await page.waitForTimeout(10000);
  }
  assert.ok(
    existsSync(`${root}/native-model-result.json`),
    'native journey did not reach its expected outcome; inspect the original invocation',
  );
} finally {
  await page.screenshot({ path: `${root}/native-model-last.png`, fullPage: true });
  await writeFile(`${root}/native-model-last.txt`, await page.locator('body').innerText());
  await browser.close();
}
