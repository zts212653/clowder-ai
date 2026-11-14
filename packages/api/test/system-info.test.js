/**
 * system_info event type tests
 * Verifies the new AgentMessageType and its integration
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

describe('SocketManager cancel behavior', () => {
  it('SocketManager file exists and exports correctly', async () => {
    // Just verify the module can be loaded (actual socket tests would need httpServer)
    const socketMod = await import('../dist/infrastructure/websocket/SocketManager.js');
    assert.ok(socketMod.SocketManager, 'SocketManager should be exported');
  });
});

describe('isUserFacingSystemInfoContent', () => {
  it('recognizes warning as user-facing', async () => {
    const { isUserFacingSystemInfoContent } = await import(
      '../dist/domains/cats/services/agents/routing/route-helpers.js'
    );
    assert.ok(
      isUserFacingSystemInfoContent(
        JSON.stringify({
          type: 'warning',
          presentation: 'user_action_required',
          message: 'current opencode/CodeAgent adapter did not return token usage',
        }),
      ),
      'warning system_info must be treated as user-facing so it persists and prevents silent_completion duplicates',
    );
  });

  it('does not treat an unclassified provider diagnostic as user-facing', async () => {
    const { isUserFacingSystemInfoContent } = await import(
      '../dist/domains/cats/services/agents/routing/route-helpers.js'
    );
    assert.equal(
      isUserFacingSystemInfoContent(JSON.stringify({ type: 'warning', message: 'model metadata missing' })),
      false,
    );
  });

  it('recognizes cloud bridge status as user-facing', async () => {
    const { isUserFacingSystemInfoContent } = await import(
      '../dist/domains/cats/services/agents/routing/route-helpers.js'
    );
    assert.ok(
      isUserFacingSystemInfoContent(
        JSON.stringify({ type: 'cloud_bridge_status', status: 'unavailable', message: 'not sent' }),
      ),
      'cloud bridge status prevents a misleading silent_completion duplicate',
    );
  });

  it('does not treat missing_usage_alert as user-facing (deprecated type)', async () => {
    const { isUserFacingSystemInfoContent } = await import(
      '../dist/domains/cats/services/agents/routing/route-helpers.js'
    );
    assert.ok(
      !isUserFacingSystemInfoContent(JSON.stringify({ type: 'missing_usage_alert', detail: 'some detail' })),
      'missing_usage_alert is not in the user-facing whitelist; alerts must use type=warning',
    );
  });
});
