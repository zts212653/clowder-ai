import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

await import('tsx/esm');
const { cleanOrphanAgentBrowserChrome, parseAgentBrowserChromeCleanupPids, parseOrphanPids } = await import(
  '../src/utils/orphan-chrome-cleaner.ts'
);

const fakeLog = {
  info() {},
  warn() {},
};

// --- ps -eo ppid=,pid=,args= format: "PPID PID ARGS" ---

// Orphan Chrome: ppid=1 (parent exited), Chrome binary, agent-browser user-data-dir
const CHROME_ORPHAN =
  '    1 78911 /Applications/Google Chrome.app/Contents/Frameworks/Google Chrome Framework.framework/Versions/147.0.7727.102/Helpers/Google Chrome Helper (Renderer).app/Contents/MacOS/Google Chrome Helper (Renderer) --type=renderer --user-data-dir=/var/folders/41/tmp/agent-browser-chrome-586c6846 --remote-debugging-port=0';

// Active Chrome: ppid!=1 (parent still alive), same Chrome + marker — NOT an orphan
const ACTIVE_CHROME =
  '78800 78911 /Applications/Google Chrome.app/Contents/Frameworks/Google Chrome Framework.framework/Versions/147.0.7727.102/Helpers/Google Chrome Helper (Renderer).app/Contents/MacOS/Google Chrome Helper (Renderer) --type=renderer --user-data-dir=/var/folders/41/tmp/agent-browser-chrome-586c6846';

// ps -eo ppid=,pid=,etime=,args= format, used by the startup cleaner to catch stale non-orphans.
const STALE_CHROME_MAIN =
  '21400 21424 04:00:00 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome --type=browser --user-data-dir=/var/folders/41/tmp/agent-browser-chrome-stale --remote-debugging-port=0';
const STALE_CHROME_HELPER =
  '21424 21425 04:00:00 /Applications/Google Chrome.app/Contents/Frameworks/Google Chrome Framework.framework/Versions/147.0.7727.102/Helpers/Google Chrome Helper (Renderer).app/Contents/MacOS/Google Chrome Helper (Renderer) --type=renderer --user-data-dir=/var/folders/41/tmp/agent-browser-chrome-stale';
const RECENT_CHROME_MAIN =
  '21400 21426 05:00 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome --type=browser --user-data-dir=/var/folders/41/tmp/agent-browser-chrome-active --remote-debugging-port=0';
const RECENT_CHROME_HELPER =
  '21426 21427 05:00 /Applications/Google Chrome.app/Contents/Frameworks/Google Chrome Framework.framework/Versions/147.0.7727.102/Helpers/Google Chrome Helper (Renderer).app/Contents/MacOS/Google Chrome Helper (Renderer) --type=renderer --user-data-dir=/var/folders/41/tmp/agent-browser-chrome-active';

// Node/Claude process: ppid=1, prompt text contains BOTH "Chrome" AND "--user-data-dir=...agent-browser-chrome"
// This is the exact false positive scenario from review R2
const NODE_BOTH_KEYWORDS =
  '    1 70293 /home/user/claude -p Google Chrome Helper --user-data-dir=/tmp/agent-browser-chrome in prompt text';

// Node process: ppid=1, has marker but no Chrome keyword
const NODE_MARKER_ONLY = '    1 70294 /home/user/claude -p ... agent-browser-chrome marker in prompt text ...';

// Normal user Chrome: ppid=1, Chrome binary, but NO agent-browser user-data-dir
const NORMAL_CHROME =
  '    1 63814 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome --type=renderer --user-data-dir=/home/user/Application Support/Google/Chrome';

// Linux Chrome orphan (google-chrome-stable)
const LINUX_CHROME_ORPHAN =
  '    1 12345 /usr/bin/google-chrome-stable --type=renderer --user-data-dir=/tmp/agent-browser-chrome-abc123';

// Linux Chrome orphan (/opt/google/chrome/chrome)
const LINUX_OPT_CHROME_ORPHAN =
  '    1 12346 /opt/google/chrome/chrome --type=renderer --user-data-dir=/tmp/agent-browser-chrome-def456';

// go-rod orphan (e.g. xiaohongshu-mcp / any github.com/go-rod/rod consumer)
// LL-056 extension — same ownership pattern (user-data-dir), different upstream owner
const ROD_CHROME_ORPHAN =
  '    1 50001 /home/user/Chromium --type=renderer --user-data-dir=/var/folders/41/n9jlv4ps78b90cb9vkgwtdv00000gn/T/rod/user-data/93beb2e1cde1b932 --remote-debugging-port=0';

