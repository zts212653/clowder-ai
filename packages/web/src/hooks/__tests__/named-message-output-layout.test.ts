import { createHash } from 'node:crypto';
import type { MessageOutputLayoutV1 } from '@cat-cafe/shared';
import { describe, expect, it } from 'vitest';
import { projectReplyOutput } from '@/components/reply-layers/reply-output';
import type { BackgroundAgentMessage } from '@/hooks/useAgentMessages';
import { useChatStore } from '@/stores/chatStore';
import { mergeReplaceHydrationMessages } from '../useChatHistory';
import {
  cleanStoreState,
  installActiveHarness,
  installBackgroundHarness,
  seedProcessingResponse,
} from './useAgentMessages-codex-tool-text-convergence.helpers';

const THREAD = 'named-output-thread';
const RESPONSE = 'persisted-response';
const TURN = 'exact-turn';
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
function layout(text: string): MessageOutputLayoutV1 {
  return {
    v: 1,
    owner: { threadId: THREAD, catId: 'codex', turnInvocationId: TURN },
    contentRevision: { length: text.length, sha256: hash(text) },
    status: 'available',
    runs: [
      {
        id: 'final',
        identity: { provider: 'codex', runtimeSessionId: 'session', turnId: 'turn', nativeId: 'native-final' },
        channel: 'final',
        complete: true,
        start: 0,
        end: text.length,
        gluePrefixLength: 0,
      },
    ],
    order: [{ kind: 'run', runId: 'final' }],
  };
}
function snapshot(content: string, outputLayout?: MessageOutputLayoutV1): BackgroundAgentMessage {
  return {
    type: 'text',
    origin: 'stream',
    catId: 'codex',
    threadId: THREAD,
    messageId: RESPONSE,
    invocationId: 'parent',
    turnInvocationId: TURN,
    timestamp: 10,
    content,
    textMode: 'replace',
    ...(outputLayout ? { extra: { outputLayout } } : {}),
  };
}
const rows = () => useChatStore.getState().getThreadState(THREAD).messages;

for (const mode of ['active', 'background'] as const) {
  describe(`${mode}: optional native layout uses the server-named response`, () => {
    const active = mode === 'active' ? installActiveHarness() : null;
    const background = mode === 'background' ? installBackgroundHarness() : null;
    function begin() {
      cleanStoreState(mode === 'active' ? THREAD : 'other-thread');
      active?.render();
      seedProcessingResponse(THREAD, RESPONSE, 'codex', TURN);
    }
    const send = (event: BackgroundAgentMessage) => (active ? active.send(event) : background!.dispatchBg(event));

    it('replayed full snapshots preserve one response and the same exact native view after hydration', () => {
      begin();
      const output = layout('完整回答 🐾。');
      send(snapshot('完整回答 🐾。', output));
      send(snapshot('完整回答 🐾。', output));
      expect(rows()).toHaveLength(1);
      expect(rows()[0].id).toBe(RESPONSE);
      expect(projectReplyOutput(rows()[0], THREAD, hash(rows()[0].content))?.answers[0].text).toBe('完整回答 🐾。');
      const hydrated = mergeReplaceHydrationMessages([{ ...rows()[0] }], rows()).messages;
      expect(hydrated).toHaveLength(1);
      expect(hydrated[0].extra?.outputLayout).toEqual(output);
    });

    it('a replacement without native proof clears the old layout instead of reusing old offsets', () => {
      begin();
      send(snapshot('旧正文', layout('旧正文')));
      send(snapshot('新正文'));
      expect(rows()[0].content).toBe('新正文');
      expect(rows()[0].extra?.outputLayout).toBeUndefined();
    });

    it('appends native deltas with a whole-body layout revision, then adopts the completed layout', () => {
      begin();
      for (const [delta, content] of [
        ['答', '答'],
        ['案', '答案'],
      ]) {
        const output: MessageOutputLayoutV1 = {
          v: 1,
          owner: layout(content).owner,
          contentRevision: layout(content).contentRevision,
          status: 'unavailable',
          reason: 'unknown_output',
        };
        send({ ...snapshot(delta, output), textMode: 'append' });
        expect(rows()[0].content).toBe(content);
        expect(rows()[0].extra?.outputLayout).toEqual(output);
        expect(projectReplyOutput(rows()[0], THREAD, hash(content))).toBeUndefined();
      }
      send(snapshot('答案', layout('答案')));
      expect(rows()).toHaveLength(1);
      expect(rows()[0].content).toBe('答案');
      expect(projectReplyOutput(rows()[0], THREAD, hash('答案'))?.answers[0].text).toBe('答案');
    });

    it('layout for another turn cannot move words out of this response', () => {
      begin();
      const wrong = layout('回答');
      wrong.owner.turnInvocationId = 'other-turn';
      send(snapshot('回答', wrong));
      expect(projectReplyOutput(rows()[0], THREAD, hash('回答'))).toBeUndefined();
      expect(mergeReplaceHydrationMessages(rows(), []).messages[0].extra?.outputLayout).toBeUndefined();
    });

    it('a callback owns its own message and references, without adopting the response native layout', () => {
      begin();
      send(snapshot('回答', layout('回答')));
      const blocks = [
        {
          type: 'context_attachment' as const,
          attachment: {
            v: 1 as const,
            id: 'quote',
            kind: 'quote' as const,
            text: '原文',
            source: { kind: 'message' as const, threadId: THREAD, messageId: 'source' },
          },
        },
      ];
      send({
        ...snapshot('独立消息', layout('独立消息')),
        messageId: 'persisted-post',
        origin: 'callback',
        contentBlocks: blocks,
        extra: { isExplicitPost: true, outputLayout: layout('独立消息') },
      });
      expect(rows()).toHaveLength(2);
      const post = rows().find((row) => row.id === 'persisted-post');
      expect(post?.contentBlocks).toEqual(blocks);
      expect(post?.extra?.outputLayout).toBeUndefined();
      expect(rows()[0].extra?.outputLayout).toEqual(layout('回答'));
    });
  });
}
