import assert from 'node:assert/strict';

// The production ThreadChatSurface owns the column. Its fixture only supplies
// the outer viewport, HTTP responses and socket transport, never a reading width.
export async function runChatReadingColumnJourney(t, { openProof, closeProof, capture, captureFailure }) {
  for (const [width, sidebar, base] of [
    [1920, true, 'light'],
    [1440, true, 'dark'],
    [700, true, 'dark'],
    [320, false, 'light'],
  ]) {
    await t.test(`production reading surface at ${width}px ${base}`, async () => {
      const proof = await openProof({ width, sidebar, base, surface: true });
      const { page } = proof;
      let failure;
      try {
        const cat = page.locator('[data-message-id="reading-cat"]');
        await cat.waitFor();
        const measure = () =>
          page.evaluate(() => {
            const rect = (selector) => {
              const node = document.querySelector(selector);
              if (!node) return null;
              const r = node.getBoundingClientRect();
              return { x: r.x, right: r.right, width: r.width, scroll: node.scrollWidth, client: node.clientWidth };
            };
            const hostNode = document.querySelector('[data-chat-container]');
            const host = rect('[data-chat-container]');
            const style = getComputedStyle(hostNode);
            // clientWidth excludes the native scrollbar; the content box also
            // excludes the asymmetric space reserved for the piano.
            const left = host.x + hostNode.clientLeft + Number.parseFloat(style.paddingLeft);
            const right = host.x + hostNode.clientLeft + hostNode.clientWidth - Number.parseFloat(style.paddingRight);
            return {
              host,
              available: { x: left, right, width: right - left },
              padding: {
                left: Number.parseFloat(style.paddingLeft),
                right: Number.parseFloat(style.paddingRight),
              },
              column: rect('[data-thread-chat-reading-column]'),
              track: rect('[data-message-piano]'),
              cat: rect('[data-message-id="reading-cat"]'),
              human: rect('[data-message-id="reading-human"] [data-testid="message-bubble"]'),
              line: rect('[data-testid="reply-last-line"]'),
            };
          });
        const assertReadingGeometry = (m) => {
          assert.ok(m.available.width > 0);
          assert.equal(
            m.column.width,
            Math.min(720, m.available.width),
            'column fills its available content box up to 720px',
          );
          assert.ok(
            Math.abs(m.column.x + m.column.right - (m.available.x + m.available.right)) <= 1,
            'column is centered inside the content box, including the piano reservation',
          );
          assert.ok(m.track?.width > 0, 'the production piano is measurable');
          assert.ok(m.column.right < m.track.x, 'the piano never covers the reading column');
          assert.ok(
            m.track.x >= m.host.x && m.track.right <= m.host.right,
            'the piano stays inside the reading viewport',
          );
          assert.ok(m.host.scroll <= m.host.client + 1);
          assert.ok(m.column.scroll <= m.column.client + 1, 'long content stays inside the reading column');
          t.diagnostic(JSON.stringify({ host: m.host, available: m.available, column: m.column, track: m.track }));
        };
        await page.locator('[data-message-piano-ready="true"][data-message-piano]').waitFor();
        const m = await measure();
        // #5685 reserves room for the 28px latest control beside the piano.
        assert.deepEqual(m.padding, { left: 16, right: 72 }, 'the piano and latest control own the reserved gutter');
        assertReadingGeometry(m);
        assert.equal(m.cat.width, m.column.width);
        const rail = await cat.locator('[data-reply-color-rail]').evaluate((node) => {
          const s = getComputedStyle(node);
          return {
            width: s.borderLeftWidth,
            padding: s.paddingLeft,
            background: s.backgroundColor,
            color: s.borderLeftColor,
          };
        });
        assert.equal(rail.width, '3px');
        assert.equal(rail.padding, '16px');
        assert.equal(rail.background, 'rgba(0, 0, 0, 0)');
        assert.notEqual(rail.color, 'rgba(0, 0, 0, 0)');
        const artwork = await cat.getByText('阅读栏中的作品', { exact: true }).evaluate((node) => {
          const r = node.parentElement.getBoundingClientRect();
          return { left: r.left, right: r.right };
        });
        assert.ok(artwork.left >= m.column.x - 1 && artwork.right <= m.column.right + 1);
        assert.ok(m.human.width <= m.column.width * 0.8 + 1);
        assert.ok(Math.abs(m.human.right - m.column.right) <= 1);
        assert.ok(m.line.right <= m.column.right + 1);
        assert.ok(m.host.scroll <= m.host.client + 1);
        assert.equal(await cat.getByTestId('reply-status-param').count(), 0);
        await cat.getByTestId('reply-record-toggle').click();
        await cat.getByTestId('reply-record-tool-command').getByRole('button').click();
        assert.ok((await cat.getByTestId('reply-record').innerText()).includes('long argument '.repeat(25).trim()));
        assertReadingGeometry(await measure());
        await cat.getByTestId('reply-record-toggle').click();
        await capture(page, `reading-${width}-${base}`);
        if (width === 1920) {
          await page.evaluate(() => {
            window.__readingNode = document.querySelector('[data-message-id="reading-cat"]');
          });
          await page.evaluate(() => window.__f322Chat.presentation('classic'));
          assert.ok(
            await page.evaluate(
              () => window.__readingNode === document.querySelector('[data-message-id="reading-cat"]'),
            ),
          );
          assert.ok((await measure()).column.width > 720);
          assert.equal(await page.locator('[data-reply-color-rail]').count(), 0);
          await page.evaluate(() => window.__f322Chat.presentation('v2'));
          await page.setViewportSize({ width: 700, height: 900 });
          await page.locator('[data-message-piano-ready="true"][data-message-piano]').waitFor();
          assert.ok(
            await page.evaluate(
              () => window.__readingNode === document.querySelector('[data-message-id="reading-cat"]'),
            ),
          );
          const narrow = await measure();
          assert.deepEqual(narrow.padding, { left: 16, right: 72 });
          assertReadingGeometry(narrow);
        }
      } catch (error) {
        failure = error;
        await captureFailure(page, `reading-${width}`, error);
        throw error;
      } finally {
        if (failure) await page.close();
        else await closeProof(proof);
      }
    });
  }
}