// Playwright orphan (puppeteer-like Chromium)
const PLAYWRIGHT_CHROME_ORPHAN =
  '    1 50002 /Applications/Chromium.app/Contents/MacOS/Chromium --type=renderer --user-data-dir=/var/folders/41/T/playwright_chromiumdev_profile-abc123 --remote-debugging-port=0';

// Puppeteer orphan
const PUPPETEER_CHROME_ORPHAN =
  '    1 50003 /Applications/Chromium.app/Contents/MacOS/Chromium --type=renderer --user-data-dir=/var/folders/41/T/puppeteer_dev_chrome_profile-XYZ789 --remote-debugging-port=0';

// User-managed Playwright debug profile — NOT a Playwright auto-generated temp profile.
// Must NOT be matched: the owner marker 'playwright_chromiumdev_profile-' is absent.
// (砚砚 P1 review: avoid SIGKILLing long-running manual Playwright sessions on startup.)
const USER_PLAYWRIGHT_DEBUG_PROFILE =
  '    1 50004 /Applications/Chromium.app/Contents/MacOS/Chromium --type=renderer --user-data-dir=/tmp/my-playwright-debug-profile --remote-debugging-port=0';

// Linux Playwright orphan — cached Chromium under ~/.cache/ms-playwright/.../chrome-linux/chrome
// (cloud codex P1: cross-platform completeness)
const LINUX_PLAYWRIGHT_CHROME_ORPHAN =
  '    1 50005 /home/runner/.cache/ms-playwright/chromium-1124/chrome-linux/chrome --type=renderer --user-data-dir=/tmp/playwright_chromiumdev_profile-linux-abc --remote-debugging-port=0';

// Linux Puppeteer orphan — cached Chromium under ~/.cache/puppeteer/.../chrome-linux64/chrome
const LINUX_PUPPETEER_CHROME_ORPHAN =
  '    1 50006 /home/runner/.cache/puppeteer/chrome/linux-120.0.6099.71/chrome-linux64/chrome --type=renderer --user-data-dir=/tmp/puppeteer_dev_chrome_profile-linux-xyz --remote-debugging-port=0';

// Linux Playwright headless-shell orphan — chrome-headless-shell-{ver}/chrome-headless-shell-linux64/chrome-headless-shell
// (砚砚 P1: full Chromium vs headless shell live in different cache dirs)
const LINUX_PLAYWRIGHT_HEADLESS_SHELL_ORPHAN =
  '    1 50007 /home/runner/.cache/ms-playwright/chrome-headless-shell-1124/chrome-headless-shell-linux64/chrome-headless-shell --type=renderer --user-data-dir=/tmp/playwright_chromiumdev_profile-hs-abc --remote-debugging-port=0';

// macOS Puppeteer headless-shell orphan — same shape but mac suffix
const MACOS_PUPPETEER_HEADLESS_SHELL_ORPHAN =
  '    1 50008 /home/user/chrome-headless-shell --type=renderer --user-data-dir=/tmp/puppeteer_dev_chrome_profile-hs-mac --remote-debugging-port=0';

// Cached macOS Chromium helper (Renderer/GPU/Network) — path contains spaces
// (云端 codex P1: helpers live in Contents/Frameworks/.../Helpers/..., not Contents/MacOS/Chromium)
const CACHED_MACOS_CHROMIUM_HELPER_ORPHAN =
  '    1 50009 /home/user/Chromium Framework.framework/Versions/128.0.6568.0/Helpers/Chromium Helper (Renderer).app/Contents/MacOS/Chromium Helper (Renderer) --type=renderer --user-data-dir=/var/folders/41/T/rod/user-data/abc123 --remote-debugging-port=0';

// Negative: Node/claude prompt text that happens to contain Chromium.app/Frameworks substring
// + tracked user-data-dir. binary path is /home/user/claude, not Chromium. Must NOT match.
// (砚砚 P1 二审: prevent regression of R2 class — substring scan over full args is unsafe.)
const NODE_PROMPT_WITH_CHROMIUM_FRAMEWORK =
  '    1 70295 /home/user/claude -p Path looks like /Chromium.app/Contents/Frameworks/Renderer in prompt --user-data-dir=/var/folders/41/T/rod/user-data/xxx test';

