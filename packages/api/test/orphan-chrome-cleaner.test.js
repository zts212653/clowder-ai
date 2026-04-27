import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

await import('tsx/esm');
const { cleanOrphanAgentBrowserChrome, parseOrphanPids } = await import('../src/utils/orphan-chrome-cleaner.ts');

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
