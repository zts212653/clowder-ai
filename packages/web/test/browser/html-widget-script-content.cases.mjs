import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const BLOCK_ID = 'f294-script-content';
const TITLES = [
  '先听见，你正在关心什么。',
  '猫回来时，已经带来一点东西。',
  '你一句话，先改变这一次。',
  '把这份分寸，留给以后。',
  '下一次机会，才看得出有没有学会。',
];

async function deliver(page, html, mode) {
  // Exercise the real store/ChatContainer consumer for live and history delivery.
  // APIs are fixture responses; this is not a backend SSE transport test.
  await page.evaluate(
    ({ html, mode, blockId }) => {
      let require;
      self.webpackChunk_N_E.push([
        [`script-content-${mode}`],
        {},
        (runtime) => {
          require = runtime;
        },
      ]);
      const moduleId = Object.keys(require.m).find((id) => id.includes('/src/stores/chatStore.ts'));
      if (!moduleId) throw new Error('ChatStore unavailable in the Next dev fixture');
      const state = require(moduleId).useChatStore.getState();
      const message = {
        id: 'f294-script-content-message',
        type: 'assistant',
        catId: 'codex-sol',
        content: 'Persisted HTML script regression',
        timestamp: 1_788_616_745_209,
        extra: {
          isExplicitPost: true,
          rich: {
            v: 1,
            blocks: [
              { id: blockId, kind: 'html_widget', v: 1, title: 'Script content regression', height: 1040, html },
            ],
          },
        },
      };
      if (mode === 'live') state.addMessageToThread('rich-html-continuity-a', message);
      else state.replaceThreadMessages('rich-html-continuity-a', [message], false);
    },
    { html, mode, blockId: BLOCK_ID },
  );
  const widget = page.locator(`[data-html-widget="${BLOCK_ID}"]`);
  await widget.waitFor();
  const iframe = widget.locator('iframe');
  await iframe.waitFor();
  const frame = await (await iframe.elementHandle()).contentFrame();
  assert.ok(frame, 'widget must have a sandbox frame');
  // Layout-ready alone falsely passed on the original failure: only the bridge ran.
  await frame.waitForFunction((title) => document.querySelector('#scene-title')?.textContent === title, TITLES[0]);
  assert.ok((await frame.locator('#scene-content').innerText()).trim().length > 0);
  assert.equal(await frame.locator('[data-scene][aria-current="step"]').count(), 1);
  assert.equal(await iframe.getAttribute('sandbox'), 'allow-scripts');
  return { widget, frame };
}

export function registerScriptContentRegression({ openFixture }) {
  test('real Chat script content survives live delivery, history, disclosure and interaction', async () => {
    // Exact persisted HTML, not an author-escaped or minimized replacement.
    // Source: thread_mtd34lqxxu9eozku#0001788616745209-000214-10116b45.
    const html = await readFile(new URL('./fixtures/f294-script-content-story.html', import.meta.url), 'utf8');
    assert.equal(
      createHash('sha256').update(html).digest('hex'),
      '50d3f800dd09fe0cd55d539440d5c1f4be9953d4baf6b1ce97860fcd461787c8',
    );
    const page = await openFixture();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    try {
      await deliver(page, html, 'live');
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.locator('[data-testid="rich-html-interaction-continuity-fixture"][data-hydrated="true"]').waitFor();
      const { widget, frame } = await deliver(page, html, 'history');
      await widget.getByRole('button', { name: '展开完整内容' }).click();
      assert.equal(await frame.locator('#scene-title').textContent(), TITLES[0]);
      for (let index = 1; index < TITLES.length; index++) {
        await frame.locator('#next').click();
        assert.equal(await frame.locator('#scene-title').textContent(), TITLES[index]);
        assert.ok((await frame.locator('#scene-content').innerText()).trim().length > 0);
      }
      await frame.locator('[data-scene="2"]').click();
      await frame.locator('#silent-branch').click();
      assert.equal(await frame.locator('#silent-branch').getAttribute('aria-pressed'), 'true');
      assert.match(await frame.locator('#scene-content').innerText(), /不追加催问/);
      await frame.locator('#reply-branch').click();
      assert.equal(await frame.locator('#reply-branch').getAttribute('aria-pressed'), 'true');
      await frame.locator('[data-scene="0"]').click();
      // Keep native timers: the widget/bridge already scheduled work, and Clock.install
      // would replace clocks in the entire shared BrowserContext, including later tests.
      await frame.locator('#play').click();
      assert.equal(await frame.locator('#play').textContent(), '暂停');
      await frame.waitForFunction((title) => document.querySelector('#scene-title')?.textContent === title, TITLES[1], {
        timeout: 20_000,
      });
      assert.equal(await frame.locator('#scene-title').textContent(), TITLES[1]);
      await frame.locator('#play').click();
      assert.equal(await frame.locator('#play').textContent(), '播放');
      // Observe a whole playback interval after pausing, rather than merely its label.
      await frame.waitForTimeout(8200);
      assert.equal(await frame.locator('#scene-title').textContent(), TITLES[1]);
      await widget.getByRole('button', { name: '收起完整内容' }).click();
      await widget.getByRole('button', { name: '展开完整内容' }).click();
      assert.equal(await frame.locator('#scene-title').textContent(), TITLES[1]);
      assert.deepEqual(errors, []);
    } finally {
      await page.close();
    }
  });
}