const FIXTURE = [CHROME_ORPHAN, ACTIVE_CHROME, NODE_BOTH_KEYWORDS, NODE_MARKER_ONLY, NORMAL_CHROME, ''].join('\n');

describe('parseOrphanPids', () => {
  test('matches orphan Chrome with agent-browser user-data-dir', () => {
    const pids = parseOrphanPids(FIXTURE, 1);
    assert.deepEqual(pids, [78911]);
  });

  test('does not match active (non-orphan) Chrome — ppid != 1', () => {
    const pids = parseOrphanPids(ACTIVE_CHROME, 1);
    assert.deepEqual(pids, []);
  });

  test('does not match node/claude process even when prompt contains Chrome + marker', () => {
    const pids = parseOrphanPids(NODE_BOTH_KEYWORDS, 1);
    assert.deepEqual(pids, []);
  });

  test('does not match node process with marker only', () => {
    const pids = parseOrphanPids(NODE_MARKER_ONLY, 1);
    assert.deepEqual(pids, []);
  });

  test('does not match normal Chrome without agent-browser user-data-dir', () => {
    const pids = parseOrphanPids(NORMAL_CHROME, 1);
    assert.deepEqual(pids, []);
  });

  test('matches Linux Chrome orphan (google-chrome-stable)', () => {
    const pids = parseOrphanPids(LINUX_CHROME_ORPHAN, 1);
    assert.deepEqual(pids, [12345]);
  });

  test('matches Linux Chrome orphan (/opt/google/chrome/chrome)', () => {
    const pids = parseOrphanPids(LINUX_OPT_CHROME_ORPHAN, 1);
    assert.deepEqual(pids, [12346]);
  });

  test('matches orphan Chromium with go-rod user-data-dir (LL-056 ext)', () => {
    const pids = parseOrphanPids(ROD_CHROME_ORPHAN, 1);
    assert.deepEqual(pids, [50001]);
  });

  test('matches orphan Chromium with Playwright user-data-dir (LL-056 ext)', () => {
    const pids = parseOrphanPids(PLAYWRIGHT_CHROME_ORPHAN, 1);
    assert.deepEqual(pids, [50002]);
  });

  test('matches orphan Chromium with Puppeteer user-data-dir (LL-056 ext)', () => {
    const pids = parseOrphanPids(PUPPETEER_CHROME_ORPHAN, 1);
    assert.deepEqual(pids, [50003]);
  });

  test('does NOT match user-managed Playwright debug profile (砚砚 P1)', () => {
    const pids = parseOrphanPids(USER_PLAYWRIGHT_DEBUG_PROFILE, 1);
    assert.deepEqual(pids, []);
  });

  test('matches Linux Playwright orphan with chrome-linux/chrome binary (cloud codex P1)', () => {
    const pids = parseOrphanPids(LINUX_PLAYWRIGHT_CHROME_ORPHAN, 1);
    assert.deepEqual(pids, [50005]);
  });

  test('matches Linux Puppeteer orphan with chrome-linux64/chrome binary (cloud codex P1)', () => {
    const pids = parseOrphanPids(LINUX_PUPPETEER_CHROME_ORPHAN, 1);
    assert.deepEqual(pids, [50006]);
  });

  test('matches Linux Playwright headless-shell orphan (砚砚 P1)', () => {
    const pids = parseOrphanPids(LINUX_PLAYWRIGHT_HEADLESS_SHELL_ORPHAN, 1);
    assert.deepEqual(pids, [50007]);
  });

  test('matches macOS Puppeteer headless-shell orphan (砚砚 P1)', () => {
    const pids = parseOrphanPids(MACOS_PUPPETEER_HEADLESS_SHELL_ORPHAN, 1);
    assert.deepEqual(pids, [50008]);
  });

  test('matches cached macOS Chromium helper process (cloud codex P1)', () => {
    const pids = parseOrphanPids(CACHED_MACOS_CHROMIUM_HELPER_ORPHAN, 1);
    assert.deepEqual(pids, [50009]);
  });

  test('does NOT match Node prompt containing Chromium.app/Frameworks substring (砚砚 P1 二审)', () => {
    const pids = parseOrphanPids(NODE_PROMPT_WITH_CHROMIUM_FRAMEWORK, 1);
    assert.deepEqual(pids, []);
  });

  test('excludes own PID', () => {
    const pids = parseOrphanPids(CHROME_ORPHAN, 78911);
    assert.deepEqual(pids, []);
  });

  test('handles empty input', () => {
    assert.deepEqual(parseOrphanPids('', 1), []);
  });

  test('handles multiple orphans', () => {
    const multi = [CHROME_ORPHAN, CHROME_ORPHAN.replace('78911', '78912')].join('\n');
    const pids = parseOrphanPids(multi, 1);
    assert.deepEqual(pids, [78911, 78912]);
  });
});

