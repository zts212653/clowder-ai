import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const origin = 'http://127.0.0.1:5220';
const api = 'http://127.0.0.1:3219';
const root = fileURLToPath(new URL('../../../../artifacts/superagent-live', import.meta.url));
const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const session = await (await context.request.get(`${api}/api/session`)).json();
  const headers = { origin, 'x-csrf-token': session.csrfToken };
  const post = async (path, data) => {
    const response = await context.request.post(`${api}${path}`, { headers, data, timeout: 120000 });
    assert.ok(response.ok(), `${path}: ${response.status()} ${await response.text()}`);
    return response.json();
  };
  const cats = await (await context.request.get(`${api}/api/cats`)).json();
  if (!cats.cats.some((cat) => cat.id === 'codex-acceptance')) {
    await post('/api/cats', {
      catId: 'codex-acceptance',
      name: '缅因猫',
      displayName: '砚砚 · 隔离验收',
      nickname: '砚砚',
      clientId: 'openai',
      defaultModel: 'gpt-6.1-sol',
      configurationSource: 'native_tool',
      color: { primary: '#5B8C5A', secondary: '#D4E6D3' },
      mentionPatterns: ['@codex-acceptance'],
      roleDescription: '在本次隔离 Superagent 验收中承担协调与执行，遵守插件指令和真实 Task 坐标。',
      executionApproval: 'auto',
      mcpSupport: true,
    });
  }
  const sample = `${root}/sample-work`;
  await mkdir(sample, { recursive: true });
  await writeFile(
    `${sample}/AGENTS.md`,
    '# 隔离验收\n只修改本目录中的验收样例。完成请求的文件与实际验证，用 superagent_report 返回结果；不要提交、发布或安装依赖。\n',
  );
  const threads = [];
  for (const title of ['Superagent 验收 · 开发来源', 'Superagent 验收 · 反馈来源'])
    threads.push(await post('/api/threads', { title, projectPath: sample, preferredCats: ['codex-acceptance'] }));
  await writeFile(`${root}/sample-sources.json`, JSON.stringify(threads, null, 2));
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`${origin}/settings?s=plugins&plugin=official.superagent&shell=v2`, {
    waitUntil: 'domcontentloaded',
    timeout: 90000,
  });
  await page.getByRole('heading', { name: 'Superagent', exact: true }).waitFor({ timeout: 60000 });
  console.log((await page.locator('body').innerText()).slice(-5500));
  await page.screenshot({ path: `${root}/settings-before-enable.png`, fullPage: true });
  await context.storageState({ path: `${root}/browser-state.json` });
  await writeFile(
    `${root}/browser-setup.json`,
    JSON.stringify(
      {
        errors,
        memberId: 'codex-acceptance',
        sourceThreads: threads.map((thread) => thread.id ?? thread.thread?.id),
        api,
        origin,
      },
      null,
      2,
    ),
  );
} finally {
  await browser.close();
}
