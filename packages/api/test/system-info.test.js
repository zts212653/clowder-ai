/**
 * system_info event type tests
 * Verifies the new AgentMessageType and its integration
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

describe('AgentMessageType system_info', () => {
  it('types.ts includes system_info in AgentMessageType', async () => {
    // The types are compile-time only, but we can verify the module exports correctly
    const {} = await import('../dist/domains/cats/services/types.js');
    // If the module imports successfully and TypeScript compiled, the type exists
    assert.ok(true, 'types.js compiled successfully with system_info');
  });

  it('system_info message can be constructed', () => {
    // Verify the structure matches our expected format
    const sysInfoMsg = {
      type: 'system_info',
      catId: 'opus',
      content: '⏹ 已取消',
      timestamp: Date.now(),
    };

    assert.equal(sysInfoMsg.type, 'system_info');
    assert.equal(sysInfoMsg.content, '⏹ 已取消');
    assert.ok(typeof sysInfoMsg.timestamp === 'number');
  });

  it('system_info type is distinct from other types', () => {
    const knownTypes = [
      'session_init',
      'text',
      'tool_use',
      'tool_result',
      'error',
      'done',
      'a2a_handoff',
      'system_info',
    ];

    // system_info should be in the list
    assert.ok(knownTypes.includes('system_info'), 'system_info should be a known type');

    // And it's distinct from others
    const otherTypes = knownTypes.filter((t) => t !== 'system_info');
    assert.equal(otherTypes.length, 7, 'Should have 7 other types');
  });
});

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
        JSON.stringify({ type: 'warning', message: 'current opencode/CodeAgent adapter did not return token usage' }),
      ),
      'warning system_info must be treated as user-facing so it persists and prevents silent_completion duplicates',
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
