import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { projectReplyOutput } from '@/components/reply-layers/reply-output';
import type { ChatMessage } from '@/stores/chat-types';
import { useChatStore } from '@/stores/chatStore';
import { withoutUnprovenOutputLayout } from '@/stores/message-output-layout';
import { mergeReplaceHydrationMessages } from '../useChatHistory';
import { stations } from './f322-real-readback.fixture';
import {
  cleanStoreState,
  flatCodexStreamBubbles,
  installActiveHarness,
  installBackgroundHarness,
  threadCodexStreamBubbles,
} from './useAgentMessages-codex-tool-text-convergence.helpers';

function assertNativeView(message: ChatMessage, threadId: string) {
  const hash = createHash('sha256').update(message.content).digest('hex');
  const output = projectReplyOutput(message, threadId, hash);
  expect(output).toBeDefined();
  expect(output?.processCount).toBe(1);
  expect(output?.record.map((entry) => entry.kind)).toEqual(['text', 'tool', 'tool']);
  expect(output?.record[0]).toMatchObject({ text: '检查 **日志** 🐾。' });
  expect(output?.answers.map((answer) => answer.text)).toEqual([
    '保留 **答案段** 🐾。\n\n第二段完整回答。',
    '[Sol/gpt-6.1-sol🐾]',
  ]);
  return output;
}

describe('persisted station output at the canonical named Web ingress', () => {
  const active = installActiveHarness();
  for (const trace of stations) {
    it(`${trace.route}: captured output adapted to the named message ingress → store → F5 preserves the full body and native view`, () => {
      cleanStoreState(trace.threadId);
      active.render();
      for (const event of trace.live) active.send({ ...event, messageId: trace.api.id, threadId: trace.threadId });
      const live = flatCodexStreamBubbles();
      expect(live).toHaveLength(1);
      expect(live[0].content).toBe(trace.api.content);
      expect(live[0].extra?.outputLayout).toEqual(trace.api.extra.outputLayout);
      expect(live[0].toolEvents?.map((tool) => tool.id)).toEqual(trace.api.toolEvents?.map((tool) => tool.id));
      const view = assertNativeView(live[0], trace.threadId);
      const merged = mergeReplaceHydrationMessages([trace.api], live).messages;
      const canonical = merged.map(withoutUnprovenOutputLayout);
      expect(canonical).toHaveLength(1);
      expect(canonical[0].content).toBe(trace.api.content);
      expect(canonical[0].extra?.outputLayout).toEqual(trace.api.extra.outputLayout);
      expect(assertNativeView(canonical[0], trace.threadId)).toEqual(view);
      const restoredDraft = [withoutUnprovenOutputLayout(trace.draft.api)];
      expect(assertNativeView(restoredDraft[0], trace.threadId)).toEqual(view);
      const replaced = { ...trace.api, content: '独立的真实替换正文。' };
      expect(
        projectReplyOutput(replaced, trace.threadId, createHash('sha256').update(replaced.content).digest('hex')),
      ).toBeUndefined();
    });
  }
});

describe('same actual observations through background Web ingress', () => {
  const background = installBackgroundHarness();
  for (const trace of stations) {
    it(`${trace.route}: background uses API-born tool instances and the same complete native view`, () => {
      for (const event of trace.live)
        background.dispatchBg({ ...event, messageId: trace.api.id, threadId: trace.threadId });
      const messages = threadCodexStreamBubbles(trace.threadId);
      expect(messages).toHaveLength(1);
      expect(messages[0].content).toBe(trace.api.content);
      expect(messages[0].extra?.outputLayout).toEqual(trace.api.extra.outputLayout);
      expect(messages[0].toolEvents?.map((tool) => tool.id)).toEqual(trace.api.toolEvents?.map((tool) => tool.id));
      assertNativeView(messages[0], trace.threadId);
      const state = useChatStore.getState().getThreadState(trace.threadId);
      expect(state.messages.some((message) => message.content === trace.api.content)).toBe(true);
    });
  }
});
