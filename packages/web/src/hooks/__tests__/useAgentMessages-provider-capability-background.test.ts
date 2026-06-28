// #939 part A — background-chain regression guard for provider_capability silent consume.
//
// Caught by [宪宪/opus-4.6] review of cat-cafe#2352 (intake of clowder-ai#943).
//
// F210-H1 pattern uses dual handlers — foreground (`handleAgentMessage`) and
// background (`handleBackgroundAgentMessage` → `consumeBackgroundSystemInfo`).
// The community PR only added the foreground branch. Without the matching
// background branch, kimi running in a background thread would still surface
// the raw-JSON system bubble "thinking → unavailable" (the original #939 bug).
//
// These tests exercise the background path with the real chat store (the sister
// `useAgentMessages-provider-capability.test.tsx` file mocks the store for the
// foreground React-hook path, which is why we need a separate file here).

import { beforeEach, describe, expect, it } from 'vitest';
import { type BackgroundAgentMessage, handleBackgroundAgentMessage } from '@/hooks/useAgentMessages';
import { useChatStore } from '@/stores/chatStore';

let bgTestSeq = 0;
const bgStreamRefs = new Map<string, { id: string; threadId: string; catId: string }>();
const finalizedBgRefs = new Map<string, string>();

function dispatchBg(msg: BackgroundAgentMessage) {
  handleBackgroundAgentMessage(msg, {
    store: useChatStore.getState(),
    bgStreamRefs,
    finalizedBgRefs,
    nextBgSeq: () => bgTestSeq++,
    addToast: () => {},
    clearDoneTimeout: () => {},
  });
}

describe('#939 part A (background chain): provider_capability silent consume + invocation snapshot', () => {
  beforeEach(() => {
    useChatStore.setState({
      messages: [],
      isLoading: false,
      hasActiveInvocation: false,
      intentMode: null,
      targetCats: [],
      catStatuses: {},
      catInvocations: {},
      activeInvocations: {},
      threadStates: {},
      currentThreadId: 'thread-bg',
      currentProjectPath: 'default',
      threads: [],
    });
    bgTestSeq = 0;
    bgStreamRefs.clear();
    finalizedBgRefs.clear();
  });

  it('background chain consumes provider_capability silently and stores on thread invocation snapshot', () => {
    dispatchBg({
      type: 'system_info',
      catId: 'kimi',
      threadId: 'thread-bg',
      content: JSON.stringify({
        type: 'provider_capability',
        capability: 'thinking',
        status: 'unavailable',
        provider: 'kimi',
        reason: 'kimi-cli 本次流式输出未提供可解析的 think/reasoning 内容',
      }),
      timestamp: 1700000000000,
    });

    const ts = useChatStore.getState().getThreadState('thread-bg');
    // No raw-JSON bubble landed (the bug guard — main reason this PR exists)
    expect(ts.messages.filter((m: { type: string }) => m.type === 'system').length).toBe(0);
    // Capability snapshot stored on the thread invocation
    expect(ts.catInvocations.kimi?.providerCapabilities?.thinking).toEqual(
      expect.objectContaining({
        status: 'unavailable',
        provider: 'kimi',
        reason: expect.stringContaining('think/reasoning'),
      }),
    );
  });

  it('background chain merges multiple capabilities on the same cat without clobbering', () => {
    dispatchBg({
      type: 'system_info',
      catId: 'kimi',
      threadId: 'thread-bg',
      content: JSON.stringify({
        type: 'provider_capability',
        capability: 'thinking',
        status: 'unavailable',
        provider: 'kimi',
        reason: 'reason-thinking',
      }),
      timestamp: 1700000000001,
    });
    dispatchBg({
      type: 'system_info',
      catId: 'kimi',
      threadId: 'thread-bg',
      content: JSON.stringify({
        type: 'provider_capability',
        capability: 'image_input',
        status: 'limited',
        provider: 'kimi',
        reason: 'reason-image',
      }),
      timestamp: 1700000000002,
    });

    const ts = useChatStore.getState().getThreadState('thread-bg');
    expect(ts.messages.filter((m: { type: string }) => m.type === 'system').length).toBe(0);
    expect(ts.catInvocations.kimi?.providerCapabilities).toEqual(
      expect.objectContaining({
        thinking: expect.objectContaining({ reason: 'reason-thinking' }),
        image_input: expect.objectContaining({ reason: 'reason-image', status: 'limited' }),
      }),
    );
  });

  it('background chain coerces unknown status to "unavailable" rather than surfacing raw JSON', () => {
    dispatchBg({
      type: 'system_info',
      catId: 'kimi',
      threadId: 'thread-bg',
      content: JSON.stringify({
        type: 'provider_capability',
        capability: 'thinking',
        status: 'mystery-value-from-new-backend',
        provider: 'kimi',
        reason: 'unknown status from a new backend version',
      }),
      timestamp: 1700000000003,
    });

    const ts = useChatStore.getState().getThreadState('thread-bg');
    expect(ts.messages.filter((m: { type: string }) => m.type === 'system').length).toBe(0);
    expect(ts.catInvocations.kimi?.providerCapabilities?.thinking?.status).toBe('unavailable');
  });
});
