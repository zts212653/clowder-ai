import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { closeIsolatedBrowser, resolveChromeExecutable } from '../scripts/f247-personal-chrome-host-spike.mjs';

const apiRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const extensionRoot = join(apiRoot, 'src/plugins/cloud-cat-personal-host/extension');

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

  it('uses a single ChatGPT conversation host scope and no invasive browser permissions', async () => {
    const manifest = JSON.parse(await readFile(join(extensionRoot, 'manifest.json'), 'utf8'));
    assert.equal(manifest.manifest_version, 3);
    assert.deepEqual(manifest.permissions.sort(), ['nativeMessaging', 'tabs']);
    assert.deepEqual(manifest.host_permissions, ['https://chatgpt.com/c/*']);
    assert.equal(JSON.stringify(manifest).includes('<all_urls>'), false);
    for (const forbidden of ['cookies', 'debugger', 'webRequest', 'history', 'clipboardRead']) {
      assert.equal(manifest.permissions.includes(forbidden), false, `forbidden permission: ${forbidden}`);
    }
  });

  it('does not activate, select, focus, navigate, or privately fetch from ChatGPT', async () => {
    const sources = await Promise.all(
      ['service-worker.js', 'content-script.js', 'chatgpt-page-adapter.mjs'].map((name) =>
        readFile(join(extensionRoot, name), 'utf8'),
      ),
    );
    const source = sources.join('\n');
    for (const forbidden of [
      'tabs.update',
      'windows.update',
      '.focus(',
      'active: true',
      'fetch(',
      'XMLHttpRequest',
      'document.cookie',
    ]) {
      assert.equal(source.includes(forbidden), false, `forbidden extension behavior: ${forbidden}`);
    }
    assert.match(sources[0], /TextEncoder/);
    assert.match(sources[0], /128 \* 1024/);
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
    assert.deepEqual(manifest.web_accessible_resources, [
      {
        resources: ['chatgpt-page-adapter.mjs'],
        matches: ['https://chatgpt.com/*'],
      },
    ]);
  });

  it('keeps a full-seam Native Messaging integration test in the focused spike gate', async () => {
    const packageJson = JSON.parse(await readFile(join(apiRoot, 'package.json'), 'utf8'));
    const testSource = await readFile(
      join(apiRoot, 'test/personal-chrome-native-messaging-integration.test.js'),
      'utf8',
    );

    assert.match(
      packageJson.scripts['test:f247-chrome-host-spike'],
      /personal-chrome-native-messaging-integration\.test\.js/,
    );
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
