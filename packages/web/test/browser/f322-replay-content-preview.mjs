import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';

const runLabel = process.env.REPLAY_PROBE_LABEL ?? 'first-preview';
if (!/^[a-z0-9-]+$/.test(runLabel)) throw new Error('Invalid replay probe output label');
const out = new URL(`../../../../.cat-cafe/tmp/replay/${runLabel}/`, import.meta.url).pathname;
await mkdir(out, { recursive: true });
const checks = [];
const errors = [];
const check = (name, passed, detail) => checks.push({ name, passed, detail });
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('pageerror', (error) => errors.push(String(error)));
  await page.goto('http://localhost:51184/dev/f322-replay-preview?shell=v2', { waitUntil: 'domcontentloaded' });
  const replay = page.locator('[data-testid="thread-replay-v2"]');
  await replay.getByRole('button', { name: '播放回放', exact: true }).waitFor();
  const slider = replay.getByRole('slider', { name: '回放进度' });
  const state = () =>
    replay.evaluate((root) => {
      const luminance = (color) => {
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = 1;
        const context = canvas.getContext('2d');
        context.fillStyle = color;
        context.fillRect(0, 0, 1, 1);
        const [r, g, b] = context.getImageData(0, 0, 1, 1).data;
        return 0.2126 * r + 0.7152 * g + 0.0722 * b;
      };
      return {
        nodeSame: window.__replayNode === root,
        state: root.dataset.playbackState,
        index: root.querySelector('input[type=range]')?.value,
        max: root.querySelector('input[type=range]')?.max,
        speed: root.querySelector('select')?.value,
        width: root.clientWidth,
        scrollWidth: root.scrollWidth,
        theme: document.documentElement.dataset.theme,
        background: getComputedStyle(root).backgroundColor,
        selectedBackground: getComputedStyle(root.querySelector('.replay-v2-mode button[aria-pressed="true"]'))
          .backgroundColor,
        fontSize: getComputedStyle(root).fontSize,
        modeFontSize: getComputedStyle(root.querySelector('.replay-v2-mode button')).fontSize,
        counterHeight: root.querySelector('.replay-v2-counter')?.getBoundingClientRect().height,
        stageLuminance: luminance(getComputedStyle(root).backgroundColor),
        liveLuminance: luminance(getComputedStyle(root.closest('main')).backgroundColor),
        text: root.textContent.slice(0, 600),
      };
    });
  await replay.evaluate((root) => {
    window.__replayNode = root;
  });
  const initial = await state();
  check('original pipeline fetched replayable events', Number(initial.max) > 4, initial);
  const opaque = (value) => value !== 'transparent' && value !== 'rgba(0, 0, 0, 0)' && !/\/ 0\)$/.test(value);
  check(
    'light stage and selected control use opaque theme roles',
    opaque(initial.background) && opaque(initial.selectedBackground),
    initial,
  );
  check(
    'light replay stage is deeper than the live chat role',
    initial.stageLuminance < initial.liveLuminance,
    initial,
  );
  check(
    'original typography tokens resolve in actual host',
    initial.fontSize === '16px' && initial.modeFontSize === '12px',
    initial,
  );
  await replay.getByRole('button', { name: '播放回放', exact: true }).click();
  await page.waitForTimeout(100);
  await replay.getByRole('button', { name: '暂停回放', exact: true }).click();
  check('actual owner plays then pauses', (await state()).state === 'paused', await state());
  await replay.locator('select[aria-label="播放速度"]').selectOption('50');
  const target = Math.min(4, Number(initial.max));
  await slider.evaluate((element, value) => {
    element.value = String(value);
    element.dispatchEvent(new Event('input', { bubbles: true }));
  }, target);
  const before = await state();
  check('original seek and speed applied', before.index === String(target) && before.speed === '50', before);
  const requestsBefore = await (await page.request.get('http://localhost:51185/fixture/requests')).json();
  const ownerReads = (requests) =>
    requests.filter((request) => request.path === '/api/messages' || /\/sessions/.test(request.path)).length;
  for (const width of [200, 225, 960]) {
    await page.getByRole('button', { name: `${width}px`, exact: true }).click();
    await page.waitForTimeout(150);
    const next = await state();
    check(
      `${width}px remains same player/playhead/speed and fits`,
      next.nodeSame &&
        next.index === before.index &&
        next.speed === before.speed &&
        next.width === width &&
        next.scrollWidth <= next.width,
      next,
    );
    check(`${width}px counter stays in two readable lines`, next.counterHeight > 0 && next.counterHeight <= 40, next);
    await page.screenshot({ path: `${out}${width}-light.png` });
  }
  const requestsAfter = await (await page.request.get('http://localhost:51185/fixture/requests')).json();
  check(
    'resize does not refetch messages or transcripts',
    ownerReads(requestsBefore.requests) === ownerReads(requestsAfter.requests),
    requestsAfter.requests,
  );
  check(
    'sealed transcript read, active session not read',
    requestsAfter.requests.some((request) => request.path === '/api/sessions/sealed-fixture/events') &&
      !requestsAfter.requests.some((request) => request.path === '/api/sessions/active-fixture/events'),
  );
  await replay.getByRole('button', { name: '保真', exact: true }).click();
  check(
    'faithful shows original thinking',
    (await replay.getByText('保留真实来源，不能把夹具当成真实验收。', { exact: true }).count()) > 0,
  );
  await page.getByRole('button', { name: '暗色', exact: true }).click();
  await page.waitForTimeout(250);
  const dark = await state();
  check(
    'actual selected dark theme differs with opaque stage and selection',
    dark.theme === 'dark' &&
      opaque(dark.background) &&
      opaque(dark.selectedBackground) &&
      dark.background !== before.background,
    dark,
  );
  check('dark replay stage is deeper than the live chat role', dark.stageLuminance < dark.liveLuminance, dark);
  await page.screenshot({ path: `${out}960-dark.png` });
  await page.goto('http://localhost:51184/dev/f322-replay-preview?shell=v2&scenario=denied', {
    waitUntil: 'domcontentloaded',
  });
  await page.getByRole('alert').filter({ hasText: '回放暂不可用' }).waitFor();
  check(
    'real HTTP 403 remains an error, never empty',
    (await page.getByText(/Failed to fetch thread sessions: 403/).count()) > 0,
  );
  await page.screenshot({ path: `${out}denied.png` });
  await page.goto('http://localhost:51184/dev/f322-replay-preview?shell=v2&scenario=empty', {
    waitUntil: 'domcontentloaded',
  });
  await page.getByText('暂无可回放的记录', { exact: true }).waitFor();
  check(
    'real empty response disables playback',
    await page.getByRole('button', { name: '播放回放', exact: true }).isDisabled(),
  );
  await page.screenshot({ path: `${out}empty.png` });
  check('no page errors', errors.length === 0, errors);
} catch (error) {
  check('preview probe completed', false, String(error));
} finally {
  await browser.close();
  await writeFile(
    `${out}report.json`,
    JSON.stringify(
      {
        boundary: 'Original content/orchestrator with isolated HTTP API fixtures; not C Workspace assembly or Alpha.',
        checks,
        errors,
      },
      null,
      2,
    ),
  );
}
console.log(JSON.stringify({ checks: checks.length, failed: checks.filter((item) => !item.passed) }));
if (checks.some((item) => !item.passed)) process.exitCode = 1;
