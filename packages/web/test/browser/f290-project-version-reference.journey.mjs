import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { chromium } from 'playwright';
import { projectVersionFixture } from './f290-project-version-reference.fixture.mjs';

test(
  'two normal project UIs select exact original versions and only an explicit owner switch changes A',
  { timeout: 180_000 },
  async (t) => {
    const f = await projectVersionFixture().catch((error) => {
      console.error(error);
      throw error;
    });
    const browser = await chromium.launch({
      headless: true,
      ...(process.env.F290_BROWSER_EXECUTABLE ? { executablePath: process.env.F290_BROWSER_EXECUTABLE } : {}),
    });
    const contexts = [];
    t.after(async () => {
      await Promise.all(contexts.map((context) => context.close()));
      await browser.close();
      await f.close();
    });
    const makePage = async (token) => {
      const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
      contexts.push(context);
      await context.addInitScript(
        ({ origin, token }) => {
          if (location.origin === origin) sessionStorage.setItem(`collective-session:${origin}`, token);
        },
        { origin: f.url, token },
      );
      const page = await context.newPage();
      page.setDefaultTimeout(15_000);
      page.on('pageerror', (error) => {
        throw error;
      });
      page.on('response', async (response) => {
        if (response.url().includes('/projects/artifacts/change') && response.status() !== 200)
          console.error('reference change HTTP', response.status(), await response.text());
      });
      await page.goto(f.url, { waitUntil: 'networkidle' });
      const browse = page.getByRole('button', { name: /先逛逛|Browse first/ });
      if (await browse.isVisible()) await browse.click();
      return page;
    };
    const a = await makePage(f.creator.sessionToken),
      b = await makePage(f.member.sessionToken);
    const openProject = async (page, title) => {
      await page.getByRole('button', { name: /^项目$|^Projects$/ }).click();
      await page.getByRole('button', { name: new RegExp(`打开项目 · ${title}|Open project · ${title}`) }).click();
      await page.getByRole('button', { name: /^作品/ }).click();
    };
    const attach = async (page, title, revision) => {
      await openProject(page, title);
      await page.getByRole('button', { name: '引用作品…', exact: true }).click();
      await page
        .getByRole('dialog')
        .getByRole('button', { name: /插件接入指南/ })
        .click();
      const dialog = page.getByRole('dialog', { name: '引用作品', exact: true });
      await dialog.getByRole('combobox').selectOption(String(revision));
      await dialog.getByRole('button', { name: `引用 v${revision}`, exact: true }).click();
      try {
        await dialog.waitFor({ state: 'hidden' });
      } catch (error) {
        console.error('reference dialog failure', await dialog.innerText());
        if (process.env.F290_BATCH3_EVIDENCE_DIR) {
          await mkdir(process.env.F290_BATCH3_EVIDENCE_DIR, { recursive: true });
          await page.screenshot({
            path: join(process.env.F290_BATCH3_EVIDENCE_DIR, `failed-attach-v${revision}.png`),
            fullPage: true,
            animations: 'disabled',
          });
        }
        throw error;
      }
      await page.getByRole('button', { name: `打开本项目用的 v${revision}`, exact: true }).waitFor();
    };
    await attach(a, f.a.title, 2);
    await attach(b, f.b.title, 3);
    await f.publish(4, '补充 Windows 路径');
    await a.getByText('有新版 v4', { exact: true }).waitFor();
    await b.getByText('有新版 v4', { exact: true }).waitFor();
    await b.getByRole('button', { name: '保持 v3', exact: true }).click();
    await a.getByRole('button', { name: '打开本项目用的 v2', exact: true }).click();
    await a.getByText(/正文标记 OWNER-V2/).waitFor();
    assert.equal(await a.getByText(/正文标记 OWNER-V4/).count(), 0);
    await a.getByRole('button', { name: '返回原项目', exact: true }).click();
    await a.getByRole('button', { name: '打开本项目用的 v2', exact: true }).waitFor();
    assert.equal(
      await a.getByRole('complementary', { name: '话题', exact: true }).count(),
      0,
      'returning to the same-channel project must detach the original Topic drawer',
    );
    await a.getByRole('button', { name: '换用…', exact: true }).click();
    const swap = a.getByRole('dialog', { name: '换用作品版本', exact: true });
    await swap.getByText('补充 Windows 路径', { exact: true }).waitFor();
    await swap.getByRole('button', { name: '换用 v4', exact: true }).click();
    await swap.waitFor({ state: 'hidden' });
    await a.getByRole('button', { name: '打开本项目用的 v4', exact: true }).waitFor();
    await b.getByRole('button', { name: '打开本项目用的 v3', exact: true }).waitFor();
    const output = process.env.F290_BATCH3_EVIDENCE_DIR;
    if (output) await mkdir(output, { recursive: true });
    const layouts = [];
    for (const width of [1440, 1180, 1024, 800, 390]) {
      await a.setViewportSize({ width, height: 1000 });
      const summary = a.locator('.project-summary');
      const geometry = await summary.evaluate((element) => {
        const heading = element.querySelector('h1').getBoundingClientRect();
        const action = element.querySelector('.roadmap-status-action').getBoundingClientRect();
        const box = element.getBoundingClientRect();
        return {
          headingWidth: heading.width,
          headingHeight: heading.height,
          actionRight: action.right,
          right: box.right,
        };
      });
      assert.ok(
        geometry.headingWidth >= 140 && geometry.headingHeight < 55,
        `project title at ${width}px: ${JSON.stringify(geometry)}`,
      );
      assert.ok(geometry.actionRight <= geometry.right, `project action must remain inside its summary at ${width}px`);
      layouts.push({ viewport: width, ...geometry });
      if (output && (width === 1180 || width === 390))
        await a.screenshot({ path: join(output, `project-a-v4-${width}.png`), fullPage: true, animations: 'disabled' });
    }
    await a.setViewportSize({ width: 1440, height: 1000 });
    if (output) {
      await writeFile(join(output, 'project-summary-geometry.json'), JSON.stringify(layouts, null, 2) + '\n');
      await a.screenshot({ path: join(output, 'project-a-v4-1440.png'), fullPage: true, animations: 'disabled' });
      await b.screenshot({ path: join(output, 'project-b-v3-1440.png'), fullPage: true, animations: 'disabled' });
      await writeFile(
        join(output, 'native-identities.json'),
        JSON.stringify(
          {
            serviceInstanceId: f.coordinates.serviceInstanceId,
            collectiveId: f.coordinates.collectiveId,
            artifactId: f.artifact.artifactId,
            contentRef: f.artifact.contentRef,
            a: f.a.roadmapId,
            b: f.b.roadmapId,
            versions: [...f.versions.values()],
          },
          null,
          2,
        ),
      );
    }
    await b.getByRole('button', { name: '打开本项目用的 v3', exact: true }).click();
    await b.getByText(/正文标记 OWNER-V3/).waitFor();
  },
);
