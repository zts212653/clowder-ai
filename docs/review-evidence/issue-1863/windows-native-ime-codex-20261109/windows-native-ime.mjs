import { execFileSync, spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';

const root = path.resolve(import.meta.dirname, '../cat-cafe-issue1863-link-preview');
const { chromium } = createRequire(path.join(root, 'packages/web/package.json'))('playwright');
const evidence =
  process.env.ISSUE1863_NATIVE_EVIDENCE ?? path.join(os.tmpdir(), 'cat-cafe-evidence/issue1863-windows-native');
await mkdir(evidence, { recursive: true });
const bridge = spawn(
  'powershell.exe',
  ['-NoProfile', '-Command', await readFile(new URL('./windows-native-keyboard.ps1', import.meta.url), 'utf8')],
  { windowsHide: true },
);
bridge.stderr.pipe(process.stderr);
const pending = new Map();
let serial = 0;
createInterface({ input: bridge.stdout }).on('line', (line) => {
  const response = JSON.parse(line);
  pending.get(response.id)?.resolve(response.result);
  pending.delete(response.id);
});
bridge.on('exit', (code) => {
  for (const entry of pending.values()) entry.reject(new Error(`Native bridge exited ${code}`));
});
function native(action, args = {}) {
  const id = ++serial;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    bridge.stdin.write(JSON.stringify({ id, action, ...args }) + '\n');
  });
}
const original = await native('status');
console.log('Native bridge ready; desktop=' + original.desktop);
if (original.desktop !== 'Default') throw new Error('Interactive Windows desktop is unavailable');
const browser = await chromium.launch({
  headless: false,
  channel: 'msedge',
  args: ['--no-proxy-server', '--disable-gpu', '--window-position=0,0', '--start-maximized'],
});
console.log('Owned Chromium launched');
const context = await browser.newContext({ viewport: null, locale: 'zh-CN' });
const page = await context.newPage();
console.log('Blank page title: ' + (await page.title()));
await page.goto('data:text/html,<title>Issue1863-native-diagnostic</title><p>owned test window</p>', {
  timeout: 10000,
});
console.log('Data page ready');
const title = `Issue1863-NativeIME-${Date.now()}`;
const base = process.env.ISSUE1863_NATIVE_URL ?? 'http://127.0.0.1:4174/';
const baseline = 'https://example.com/abCD 说明';
const report = {
  source: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  browser: browser.version(),
  entry: base + ' production ChatInput component host; API/submission fixtures',
  method:
    'Native Windows SendInput scan codes for ASCII pinyin, Space, Escape and Ctrl+Z/Ctrl+Y; no Chinese paste or DOM/CDP composition injection',
  startedAt: new Date().toISOString(),
  desktop: original.desktop,
  results: [],
};

