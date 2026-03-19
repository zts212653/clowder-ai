import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { AgentPaneRegistry } from '../dist/domains/terminal/agent-pane-registry.js';
import { createTmuxSpawnOverride } from '../dist/domains/terminal/tmux-agent-spawner.js';
import { TmuxGateway } from '../dist/domains/terminal/tmux-gateway.js';

describe('createTmuxSpawnOverride', () => {
  const WORKTREE = `test-override-${Date.now()}`;
  let gateway;
  let registry;

  before(() => {
    gateway = new TmuxGateway();
    registry = new AgentPaneRegistry();
  });

  after(async () => {
    await gateway.destroyServer(WORKTREE);
  });

  it('override yields events and registers pane in AgentPaneRegistry', async () => {
    const invocationId = 'override-inv-1';
    const override = createTmuxSpawnOverride(WORKTREE, invocationId, 'test-user', gateway, registry);

    const events = [];
    for await (const event of override({
      command: '/bin/sh',
      args: ['-c', 'echo \'{"type":"hello"}\''],
    })) {
      events.push(event);
    }

    const paneEvent = events.find((e) => e.__tmuxPaneCreated);
    assert.ok(paneEvent, 'should yield __tmuxPaneCreated');

    const pane = registry.getByInvocation(invocationId);
    assert.ok(pane, 'pane should be registered');
    assert.equal(pane.worktreeId, WORKTREE);
    assert.equal(pane.status, 'running');
  });

  it('override works without AgentPaneRegistry', async () => {
    const override = createTmuxSpawnOverride(WORKTREE, 'override-inv-2', 'test-user', gateway);

    const events = [];
    for await (const event of override({
      command: '/bin/sh',
      args: ['-c', 'echo \'{"type":"ok"}\''],
    })) {
      events.push(event);
    }

    const jsonEvents = events.filter((e) => e.type === 'ok');
    assert.equal(jsonEvents.length, 1);
  });
});
