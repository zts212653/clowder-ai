import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from '../../../ppt-forge/node_modules/playwright/index.mjs';

export function registerProposalV2Cases(getFixture, evidenceDir) {
  test(
    'V2 owner changes Group, asks the proposer to revise, then approves the replacement',
    { timeout: 180_000 },
    async () => {
      await mkdir(evidenceDir, { recursive: true });
      const { apiUrl, webUrl } = getFixture();
      const seeded = await fetch(`${apiUrl}/__test/proposal-v2`, { method: 'POST' });
      assert.equal(seeded.status, 200, await seeded.clone().text());
      const sample = await seeded.json();
      const browser = await chromium.launch({ headless: true });
      const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
      const errors = [];
      const responses = [];
      page.on('response', (response) => {
        if (response.url().includes('/api/proposals/'))
          responses.push({ url: response.url(), status: response.status() });
      });
      page.on('pageerror', (error) => errors.push(error.message));
      const url = `${webUrl}/dev/f277-attention-preview/proposals?proof=F329-F330&shell=v2`;
      try {
        await page.goto(url);
        const original = page.getByTestId(`approval-item-${sample.proposalId}`);
        await original.getByRole('button', { name: '让宪宪改…', exact: true }).waitFor();
        assert.equal(await original.getByText('先开口', { exact: true }).count(), 1);
        assert.ok((await original.getByTestId('proposal-auto-mentions').textContent()).includes('@小星星'));
        assert.equal(await original.getByRole('button', { name: '编辑', exact: true }).count(), 0);
        const project = original.getByRole('combobox', { name: '项目', exact: true });
        const groupChoice = original.getByRole('combobox', { name: '放进 Group', exact: true });
        assert.equal(await project.evaluate((element) => element.tagName), 'BUTTON');
        for (const choice of [project, groupChoice]) {
          assert.equal(await choice.evaluate((element) => getComputedStyle(element).height), '28px');
          assert.equal(await choice.evaluate((element) => getComputedStyle(element).borderRadius), '8px');
          assert.ok((await choice.textContent()).includes('⌄'));
        }
        await project.click();
        await original.getByRole('listbox', { name: '项目', exact: true }).waitFor();
        await page.keyboard.press('ArrowDown');
        await page.keyboard.press('Enter');
        assert.equal(await project.getAttribute('aria-expanded'), 'false');
        const cardShot = await original.screenshot({ path: path.join(evidenceDir, 'polish-card.png') });
        await page.screenshot({ path: path.join(evidenceDir, 'v2-proposal-1440.png') });
        await original.getByRole('combobox', { name: '放进 Group', exact: true }).click();
        await original.getByRole('option', { name: 'F329「猫猫星球」游戏', exact: false }).click();
        await original.getByRole('button', { name: '让宪宪改…', exact: true }).click();
        await original.getByLabel('想怎么改？').fill('不要 5.6 审，换 Argon 审；小星星先别叫醒，直接让 6.1 开始');
        await page.screenshot({ path: path.join(evidenceDir, 'v2-request-revision-1440.png') });
        await original.getByRole('button', { name: '请宪宪改', exact: true }).click();
        await original.getByText('已被新提议替代', { exact: true }).waitFor();
        const state = await (await fetch(`${apiUrl}/__test/proposal-state`)).json();
        assert.deepEqual(state.failures, []);
        const next = state.proposals.find((proposal) => proposal.supersedesProposalId === sample.proposalId);
        assert.ok(next?.cardMessageId);
        assert.equal(
          next.declaredWorkMode,
          'subtask',
          'revising the assignment preserves the original child-work contract',
        );
        assert.equal(next.suggestedGroupId, sample.planetGroup.id, 'the selected group survives the revision');
        const replacement = page.getByTestId(`approval-item-${next.proposalId}`);
        await replacement.getByText('先开口', { exact: true }).waitFor();
        assert.equal(await replacement.getByText('先开口', { exact: true }).count(), 1);
        assert.ok(
          (await replacement.getByTestId('proposal-auto-mentions').textContent()).includes('@小太阳 6.1 @烁烁 Argon'),
        );
        assert.ok(!(await replacement.textContent()).includes('小太阳 5.6'));
        await page.screenshot({ path: path.join(evidenceDir, 'v2-replaced-1440.png') });
        await replacement.getByTestId('approve-btn').click();
        await page.waitForURL(/\/thread\/thread_/);
        const final = (await (await fetch(`${apiUrl}/__test/proposal-state`)).json()).proposals.find(
          (proposal) => proposal.proposalId === next.proposalId,
        );
        assert.equal(final.status, 'approved');
        assert.equal(final.declaredWorkMode, 'subtask');
        const groups = await (await fetch(`${apiUrl}/api/config/thread-attention`)).json();
        assert.ok(
          groups.groups.find((group) => group.id === sample.planetGroup.id).threadIds.includes(final.createdThreadId),
        );
        await page.goto(url);
        await page
          .getByTestId(`approval-item-${next.proposalId}`)
          .getByText('已同意 · 对话已开', { exact: true })
          .waitFor();
        assert.equal(
          await page
            .getByTestId(`approval-item-${next.proposalId}`)
            .getByTestId('thread-proposal-result')
            .textContent(),
          '已同意 · 对话已开 · 打开 ›',
        );
        await page.screenshot({ path: path.join(evidenceDir, 'v2-approved-1440.png') });
        const resultShot = await page
          .getByTestId(`approval-item-${next.proposalId}`)
          .screenshot({ path: path.join(evidenceDir, 'polish-result.png') });
        await page.getByTestId('sidebar-search-toggle').click();
        const search = page.getByTestId('sidebar-search-input');
        await search.fill('F329');
        await page.getByTestId('search-group-organize').click();
        const editor = page.getByTestId('search-group-editor');
        await editor.waitFor();
        assert.ok((await editor.textContent()).includes('匹配 34 条 · 其中 20 条已在'));
        assert.ok((await editor.getByTestId('search-group-save').textContent()).includes('把另外 14 条加入 F329'));
        assert.ok((await editor.getByRole('option', { selected: true }).textContent()).includes('F329'));
        assert.equal(Math.round((await editor.boundingBox()).width), 420);
        const alignment = await editor.locator('[data-select-thread]').evaluateAll((inputs) =>
          inputs.map((input) => {
            const row = input.parentElement;
            const title = row.querySelector('[data-thread-id] [role="link"]');
            const caption = row.querySelector('p');
            return {
              title: title.textContent,
              titleX: title.getBoundingClientRect().left,
              captionX: caption.getBoundingClientRect().left + Number.parseFloat(getComputedStyle(caption).paddingLeft),
            };
          }),
        );
        assert.ok(alignment.length > 0);
        assert.ok(
          alignment.every((row) => Math.abs(row.titleX - row.captionX) < 1),
          JSON.stringify(alignment),
        );
        await writeFile(path.join(evidenceDir, 'polish-alignment.json'), JSON.stringify(alignment, null, 2));
        await page.screenshot({ path: path.join(evidenceDir, 'v2-organize-1440.png') });
        const organizerShot = await editor.screenshot({ path: path.join(evidenceDir, 'polish-organizer.png') });
        const board = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
        await board.setContent(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>本轮实页修正</title>
          <style>body{margin:0;background:#faf9f6;color:#292621;font:14px system-ui,sans-serif}main{padding:30px 56px}h1{font-size:20px;margin:0 0 8px}p{margin:0 0 22px;color:#746e65}h2{font-size:14px;margin:20px 0 12px}.columns{display:grid;grid-template-columns:620px 420px;gap:80px}img{display:block;max-width:100%}</style>
          <main><h1>提议卡与整理 Group · 本轮实页修正</h1><p>中文 V2 · 1440 宽 · 以下为同一次浏览器旅程截取的真实组件，原图另存</p>
          <div class="columns"><section><h2>项目 / 放进 Group：同一个 28px 自定义选择器</h2><img src="data:image/png;base64,${cardShot.toString('base64')}"><h2>结果行：已同意 · 对话已开 · 打开 ›</h2><img src="data:image/png;base64,${resultShot.toString('base64')}"></section>
          <section><h2>整理列表：标题与第二行说明左对齐</h2><img src="data:image/png;base64,${organizerShot.toString('base64')}"></section></div></main></html>`);
        await board.locator('img').evaluateAll((images) => Promise.all(images.map((image) => image.decode())));
        await board.screenshot({ path: path.join(evidenceDir, 'polish-1440.png') });
        await board.close();
        await editor.getByLabel('搜组名', { exact: true }).fill('F330');
        assert.equal(await editor.getByRole('option').count(), 2, 'matching destination plus New Group remain');
        await page.keyboard.press('Escape');
        await editor.waitFor({ state: 'hidden' });
        await page.setViewportSize({ width: 390, height: 844 });
        await page.getByTestId('search-group-organize').click();
        await editor.waitFor();
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
        await page.screenshot({ path: path.join(evidenceDir, 'v2-organize-390.png') });
        await page.keyboard.press('Escape');
        await page.setViewportSize({ width: 1440, height: 1000 });
        await page.evaluate(() => (document.documentElement.dataset.theme = 'dark'));
        await page.getByTestId('search-group-organize').click();
        await editor.waitFor();
        await page.screenshot({ path: path.join(evidenceDir, 'v2-organize-dark-1440.png') });
        const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
        for (const [folder, name] of [
          ['2026-10-23-thread-group-placement', 'reference-organize-1440.png'],
          ['2026-10-23-thread-proposal-card', 'reference-proposal-1440.png'],
        ]) {
          await page.goto(pathToFileURL(path.join(root, 'docs/evidence', folder, 'proposal.html')).href);
          await page.screenshot({ path: path.join(evidenceDir, name), fullPage: true });
        }
        assert.deepEqual(errors, []);
        await writeFile(
          path.join(evidenceDir, 'journey.json'),
          JSON.stringify(
            {
              proposalId: sample.proposalId,
              replacementId: next.proposalId,
              createdThreadId: final.createdThreadId,
              groupId: sample.planetGroup.id,
              errors,
              responses,
            },
            null,
            2,
          ),
        );
      } catch (error) {
        await page.screenshot({ path: path.join(evidenceDir, 'failure.png'), fullPage: true }).catch(() => {});
        const state = await fetch(`${apiUrl}/__test/proposal-state`)
          .then((response) => response.json())
          .catch(() => null);
        await writeFile(
          path.join(evidenceDir, 'failure.json'),
          JSON.stringify({ message: String(error), errors, responses, state }, null, 2),
        );
        throw error;
      } finally {
        await browser.close();
      }
    },
  );
}