async function snapshot() {
  return page.evaluate(() => {
    const input = document.querySelector('[data-testid="chat-input-composer-row"] textarea');
    const mirror = document.querySelector('[data-testid="composer-link-mirror"]');
    return {
      value: input.value,
      start: input.selectionStart,
      end: input.selectionEnd,
      mirrorActive: mirror?.getAttribute('data-active') ?? null,
      textColor: getComputedStyle(input).color,
      ranges: Array.from(document.querySelectorAll('[data-link-href]')).map((el) => ({
        text: el.textContent,
        start: el.getAttribute('data-link-start'),
        end: el.getAttribute('data-link-end'),
        href: el.getAttribute('data-link-href'),
      })),
      events: window.nativeImeEvents,
    };
  });
}
async function seed(start, end = start, classic = false) {
  await page.goto(`${base}?classic=${classic ? 1 : 0}`, { waitUntil: 'domcontentloaded', timeout: 120000 });
  console.log('Component host HTML ready');
  const input = page.locator('[data-testid="chat-input-composer-row"] textarea').first();
  await input.fill(baseline);
  console.log('Component input ready');
  await page.evaluate(
    ({ title, start, end }) => {
      document.title = title;
      const input = document.querySelector('[data-testid="chat-input-composer-row"] textarea');
      input.focus();
      input.setSelectionRange(start, end);
      window.nativeImeEvents = [];
      for (const type of [
        'compositionstart',
        'compositionupdate',
        'compositionend',
        'beforeinput',
        'input',
        'keydown',
        'keyup',
      ]) {
        input.addEventListener(type, (event) =>
          window.nativeImeEvents.push({
            type: event.type,
            data: event.data,
            key: event.key,
            isTrusted: event.isTrusted,
            isComposing: event.isComposing,
            inputType: event.inputType,
            value: input.value,
            start: input.selectionStart,
            end: input.selectionEnd,
          }),
        );
      }
    },
    { title, start, end },
  );
  const focus = await native('focus', { title });
  console.log('Native focus result: ' + JSON.stringify(focus));
  if (!focus.foreground && process.argv.includes('--await-focus')) {
    console.log(
      'AWAITING_USER_FOCUS: click the owned Issue1863-NativeIME test browser and select a Chinese input method',
    );
    for (let attempt = 0; attempt < 300; attempt++) {
      await page.waitForTimeout(2000);
      if ((await native('focusState')).foreground) {
        focus.foreground = true;
        break;
      }
    }
  }
  if (!focus.foreground) throw new Error('Cannot focus owned test browser');
  return native('chinese');
}
async function keys(values, modifiers = []) {
  await native('keys', { keys: values, modifiers });
  await page.waitForTimeout(300);
}
async function pinyin() {
  await keys(Array.from('ZHONGWEN', (char) => char.charCodeAt(0)));
  await page.waitForTimeout(500);
}
try {
  for (const classic of process.argv.includes('--classic-only')
    ? [true]
    : process.argv.includes('--probe')
      ? [false]
      : [false, true]) {
    for (const [name, start, end, cancel, expected] of [
      ['tail-confirm', 24, 24, false, 'https://example.com/abCD中文 说明'],
      ['middle-confirm', 22, 22, false, 'https://example.com/ab中文CD 说明'],
      ['tail-cancel', 24, 24, true, baseline],
      ['middle-cancel', 22, 22, true, baseline],
      ['replace', 0, 24, false, '中文 说明'],
    ]) {
      const keyboard = await seed(start, end, classic);
      await pinyin();
      const during = await snapshot();
      await native('capture', { path: path.join(evidence, `${classic ? 'classic' : 'v2'}-${name}-candidate.png`) });
      if (!during.events.some((event) => event.type === 'compositionstart')) {
        report.results.push({ classic, name, keyboard, during, error: 'No native composition observed' });
        throw new Error('Native pinyin did not start; inspect actual candidate screenshot before proceeding');
      }
      if (process.argv.includes('--probe')) {
        report.results.push({ classic, name, keyboard, during });
        break;
      }
      await keys([cancel ? 27 : 32]);
      if (cancel && (await snapshot()).value !== baseline) await keys([27]);
      const after = await snapshot();
      report.results.push({ classic, name, keyboard, during, after, pass: after.value === expected });
      if (after.value !== expected) throw new Error(`${name}: unexpected native result ${JSON.stringify(after.value)}`);
      if (name === 'replace') {
        await keys([90], [17]);
        const undo = await snapshot();
        await keys([89], [17]);
        const redo = await snapshot();
        report.results.push({
          classic,
          name: 'undo-redo',
          undo,
          redo,
          pass: undo.value === baseline && redo.value === '中文 说明',
        });
      }
    }
  }
} catch (error) {
  report.error = error.stack;
  console.error(error.stack);
  await page.screenshot({ path: path.join(evidence, 'setup-failure.png'), timeout: 5000 }).catch(() => {});
  throw error;
} finally {
  report.finishedAt = new Date().toISOString();
  report.restore = bridge.exitCode === null ? await native('restore') : { bridgeExited: bridge.exitCode };
  await writeFile(
    path.join(evidence, process.argv.includes('--probe') ? 'probe.json' : 'results.json'),
    JSON.stringify(report, null, 2),
  );
  await browser.close();
  console.log('Owned Chromium closed; restoring original foreground');
  console.log(
    JSON.stringify({
      restore: report.restore,
      source: report.source,
      results: report.results.map(({ classic, name, pass, error }) => ({ classic, name, pass, error })),
      evidence,
    }),
  );
  bridge.stdin.end();
}
