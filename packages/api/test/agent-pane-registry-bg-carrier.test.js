/**
 * F198 Phase C - AC-C1: tmux pane ↔ thread invocation linking
 *
 * Verifies AgentPaneRegistry supports registering bg carrier sessions
 * and querying them by threadId.
 */

import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { AgentPaneRegistry } from '../dist/domains/terminal/agent-pane-registry.js';

describe('AgentPaneRegistry — bg carrier session tracking (F198 Phase C)', () => {
  let registry;

  beforeEach(() => {
    registry = new AgentPaneRegistry();
  });

  it('registerBgCarrier stores session metadata', () => {
    registry.registerBgCarrier({
      invocationId: 'inv-bg-1',
      catId: 'opus',
      daemonShortId: 'abcd1234',
      threadId: 'thread-abc',
    });
    const info = registry.getBgCarrierByInvocation('inv-bg-1');
    assert.ok(info, 'must return bg carrier info for registered invocationId');
    assert.equal(info.invocationId, 'inv-bg-1');
    assert.equal(info.catId, 'opus');
    assert.equal(info.daemonShortId, 'abcd1234');
    assert.equal(info.threadId, 'thread-abc');
    assert.equal(info.status, 'running');
    assert.ok(typeof info.startedAt === 'number');
  });

  it('getBgCarrierByThread returns running session for threadId', () => {
    registry.registerBgCarrier({
      invocationId: 'inv-bg-2',
      catId: 'sonnet',
      daemonShortId: 'beef5678',
      threadId: 'thread-xyz',
    });
    const info = registry.getBgCarrierByThread('thread-xyz');
    assert.ok(info, 'must find bg carrier by threadId');
    assert.equal(info.daemonShortId, 'beef5678');
    assert.equal(info.catId, 'sonnet');
  });

  it('getBgCarrierByThread returns undefined for unknown thread', () => {
    const info = registry.getBgCarrierByThread('thread-no-such');
    assert.equal(info, undefined);
  });

  it('getBgCarrierByInvocation returns undefined for unknown invocationId', () => {
    const info = registry.getBgCarrierByInvocation('inv-no-such');
    assert.equal(info, undefined);
  });

  it('markBgCarrierDone updates status of bg carrier session', () => {
    registry.registerBgCarrier({
      invocationId: 'inv-bg-done',
      catId: 'opus',
      daemonShortId: 'done5678',
      threadId: 'thread-done',
    });
    registry.markBgCarrierDone('inv-bg-done');
    const info = registry.getBgCarrierByInvocation('inv-bg-done');
    assert.equal(info.status, 'done');
  });

  it('getBgCarrierByThread returns null when session is done', () => {
    registry.registerBgCarrier({
      invocationId: 'inv-bg-done2',
      catId: 'opus',
      daemonShortId: 'done9999',
      threadId: 'thread-done2',
    });
    registry.markBgCarrierDone('inv-bg-done2');
    const info = registry.getBgCarrierByThread('thread-done2');
    assert.equal(info, undefined, 'getBgCarrierByThread must not return completed sessions');
  });

  it('multiple bg sessions for same thread: returns most recent running one', () => {
    registry.registerBgCarrier({
      invocationId: 'inv-old',
      catId: 'opus',
      daemonShortId: 'aaaa0001',
      threadId: 'thread-multi',
    });
    registry.markBgCarrierDone('inv-old');
    registry.registerBgCarrier({
      invocationId: 'inv-new',
      catId: 'opus',
      daemonShortId: 'bbbb0002',
      threadId: 'thread-multi',
    });
    const info = registry.getBgCarrierByThread('thread-multi');
    assert.ok(info);
    assert.equal(info.invocationId, 'inv-new', 'must return the running session, not the done one');
  });

  it('getRegisteredDaemonShortIds returns shortIds of all running bg carrier sessions', () => {
    registry.registerBgCarrier({
      invocationId: 'inv-scope-1',
      catId: 'opus',
      daemonShortId: 'scope0001',
      threadId: 'thread-scope-1',
    });
    registry.registerBgCarrier({
      invocationId: 'inv-scope-2',
      catId: 'sonnet',
      daemonShortId: 'scope0002',
      threadId: 'thread-scope-2',
    });
    // Mark one as done — done sessions should still be in the set
    // (they ran via Clowder AI so we include them; filtering at route level is by "known" not "running")
    registry.markBgCarrierDone('inv-scope-2');

    const ids = registry.getRegisteredDaemonShortIds();
    assert.ok(ids instanceof Set, 'must return a Set');
    assert.ok(ids.has('scope0001'), 'must include running session shortId');
    assert.ok(ids.has('scope0002'), 'must include done session shortId (known Cat-Café session)');
    assert.ok(!ids.has('outsider1234'), 'must not include unregistered shortIds');
  });

  it('existing tmux register() still works alongside bg carrier methods', () => {
    registry.register('inv-tmux', 'wt-a', '%0', 'user-1');
    registry.registerBgCarrier({
      invocationId: 'inv-bg',
      catId: 'opus',
      daemonShortId: 'cccc0001',
      threadId: 'thread-coexist',
    });
    // Tmux pane still accessible
    const tmuxInfo = registry.getByInvocation('inv-tmux');
    assert.ok(tmuxInfo, 'tmux pane must still be accessible');
    assert.equal(tmuxInfo.paneId, '%0');
    // BG carrier accessible
    const bgInfo = registry.getBgCarrierByInvocation('inv-bg');
    assert.ok(bgInfo, 'bg carrier must be accessible alongside tmux pane');
  });
});
