import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { after, before, describe, it } from 'node:test';
import { TmuxGateway } from '../dist/domains/terminal/tmux-gateway.js';

async function waitForPaneLine(gateway, worktreeId, paneId, expectedLine, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  let output = '';
  while (Date.now() < deadline) {
    output = await gateway.capturePane(worktreeId, paneId);
    const outputLines = output.split('\n').map((line) => line.trim());
    if (outputLines.includes(expectedLine)) return outputLines;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.fail(`expected ${expectedLine}, got: ${output}`);
}

describe('TmuxGateway', () => {
  const TEST_WORKTREE = `test-gw-${Date.now()}`;
  let gateway;

  before(() => {
    gateway = new TmuxGateway();
  });

  after(async () => {
    await gateway.destroyServer(TEST_WORKTREE);
  });

  it('socketName returns catcafe-prefixed name', () => {
    assert.equal(gateway.socketName('foo'), 'catcafe-foo');
  });

  it('ensureServer creates tmux server and returns socket name', async () => {
    const sock = await gateway.ensureServer(TEST_WORKTREE);
    assert.equal(sock, `catcafe-${TEST_WORKTREE}`);
  });

  it('createPane creates a pane and returns pane ID', async () => {
    const paneId = await gateway.createPane(TEST_WORKTREE, {
      cols: 80,
      rows: 24,
      cwd: '/tmp',
    });
    assert.ok(paneId, 'pane ID should be non-empty');
    assert.match(paneId, /^%\d+$/);
  });

  it('new tmux servers do not inherit enabled API-only lifecycle capabilities', async () => {
    const isolatedWorktree = `${TEST_WORKTREE}-runtime-env`;
    const previousConnector = process.env.CONNECTOR_GATEWAY_AUTOSTART;
    const previousSidecar = process.env.CAT_CAFE_PROVISION_GLOBAL_SIDECAR;
    process.env.CONNECTOR_GATEWAY_AUTOSTART = '1';
    process.env.CAT_CAFE_PROVISION_GLOBAL_SIDECAR = '1';

    try {
      const paneId = await gateway.createPane(isolatedWorktree, {
        cols: 80,
        rows: 24,
        cwd: '/tmp',
        shell: '/bin/sh',
      });
      await gateway.execInPane(
        isolatedWorktree,
        paneId,
        "if env | grep -Eq '^(CONNECTOR_GATEWAY_AUTOSTART|CAT_CAFE_PROVISION_GLOBAL_SIDECAR)=1$'; then echo runtime-caps-present; else echo runtime-caps-absent; fi",
      );
      const outputLines = await waitForPaneLine(gateway, isolatedWorktree, paneId, 'runtime-caps-absent');
      assert.equal(outputLines.includes('runtime-caps-present'), false);
    } finally {
      if (previousConnector === undefined) delete process.env.CONNECTOR_GATEWAY_AUTOSTART;
      else process.env.CONNECTOR_GATEWAY_AUTOSTART = previousConnector;
      if (previousSidecar === undefined) delete process.env.CAT_CAFE_PROVISION_GLOBAL_SIDECAR;
      else process.env.CAT_CAFE_PROVISION_GLOBAL_SIDECAR = previousSidecar;
      await gateway.destroyServer(isolatedWorktree);
    }
  });

  it('new panes override enabled lifecycle capabilities retained by a pre-existing tmux server', async () => {
    const preexistingWorktree = `${TEST_WORKTREE}-preexisting-runtime-env`;
    const sock = gateway.socketName(preexistingWorktree);
    const contaminatedEnv = {
      ...process.env,
      CONNECTOR_GATEWAY_AUTOSTART: '1',
      CAT_CAFE_PROVISION_GLOBAL_SIDECAR: '1',
    };

    execFileSync(gateway.tmuxBin, ['-L', sock, 'new-session', '-d', '-c', '/tmp', '/bin/zsh'], {
      env: contaminatedEnv,
      stdio: 'ignore',
    });

    try {
      await gateway.ensureServer(preexistingWorktree);
      const paneId = await gateway.createPane(preexistingWorktree, {
        cols: 80,
        rows: 24,
        cwd: '/tmp',
        shell: '/bin/sh',
      });
      await gateway.execInPane(
        preexistingWorktree,
        paneId,
        "if env | grep -Eq '^(CONNECTOR_GATEWAY_AUTOSTART|CAT_CAFE_PROVISION_GLOBAL_SIDECAR)=1$'; then echo runtime-caps-present; else echo runtime-caps-absent; fi",
      );
      const outputLines = await waitForPaneLine(gateway, preexistingWorktree, paneId, 'runtime-caps-absent');
      assert.equal(outputLines.includes('runtime-caps-present'), false);
    } finally {
      await gateway.destroyServer(preexistingWorktree);
    }
  });

  it('createPane recreates the tmux server when the cached server died externally', async () => {
    const initialPaneId = await gateway.createPane(TEST_WORKTREE, { cols: 80, rows: 24, cwd: '/tmp' });
    assert.match(initialPaneId, /^%\d+$/);

    execFileSync(gateway.tmuxBin, ['-L', gateway.socketName(TEST_WORKTREE), 'kill-server'], { stdio: 'ignore' });

    const recoveredPaneId = await gateway.createPane(TEST_WORKTREE, { cols: 80, rows: 24, cwd: '/tmp' });
    assert.match(recoveredPaneId, /^%\d+$/);

    const panes = await gateway.listPanes(TEST_WORKTREE);
    assert.ok(
      panes.some((pane) => pane.paneId === recoveredPaneId),
      'recreated server should expose the new pane',
    );
  });

  it('createPane recovers when a crashed tmux server leaves a stale socket before first use in a fresh gateway', async () => {
    const crashedWorktree = `${TEST_WORKTREE}-crashed`;
    const firstGateway = new TmuxGateway();
    const initialPaneId = await firstGateway.createPane(crashedWorktree, { cols: 80, rows: 24, cwd: '/tmp' });
    assert.match(initialPaneId, /^%\d+$/);

    const sock = firstGateway.socketName(crashedWorktree);
    const serverPid = Number(
      execFileSync(firstGateway.tmuxBin, ['-L', sock, 'display-message', '-p', '#{pid}'], {
        encoding: 'utf8',
      }).trim(),
    );
    assert.ok(serverPid > 0, 'server pid should be available');

    process.kill(serverPid, 'SIGKILL');
    await new Promise((r) => setTimeout(r, 200));

    const freshGateway = new TmuxGateway();
    const recoveredPaneId = await freshGateway.createPane(crashedWorktree, { cols: 80, rows: 24, cwd: '/tmp' });
    assert.match(recoveredPaneId, /^%\d+$/);

    const panes = await freshGateway.listPanes(crashedWorktree);
    assert.ok(
      panes.some((pane) => pane.paneId === recoveredPaneId),
      'fresh gateway should recreate the crashed tmux server and expose the pane',
    );

    await freshGateway.destroyServer(crashedWorktree);
    await firstGateway.destroyServer(crashedWorktree);
  });

  it('listPanes returns at least one pane', async () => {
    const panes = await gateway.listPanes(TEST_WORKTREE);
    assert.ok(panes.length >= 1);
    assert.ok(panes[0].paneId.startsWith('%'));
    assert.ok(panes[0].panePid > 0);
    assert.ok(panes[0].paneWidth > 0);
    assert.ok(panes[0].paneHeight > 0);
  });

  it('resizePane executes without error', async () => {
    const panes = await gateway.listPanes(TEST_WORKTREE);
    const paneId = panes[0].paneId;
    // tmux resize-pane is constrained by window size, so we just verify no throw
    await gateway.resizePane(TEST_WORKTREE, paneId, 60, 20);

    const updated = await gateway.listPanes(TEST_WORKTREE);
    const resized = updated.find((p) => p.paneId === paneId);
    assert.ok(resized, 'pane should still exist after resize');
  });

  it('sendKeys sends command to pane and capturePane reads output', async () => {
    const panes = await gateway.listPanes(TEST_WORKTREE);
    const paneId = panes[0].paneId;

    await gateway.sendKeys(TEST_WORKTREE, paneId, 'echo tmux-gateway-test-marker');
    // Give shell time to process
    await new Promise((r) => setTimeout(r, 600));

    const output = await gateway.capturePane(TEST_WORKTREE, paneId);
    assert.ok(
      output.includes('tmux-gateway-test-marker'),
      `output should contain marker, got: ${output.substring(0, 200)}`,
    );
  });

  it('killPane removes a specific pane', async () => {
    // Re-create server for this test
    await gateway.ensureServer(TEST_WORKTREE);
    const paneId = await gateway.createPane(TEST_WORKTREE, { cols: 80, rows: 24, cwd: '/tmp' });
    const before = await gateway.listPanes(TEST_WORKTREE);
    assert.ok(before.some((p) => p.paneId === paneId));

    await gateway.killPane(TEST_WORKTREE, paneId);
    // Small delay for tmux to process
    await new Promise((r) => setTimeout(r, 100));
    const after = await gateway.listPanes(TEST_WORKTREE);
    assert.ok(!after.some((p) => p.paneId === paneId), 'killed pane should be gone');
  });

  it('killPane on non-existent pane does not throw', async () => {
    await gateway.killPane(TEST_WORKTREE, '%9999');
    // Should not throw
  });

  it('destroyServer kills the tmux server', async () => {
    await gateway.destroyServer(TEST_WORKTREE);
    const panes = await gateway.listPanes(TEST_WORKTREE);
    assert.equal(panes.length, 0);
  });

  it('destroyServer on non-existent server does not throw', async () => {
    await gateway.destroyServer('nonexistent-server-xyz');
    // Should not throw
  });

  it('listPanes on non-existent server returns empty', async () => {
    const panes = await gateway.listPanes('nonexistent-server-xyz');
    assert.deepEqual(panes, []);
  });
});
