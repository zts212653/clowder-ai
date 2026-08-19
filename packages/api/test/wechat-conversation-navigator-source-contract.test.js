import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const nativePaths = {
  models: fileURLToPath(
    new URL('../src/plugins/wechat-visible-reader/native/WeChatReaderModels.swift', import.meta.url),
  ),
  core: fileURLToPath(new URL('../src/plugins/wechat-visible-reader/native/WeChatReaderCore.swift', import.meta.url)),
  layout: fileURLToPath(
    new URL('../src/plugins/wechat-visible-reader/native/WeChatLayoutGuard.swift', import.meta.url),
  ),
  navigationModels: fileURLToPath(
    new URL('../src/plugins/wechat-visible-reader/native/WeChatNavigationModels.swift', import.meta.url),
  ),
  navigator: fileURLToPath(
    new URL('../src/plugins/wechat-visible-reader/native/WeChatConversationNavigator.swift', import.meta.url),
  ),
  fixtures: fileURLToPath(
    new URL('../src/plugins/wechat-visible-reader/native/WeChatNavigationFixtures.swift', import.meta.url),
  ),
  cli: fileURLToPath(new URL('../src/plugins/wechat-visible-reader/native/WeChatVisibleReader.swift', import.meta.url)),
};
const runnerPath = fileURLToPath(new URL('../src/plugins/wechat-visible-reader/native-runner.ts', import.meta.url));

describe('WeChat conversation navigator source contract', () => {
  it('isolates UI events in the allowlisted navigator and excludes send-capable APIs', () => {
    const sources = Object.fromEntries(
      Object.entries(nativePaths).map(([name, path]) => [name, readFileSync(path, 'utf8')]),
    );
    const allNative = Object.values(sources).join('\n');

    for (const [name, source] of Object.entries(sources)) {
      if (name === 'navigator') assert.match(source, /\bCGEvent\b/u);
      else assert.doesNotMatch(source, /\bCGEvent\b/u);
    }

    for (const forbidden of [
      /keyCode\s*:\s*36/u,
      /virtualKey\s*:\s*36/u,
      /\bNSAppleScript\b/u,
      /osascript/iu,
      /session\.db/iu,
      /process[_ -]?memory/iu,
      /re-?sign/iu,
      /messageInput/iu,
      /openURL/iu,
    ]) {
      assert.doesNotMatch(allNative, forbidden);
    }

    assert.match(sources.navigationModels, /enum NavigationAction/u);
    for (const action of ['openSearch', 'typeContact', 'selectExactResult', 'scrollChatBody', 'restoreScene']) {
      assert.match(sources.navigationModels, new RegExp(`case ${action}\\b`, 'u'));
    }
    assert.match(sources.navigator, /func clickExactResult\([^)]*token: SearchLayoutToken/u);
    assert.match(sources.navigator, /func scrollChatBody\([^)]*token: ConversationLayoutToken/u);
  });

  it('compiles a source-hash keyed executable without a shell', () => {
    const runner = readFileSync(runnerPath, 'utf8');

    assert.match(runner, /createHash\(['"]sha256['"]\)/u);
    assert.match(runner, /['"]swiftc['"]/u);
    assert.match(runner, /cat-cafe-wechat-reader-/u);
    assert.doesNotMatch(runner, /shell\s*:\s*true/u);
    assert.doesNotMatch(runner, /exec\s*\(/u);
  });

  it('uses relative layout evidence and the mechanism-accurate boundary name', () => {
    const layout = readFileSync(nativePaths.layout, 'utf8');

    assert.match(layout, /strongestMedianBoundaryDifference/u);
    assert.match(layout, /backgroundVariation/u);
    assert.doesNotMatch(layout, /persistentEdge/u);
  });

  it('establishes a restorable scene before activating WeChat', () => {
    const navigator = readFileSync(nativePaths.navigator, 'utf8');
    const originalFrontApplication = navigator.indexOf('let originalFrontApplicationProcessId');
    const locateTarget = navigator.indexOf('ReaderEngine.locateTarget()', originalFrontApplication);
    const captureScene = navigator.indexOf('captureScene(', locateTarget);
    const activateWeChat = navigator.indexOf('try await activateWeChat(cancellation:', captureScene);

    assert.ok(originalFrontApplication >= 0);
    assert.ok(locateTarget > originalFrontApplication);
    assert.ok(captureScene > locateTarget);
    assert.ok(activateWeChat > captureScene);
    assert.match(navigator, /activate\(options: \[\.activateAllWindows\]\)/u);
    assert.match(navigator, /captureScene\([^)]*originalFrontApplicationProcessId:/u);
  });

  it('uses the same older-history scroll direction for reading and anchor restoration', () => {
    const navigator = readFileSync(nativePaths.navigator, 'utf8');

    assert.match(navigator, /olderMessagesScrollDelta:\s*Int32\s*=\s*720/u);
    assert.equal((navigator.match(/scrollChatBody\(olderMessagesScrollDelta,/gu) ?? []).length, 2);
    assert.doesNotMatch(navigator, /scrollChatBody\(-720,/u);
  });

  it('turns SIGTERM into cooperative cancellation so scene restoration can run', () => {
    const cli = readFileSync(nativePaths.cli, 'utf8');
    const navigator = readFileSync(nativePaths.navigator, 'utf8');

    assert.match(cli, /DispatchSource\.makeSignalSource\(\s*signal:\s*SIGTERM/u);
    assert.match(cli, /signal\(SIGTERM,\s*SIG_IGN\)/u);
    assert.match(navigator, /cancellation\.check\(\)/u);
    assert.match(navigator, /let restore = await restoreScene\(snapshot\)/u);
  });
});