describe('parseAgentBrowserChromeCleanupPids', () => {
  test('matches stale non-orphan Chrome profile after threshold', () => {
    const pids = parseAgentBrowserChromeCleanupPids(
      [STALE_CHROME_MAIN, STALE_CHROME_HELPER, RECENT_CHROME_MAIN, RECENT_CHROME_HELPER].join('\n'),
      1,
      3600,
    );
    assert.deepEqual(pids, [21424, 21425]);
  });

  test('does not match recent active non-orphan Chrome profile', () => {
    const pids = parseAgentBrowserChromeCleanupPids([RECENT_CHROME_MAIN, RECENT_CHROME_HELPER].join('\n'), 1, 3600);
    assert.deepEqual(pids, []);
  });

  test('keeps legacy orphan behavior without etimes column', () => {
    const pids = parseAgentBrowserChromeCleanupPids(FIXTURE, 1, 3600);
    assert.deepEqual(pids, [78911]);
  });
});

describe('cleanOrphanAgentBrowserChrome', () => {
  test('kills only matched orphans via injected deps', async () => {
    const killed = [];
    const deps = {
      async listProcesses() {
        return FIXTURE;
      },
      killProcess(pid) {
        killed.push(pid);
      },
    };
    const result = await cleanOrphanAgentBrowserChrome(fakeLog, deps);
    assert.equal(result.found, 1);
    assert.equal(result.killed, 1);
    assert.deepEqual(killed, [78911]);
    assert.deepEqual(result.failedPids, []);
  });

  test('kills stale non-orphan agent-browser Chrome profile via injected deps', async () => {
    const killed = [];
    const deps = {
      async listProcesses() {
        return [STALE_CHROME_MAIN, STALE_CHROME_HELPER, RECENT_CHROME_MAIN, RECENT_CHROME_HELPER].join('\n');
      },
      killProcess(pid) {
        killed.push(pid);
      },
    };
    const result = await cleanOrphanAgentBrowserChrome(fakeLog, deps);
    assert.equal(result.found, 2);
    assert.equal(result.killed, 2);
    assert.deepEqual(killed, [21424, 21425]);
    assert.deepEqual(result.failedPids, []);
  });

  test('records failed kills in failedPids', async () => {
    const deps = {
      async listProcesses() {
        return CHROME_ORPHAN;
      },
      killProcess() {
        throw new Error('EPERM');
      },
    };
    const result = await cleanOrphanAgentBrowserChrome(fakeLog, deps);
    assert.equal(result.found, 1);
    assert.equal(result.killed, 0);
    assert.deepEqual(result.failedPids, [78911]);
  });

  test('returns clean result when no orphans found', async () => {
    const deps = {
      async listProcesses() {
        return NORMAL_CHROME;
      },
      killProcess() {
        throw new Error('should not be called');
      },
    };
    const result = await cleanOrphanAgentBrowserChrome(fakeLog, deps);
    assert.equal(result.found, 0);
    assert.equal(result.killed, 0);
    assert.deepEqual(result.failedPids, []);
  });

  test('handles listProcesses failure gracefully and logs warning', async () => {
    const warnings = [];
    const log = {
      info() {},
      warn(msg) {
        warnings.push(msg);
      },
    };
    const deps = {
      async listProcesses() {
        throw new Error('ps failed');
      },
      killProcess() {
        throw new Error('should not be called');
      },
    };
    const result = await cleanOrphanAgentBrowserChrome(log, deps);
    assert.equal(result.found, 0);
    assert.equal(result.killed, 0);
    assert.ok(warnings.some((m) => m.includes('[orphan-chrome] Failed to list processes')));
  });

  test('logs info when orphans found and killed', async () => {
    const messages = [];
    const log = {
      info(msg) {
        messages.push(msg);
      },
      warn() {},
    };
    const deps = {
      async listProcesses() {
        return CHROME_ORPHAN;
      },
      killProcess() {},
    };
    await cleanOrphanAgentBrowserChrome(log, deps);
    assert.ok(messages.some((m) => m.includes('[orphan-chrome] Found 1')));
    assert.ok(messages.some((m) => m.includes('[orphan-chrome] Killed 1')));
  });
});
