import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import {
  createScreeningJourney,
  decodedSeek,
  nativeScrub,
  openPreparedProject,
  prepareScreeningJourney,
} from './f326-screening-journey.harness.mjs';

const workflowOpinion =
  'F326 隔离工位真实验收：请只处理本条所附审片位置。允许接管本条原 Human 消息并登记本隔离线程的修改 Task，勿改正式 Task 或原素材文件。用 take_over_content_modification 接管，再用 video_project_command 读原输入和账本；按原意见的 baseOwnerRevision/baseRevision 定位到 moment 1429–1430 的 C08:visual:2。把当前项目这条稳定 visual 的 assetVersionRef 改成同项目 C08:visual:1 已登记的真实 C08b 画稿，保留 visual ID、时段与其他输入，走 CAS save，再以真实 save receipt addressed 原意见。不要登记新成片或假称已渲染。JSON 很长，可在 functions.exec 中聚合分页而不把全文抄给模型。工具缺失或拒绝就报告实际错误，勿造 token、直写 owner/SQLite 或改客户端代码。完成后只报告 request/Task/save/ledger 的真实坐标。';

// No mocked HTTP, custom React host, hidden seeded project or provider execution by default.
// Root starts the feature environment independently and explicitly admits its disposable writes.
test(
  'F326 formal import → ordinary Workspace → real movies → frozen positions → comparison/reload',
  { timeout: 360000 },
  async (t) => {
    const journey = await createScreeningJourney();
    const result = {
      outcome: 'running',
      scope: 'real feature API/browser/MP4; no Human send unless root explicitly admits it',
      nativeFrames: [],
      humanSend: 'guard-closed',
      assertions: [],
    };
    let failure;
    t.after(async () => {
      await journey.page.screenshot({ path: path.join(journey.evidence, 'last.png'), fullPage: true }).catch(() => {});
      await writeFile(
        path.join(journey.evidence, 'result.json'),
        JSON.stringify(
          {
            ...result,
            ...(failure ? { failure: String(failure), stack: failure.stack } : {}),
            calls: journey.calls,
            errors: journey.errors,
            requests: journey.requests,
            ranges: journey.ranges,
          },
          null,
          2,
        ),
      );
      await journey.close();
      console.log(`F326 browser evidence: ${journey.evidence}`);
    });
    try {
      const manifest = process.env.F326_BROWSER_MANIFEST
        ? JSON.parse(await readFile(process.env.F326_BROWSER_MANIFEST, 'utf8'))
        : await prepareScreeningJourney(journey);
      await openPreparedProject(journey, manifest);
      const { page } = journey;
      const surface = page.locator(`[data-video-project="${manifest.contentRef}"]`);
      const composer = page.locator('[data-testid="chat-input-composer-row"] textarea:visible');
      await composer.waitFor();
      assert.equal(await composer.count(), 1, 'Review uses the single original chat composer');
      await composer.evaluate((element) => {
        element.dataset.f326OriginalComposer = 'same-thread-composer';
      });
      // A reused isolated project may restore the previous failed run's unsent draft from the real owner.
      // Remove those own pending positions through the ordinary composer controls before adding this run's mark.
      const draftOwner = page.locator('[data-testid="chat-input-composer-row"]').locator('..');
      while (await draftOwner.getByRole('button', { name: /^移除审片位置 / }).count())
        await draftOwner
          .getByRole('button', { name: /^移除审片位置 / })
          .first()
          .click();
      const allowSend = process.env.F326_BROWSER_ALLOW_HUMAN_SEND === 'root-confirmed-existing-codex61-sol';
      const label = allowSend ? workflowOpinion : 'F326 浏览器实采样意见：只确认收到原位置，勿改源文件或 Task。';
      await composer.fill(label);
      const versions = surface.getByRole('combobox', { name: '成片版本' });
      const [prior, final] = manifest.descriptors;
      assert.equal(
        await versions.inputValue(),
        final.screening.id,
        'Ordinary project entry opens the latest registered output',
      );
      assert.ok((await surface.innerText()).includes('尚无自审记录'), '100 sampled shots are not an attestation');
      const video = surface.getByRole('region', { name: '成片播放器' }).locator('video');
      await video.waitFor();
      await video.evaluate((element) => element.play());
      await page.waitForFunction(() =>
        [...document.querySelectorAll('[data-video-project] video')].some(
          (element) => element.currentTime > 0.15 && !element.paused,
        ),
      );
      await video.evaluate((element) => element.pause());
      await video.hover();
      await nativeScrub(journey, 0.92);
      await page.waitForFunction(() => {
        const element = document.querySelector('[data-video-project] video');
        return (
          element &&
          !element.seeking &&
          element.readyState >= 2 &&
          Math.abs(element.currentTime / element.duration - 0.92) < 0.015
        );
      });
      result.assertions.push('actual native Chromium timeline pointer drag reached 92%');
      result.nativeFrames.push(await decodedSeek(video, 1429 / 30));
      await surface.getByRole('button', { name: /标记问题/ }).waitFor();
      await composer.blur();
      await video.focus();
      await page.keyboard.press('m');
      const record = surface.getByRole('button', { name: '记到原输入框', exact: true });
      await record.waitFor();
      await page.waitForFunction(() =>
        [...document.querySelectorAll('[data-video-project] button')].some(
          (button) => button.textContent.trim() === '记到原输入框' && !button.disabled,
        ),
      );
      assert.equal(await composer.inputValue(), label, 'M on the film does not replace the original words');
      await record.click();
      // Classic puts extras beside the row; v2 puts them inside it. Both share this original ChatInput owner.
      const draft = draftOwner.locator('[data-context-kind="project-screening"]');
      await draft.waitFor();
      assert.ok((await draft.innerText()).includes(`输入 v${manifest.input.ownerRevision}`));
      const reviewPath = `/api/video-projects/${encodeURIComponent(manifest.contentRef)}/review`;
      const beforeSend = await journey.request(reviewPath);
      assert.equal(beforeSend.review.annotations.length, 0, 'Marking queues context; it does not create ledger facts');
      await page.screenshot({ path: path.join(journey.evidence, '01-c08c-original-composer.png'), fullPage: true });
      // Native decoded-frame evidence and the actual pending chip both refer to C08c tick1429.
      const originalReturn = draft.getByRole('button', { name: /回到.*的标记 1/ });
      await decodedSeek(video, 450);
      assert.ok(
        (await surface.innerText()).includes('尚未对应镜头'),
        'Unmapped ending stays watchable without fabricated shot identity',
      );
      await originalReturn.click();
      await page.waitForFunction(() => {
        const element = document.querySelector('[data-video-project] video');
        return element && !element.seeking && Math.abs(element.currentTime - 1429 / 30) < 0.05;
      });
      assert.equal(await versions.inputValue(), final.screening.id, 'Pending chip returns to the same frozen output');
      result.assertions.push('C08c 1429 tick decoded; tail450s unmapped; pending chip returns to frozen film');
      await surface.getByRole('combobox', { name: '与旧版对比（当前版固定在右侧）' }).selectOption(prior.screening.id);
      const compare = surface.getByRole('region', { name: '两版审片对比' });
      await compare.waitFor();
      assert.equal(await compare.getByRole('figure').count(), 2);
      const left = compare.getByRole('figure', { name: '旧版', exact: true }).locator('video');
      const right = compare.getByRole('figure', { name: '新版（意见版本）', exact: true }).locator('video');
      assert.ok((await left.getAttribute('src')).endsWith(prior.mediaUrl));
      assert.ok((await right.getAttribute('src')).endsWith(final.mediaUrl));
      assert.equal(await composer.getAttribute('data-f326-original-composer'), 'same-thread-composer');
      assert.equal(await composer.inputValue(), label);
      await compare.getByRole('button', { name: '同步播放', exact: true }).click();
      await page.waitForFunction(() =>
        [...document.querySelectorAll('[aria-label="两版审片对比"] video')].every(
          (element) => !element.paused && element.currentTime > 0.15,
        ),
      );
      await compare.getByRole('button', { name: '暂停两版', exact: true }).click();
      const playheads = await compare
        .locator('video')
        .evaluateAll((elements) => elements.map((element) => element.currentTime));
      assert.ok(Math.abs(playheads[0] - playheads[1]) < 0.15, `Provenance-backed common shot alignment ${playheads}`);
      await compare.getByRole('combobox', { name: '对比播放速度' }).selectOption('1.5');
      assert.deepEqual(
        await compare.locator('video').evaluateAll((elements) => elements.map((element) => element.playbackRate)),
        [1.5, 1.5],
      );
      // Native range keyboard is a real user input; the right output clock drives both versions.
      const slider = compare.getByRole('slider', { name: '新版对比播放位置' });
      await slider.focus();
      await page.keyboard.press('End');
      await page.keyboard.press('ArrowLeft');
      await page.waitForFunction(() => {
        const videos = [...document.querySelectorAll('[aria-label="两版审片对比"] video')];
        return videos.length === 2 && videos[0].hidden && !videos[1].hidden && videos[1].currentTime > 394.7;
      });
      assert.ok((await compare.innerText()).includes('这一段还没有可验证的两版对应'));
      assert.ok(
        (await right.getAttribute('src')).endsWith(final.mediaUrl),
        'An unmapped ending never retargets the fixed right version',
      );
      await page.screenshot({ path: path.join(journey.evidence, '02-fixed-pair-tail.png'), fullPage: true });
      await surface.getByRole('combobox', { name: '与旧版对比（当前版固定在右侧）' }).selectOption('');
      assert.equal(await composer.getAttribute('data-f326-original-composer'), 'same-thread-composer');
      assert.equal(await versions.inputValue(), final.screening.id);
      result.assertions.push(
        'real fixed output pair plays/rates/aligns; missing left tail honest; original composer survives',
      );

      await page.getByRole('button', { name: '整窗查看作品', exact: true }).click();
      assert.equal(
        await page.locator('[data-f326-original-composer="same-thread-composer"]').count(),
        1,
        'Full-window mode retains the same original Chat runtime',
      );
      await page.screenshot({ path: path.join(journey.evidence, '03-full-window.png'), fullPage: true });
      await page.getByRole('button', { name: '展开聊天', exact: true }).click();
      assert.equal(await composer.getAttribute('data-f326-original-composer'), 'same-thread-composer');
      assert.equal(await composer.inputValue(), label);
      await draft.waitFor();
      result.assertions.push('full-window entry and return preserve original composer node, words and position');

      await t.test(
        'actual Human send enters MessageStore and canonical ledger exactly once',
        { skip: !allowSend },
        async () => {
          const cats = (await journey.request('/api/cats')).cats;
          const receiver = cats.find((cat) => cat.id === 'codex61-sol');
          assert.equal(receiver?.clientId, 'openai', 'Preflight the explicit receiver at actual send');
          assert.equal(receiver?.defaultModel, 'gpt-6.1-sol', 'Never silently reroute a test opinion');
          assert.equal(receiver?.accountRef, 'codex', 'Use the verified existing account binding');
          await writeFile(
            '/tmp/f326-b-human-send-attempt.json',
            JSON.stringify(
              {
                threadId: manifest.threadId,
                contentRef: manifest.contentRef,
                receiver: receiver.id,
                model: receiver.defaultModel,
                input: manifest.input,
                screeningId: final.screening.id,
                reservedAt: new Date().toISOString(),
              },
              null,
              2,
            ),
            { flag: 'wx' },
          );
          await composer.fill(`@codex61-sol\n${label}`);
          const sent = page.waitForResponse(
            (response) =>
              response.url() === `${journey.apiOrigin}/api/messages` && response.request().method() === 'POST',
          );
          await composer.press('Enter');
          const response = await sent;
          assert.ok(response.ok(), await response.text());
          const receipt = await response.json();
          assert.ok(receipt.userMessageId, 'Actual server-backed Human send receipt must name the stored message');
          await writeFile(
            '/tmp/f326-b-human-send-receipt.json',
            JSON.stringify({ ...receipt, threadId: manifest.threadId, contentRef: manifest.contentRef }, null, 2),
          );
          const messages = await journey.request(
            `/api/messages?threadId=${encodeURIComponent(manifest.threadId)}&limit=100`,
          );
          const stored = messages.messages.find((message) => message.id === receipt.userMessageId);
          assert.ok(stored);
          const attachment = stored.contentBlocks.find(
            (block) => block.type === 'context_attachment' && block.attachment.kind === 'project-screening',
          ).attachment;
          assert.equal(attachment.screeningId, final.screening.id);
          assert.deepEqual(attachment.input, manifest.input);
          assert.equal(attachment.selections[0].target.kind, 'moment');
          assert.equal(attachment.selections[0].target.tick, 1429);
          assert.equal(attachment.selections[0].mediaRange.startPts, 731648);
          await journey.request(`${reviewPath}/synchronize`, { threadId: manifest.threadId });
          const reviewed = await journey.request(reviewPath);
          const imported = reviewed.review.annotations.filter(
            (annotation) => annotation.projectMessage?.source.messageId === stored.id,
          );
          assert.equal(imported.length, 1);
          assert.equal(imported[0].projectMessage.screeningId, final.screening.id);
          assert.deepEqual(imported[0].projectMessage.input, manifest.input);
          await journey.request(`${reviewPath}/synchronize`, { threadId: manifest.threadId });
          assert.equal(
            (await journey.request(reviewPath)).review.annotations.length,
            reviewed.review.annotations.length,
            'Synchronization retries do not duplicate the source message',
          );
          const sentChip = page.locator(`[data-message-id="${stored.id}"] [data-context-kind="project-screening"]`);
          await sentChip.getByRole('button', { name: /回到.*的标记 1/ }).click();
          await page.waitForFunction(() => {
            const element = document.querySelector('[data-video-project] video');
            return element && !element.seeking && Math.abs(element.currentTime - 1429 / 30) < 0.05;
          });
          result.humanSend = {
            messageId: stored.id,
            reviewId: reviewed.review.reviewId,
            annotationId: imported[0].id,
            input: attachment.input,
            screeningId: attachment.screeningId,
          };
        },
      );
      if (allowSend)
        assert.equal(typeof result.humanSend, 'object', 'Human send subtest must produce its real receipt');
      await page.reload({ waitUntil: 'domcontentloaded' });
      await surface.waitFor();
      assert.equal(await versions.inputValue(), final.screening.id, 'Reload preserves the selected frozen output');
      assert.equal(await page.locator('[data-testid="chat-input-composer-row"] textarea:visible').count(), 1);
      if (!allowSend) {
        await draft.waitFor();
        assert.equal((await journey.request(reviewPath)).review.annotations.length, 0);
      } else {
        const sentChip = page.locator(
          `[data-message-id="${result.humanSend.messageId}"] [data-context-kind="project-screening"]`,
        );
        await sentChip.waitFor();
        assert.equal((await journey.request(reviewPath)).review.annotations.length, 1);
      }
      assert.ok(
        journey.ranges.some((response) => response.status === 206 && /^bytes /.test(response.range ?? '')),
        'Real immutable movie reads must produce an authorized Range response',
      );
      assert.deepEqual(journey.errors, []);
      result.outcome = allowSend ? 'pass' : 'partial:human-send-guard-closed';
      await page.screenshot({ path: path.join(journey.evidence, '03-reload.png'), fullPage: true });
    } catch (error) {
      failure = error;
      result.outcome = 'fail';
      throw error;
    }
  },
);
