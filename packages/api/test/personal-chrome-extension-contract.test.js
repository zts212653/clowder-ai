import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  PERSONAL_CHROME_BRAND_ICON_SIZES,
  renderPersonalChromeBrandIcons,
} from '../scripts/f247-personal-chrome-brand-assets.mjs';
import { closeIsolatedBrowser, resolveChromeExecutable } from '../scripts/f247-personal-chrome-host-spike.mjs';

const apiRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = join(apiRoot, '../..');
const extensionRoot = join(apiRoot, 'src/plugins/cloud-cat-personal-host/extension');
const forbiddenExtensionBehaviors = [
  'tabs.update',
  'tabs.reload',
  'tabs.create',
  'tabs.highlight',
  'tabs.move',
  'windows.update',
  'windows.create',
  'active: true',
  'fetch(',
  'XMLHttpRequest',
  'document.cookie',
];

function assertNoForbiddenExtensionBehavior(source) {
  for (const forbidden of forbiddenExtensionBehaviors) {
    assert.equal(source.includes(forbidden), false, `forbidden extension behavior: ${forbidden}`);
  }
}

describe('personal Chrome extension contract', () => {
  it('resolves an explicit override before platform defaults', async () => {
    const attempted = [];
    const resolved = await resolveChromeExecutable({
      platform: 'linux',
      env: { F247_CHROME_PATH: '/opt/chrome-for-testing/chrome' },
      accessExecutable: async (candidate) => {
        attempted.push(candidate);
        if (candidate !== '/opt/chrome-for-testing/chrome') throw new Error('missing');
      },
    });

    assert.equal(resolved, '/opt/chrome-for-testing/chrome');
    assert.deepEqual(attempted, ['/opt/chrome-for-testing/chrome']);
  });

  it('falls through platform-specific Chrome candidates without using the macOS path', async () => {
    const attempted = [];
    const resolved = await resolveChromeExecutable({
      platform: 'linux',
      env: {},
      accessExecutable: async (candidate) => {
        attempted.push(candidate);
        if (candidate !== '/usr/bin/chromium') throw new Error('missing');
      },
    });

    assert.equal(resolved, '/usr/bin/chromium');
    assert.equal(attempted.includes('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'), false);
  });

  it('builds Windows candidates from per-user and program installation roots', async () => {
    const resolved = await resolveChromeExecutable({
      platform: 'win32',
      env: { PROGRAMFILES: 'C:\\Program Files', LOCALAPPDATA: 'C:\\Users\\cat\\AppData\\Local' },
      accessExecutable: async () => undefined,
    });

    assert.match(resolved, /Program Files.*Google.*Chrome.*chrome\.exe/);
    assert.equal(resolved.includes('/Applications/'), false);
  });

  it('hard-stops only the isolated fixture browser when graceful close stalls', async () => {
    let signal = null;
    const browser = {
      close: () => new Promise(() => undefined),
      disconnect: () => undefined,
      process: () => ({
        kill: (receivedSignal) => {
          signal = receivedSignal;
        },
      }),
    };

    const outcome = await closeIsolatedBrowser(browser, { timeoutMs: 10 });

    assert.equal(outcome, 'forced');
    assert.equal(signal, 'SIGKILL');
  });

  it('uses a single ChatGPT conversation host scope and only the scoped reinjection permission', async () => {
    const manifest = JSON.parse(await readFile(join(extensionRoot, 'manifest.json'), 'utf8'));
    assert.equal(manifest.manifest_version, 3);
    assert.deepEqual(manifest.icons, {
      16: 'icons/gpt-pro-16.png',
      32: 'icons/gpt-pro-32.png',
      48: 'icons/gpt-pro-48.png',
      128: 'icons/gpt-pro-128.png',
    });
    assert.deepEqual(manifest.action, {
      default_title: '授权此会话',
      default_icon: manifest.icons,
    });
    assert.deepEqual(manifest.permissions.sort(), ['alarms', 'nativeMessaging', 'scripting', 'tabs']);
    assert.deepEqual(manifest.host_permissions, ['https://chatgpt.com/c/*']);
    assert.equal(JSON.stringify(manifest).includes('<all_urls>'), false);
    for (const forbidden of ['cookies', 'debugger', 'webRequest', 'history', 'clipboardRead']) {
      assert.equal(manifest.permissions.includes(forbidden), false, `forbidden permission: ${forbidden}`);
    }
  });

  it('keeps the manifest, worker, content script, and runtime revision contract aligned', async () => {
    const manifest = JSON.parse(await readFile(join(extensionRoot, 'manifest.json'), 'utf8'));
    const [worker, contentScriptEntry, contentScript, protocol] = await Promise.all([
      readFile(join(extensionRoot, 'service-worker.js'), 'utf8'),
      readFile(join(extensionRoot, 'content-script-entry.mjs'), 'utf8'),
      readFile(join(extensionRoot, 'content-script.js'), 'utf8'),
      readFile(join(apiRoot, 'src/domains/cats/services/cloud-bridge/personal-chrome-host/protocol.ts'), 'utf8'),
    ]);

    assert.equal(manifest.version, '0.2.5');
    for (const source of [worker, contentScriptEntry, contentScript, protocol]) assert.match(source, /0\.2\.5/);
  });

  it('checks in deterministic normalized icons derived from the formal gpt-pro repository asset', async () => {
    const source = await readFile(join(apiRoot, '../web/public/avatars/gpt-pro.png'));
    const expected = await renderPersonalChromeBrandIcons(source);

    assert.deepEqual([...expected.keys()], PERSONAL_CHROME_BRAND_ICON_SIZES);
    for (const [size, bytes] of expected) {
      assert.deepEqual(await readFile(join(extensionRoot, `icons/gpt-pro-${size}.png`)), bytes);
    }
  });

  it('does not activate, select, focus, navigate, or privately fetch from ChatGPT', async () => {
    const sources = await Promise.all(
      [
        'service-worker.js',
        'content-script-entry.mjs',
        'content-script.js',
        'chatgpt-page-adapter.mjs',
        'chatgpt-page-contract.mjs',
        'chatgpt-composer-transaction.mjs',
      ].map((name) => readFile(join(extensionRoot, name), 'utf8')),
    );
    const source = sources.join('\n');
    assertNoForbiddenExtensionBehavior(source);
    assert.match(sources[0], /TextEncoder/);
    assert.match(sources[0], /128 \* 1024/);
  });

  it('rejects every tab or window mutation surface named by the zero-focus contract', () => {
    for (const forbidden of ['tabs.reload', 'tabs.create', 'windows.create', 'tabs.highlight', 'tabs.move']) {
      assert.throws(
        () => assertNoForbiddenExtensionBehavior(`chrome.${forbidden}()`),
        new RegExp(`forbidden extension behavior: ${forbidden.replace('.', '\\.')}`),
      );
    }
  });

  it('loads the page adapter only on ChatGPT conversation pages', async () => {
    const manifest = JSON.parse(await readFile(join(extensionRoot, 'manifest.json'), 'utf8'));
    assert.deepEqual(manifest.content_scripts, [
      {
        matches: ['https://chatgpt.com/c/*'],
        js: ['content-script.js'],
        run_at: 'document_idle',
      },
    ]);
    assert.equal(manifest.web_accessible_resources, undefined);
    const contentScript = await readFile(join(extensionRoot, 'content-script.js'), 'utf8');
    assert.match(contentScript, /^\/\/ Generated by scripts\/build-f247-personal-chrome-extension\.mjs\./);
    assert.equal(contentScript.includes('import('), false);
  });

  it('keeps executable extension artifacts below the repository hard line limit', async () => {
    for (const name of ['content-script.js', 'service-worker.js']) {
      const source = await readFile(join(extensionRoot, name), 'utf8');
      const lineCount = source.split('\n').length;

      assert.ok(lineCount <= 350, `${name} has ${lineCount} lines (max 350)`);
    }
  });

  it('keeps the F247 install and state modules below the repository hard line limit', async () => {
    for (const relativePath of [
      'scripts/f247-personal-chrome-install-cli-options.mjs',
      'scripts/f247-personal-chrome-install.mjs',
      'test/personal-chrome-plugin-state-route-exact.test.js',
      'test/personal-chrome-plugin-state.test.js',
    ]) {
      const source = await readFile(join(apiRoot, relativePath), 'utf8');
      const lineCount = source.trimEnd().split('\n').length;

      assert.ok(lineCount <= 350, `${relativePath} has ${lineCount} lines (max 350)`);
    }
  });

  it('does not grow the legacy oversized F247 truth and Native Messaging seam', async () => {
    for (const { path, maxLines } of [
      { path: join(repoRoot, 'docs/features/F247-cloud-cat-family.md'), maxLines: 915 },
      { path: join(apiRoot, 'test/personal-chrome-native-messaging-integration.test.js'), maxLines: 467 },
    ]) {
      const source = await readFile(path, 'utf8');
      const lineCount = source.trimEnd().split('\n').length;

      assert.ok(lineCount <= maxLines, `${path} has ${lineCount} lines (ratcheted max ${maxLines})`);
    }
  });

  it('keeps the full-seam and route-exact regressions in the focused spike gate', async () => {
    const packageJson = JSON.parse(await readFile(join(apiRoot, 'package.json'), 'utf8'));
    const testSource = await readFile(
      join(apiRoot, 'test/personal-chrome-native-messaging-integration.test.js'),
      'utf8',
    );

    for (const requiredTest of [
      'personal-chrome-native-messaging-integration.test.js',
      'personal-chrome-native-messaging-watchdog.test.js',
      'personal-chrome-plugin-state-route-exact.test.js',
    ]) {
      assert.match(packageJson.scripts['test:f247-chrome-host-spike'], new RegExp(requiredTest.replaceAll('.', '\\.')));
    }
    for (const requiredBoundary of [
      'PersonalChromeHostAdapter',
      'createNativeHostBridge',
      'connectNative',
      'NativeMessageDecoder',
      'chrome.tabs.sendMessage',
    ]) {
      assert.match(testSource, new RegExp(`${requiredBoundary.replaceAll('.', '\\.')}\\b`));
    }
  });
});
