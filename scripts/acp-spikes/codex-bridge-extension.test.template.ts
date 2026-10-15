/** Copied into the upstream test tree; assertions exercise the actual bridge. */
import { expect, it, vi } from 'vitest';
import { createCodexMockTestFixture, createTestSessionState } from './acp-test-utils';

it('W4.P fixed upstream bridge exports native state and forwards caller target to native expectedTurnId', async () => {
  const fixture = createCodexMockTestFixture();
  const agent = fixture.getCodexAcpAgent();
  const state = createTestSessionState({ currentTurnId: 'B' });
  vi.spyOn(agent, 'getSessionState').mockReturnValue(state);
  const native = vi.spyOn(fixture.getCodexAppServerClient(), 'turnSteer').mockResolvedValue({ turnId: 'A' });
  const snapshot = await agent.extMethod('_clowder/v1/control', { action: 'snapshot', sessionId: 'session-id' });
  expect(snapshot['nativeTurnId']).toBe('B');
  expect(snapshot['nativeSessionId']).toBe('session-id');
  const receipt = await agent.extMethod('_clowder/v1/control', {
    action: 'steer',
    operationId: 'operation',
    sessionId: 'session-id',
    nativeSessionId: 'session-id',
    expectedTurnId: 'A',
    prompt: [{ type: 'text', text: 'synthetic' }],
  });
  expect(native).toHaveBeenCalledWith({
    threadId: 'session-id',
    expectedTurnId: 'A',
    input: [{ type: 'text', text: 'synthetic', text_elements: [] }],
  });
  expect(receipt['nativeTurnId']).toBe('A');
  expect(state.currentTurnId).toBe('B');
});
