'use client';

import { useEffect, useRef, useState } from 'react';
import { CliOutputBlock } from '@/components/cli-output/CliOutputBlock';
import { MessageActions } from '@/components/MessageActions';
import { MessageSelectionToolbar } from '@/components/MessageSelectionToolbar';
import { useAgentMessages } from '@/hooks/useAgentMessages';
import type { ChatMessage } from '@/stores/chat-types';
import { useChatStore } from '@/stores/chatStore';

const THREAD_ID = 'thread-live-selection-id';
const INVOCATION_ID = 'inv-live-selection-id';
const LIVE_MESSAGE_ID = `msg-${INVOCATION_ID}-codex-sol`;
const PERSISTED_MESSAGE_ID = 'persisted-live-selection-id';
const TARGET_THREAD_ID = 'thread-live-selection-target';
const CLI_STDOUT = '刚完成的 CLI 输出正文';

const liveMessage: ChatMessage = {
  id: LIVE_MESSAGE_ID,
  type: 'assistant',
  catId: 'codex-sol',
  content: CLI_STDOUT,
  origin: 'stream',
  isStreaming: true,
  timestamp: Date.now(),
  projectionSourceMessageIds: [LIVE_MESSAGE_ID],
  extra: {
    stream: { invocationId: INVOCATION_ID },
    rich: {
      v: 1,
      blocks: [
        {
          id: 'live-widget',
          kind: 'html_widget',
          v: 1,
          title: '刚完成的响应式富文本',
          html: '<!doctype html><p>live widget</p>',
          height: 120,
        },
      ],
    },
  },
};

export default function LiveSelectionIdFixture() {
  const initializedRef = useRef(false);
  const { handleAgentMessage } = useAgentMessages();
  const messages = useChatStore((state) => state.messages);
  const [selectedMessageIds, setSelectedMessageIds] = useState<string[]>([]);
  const [exported, setExported] = useState(false);

  useEffect(() => {
    if (initializedRef.current) return;
    initializedRef.current = true;
    useChatStore.setState({
      currentThreadId: THREAD_ID,
      messages: [liveMessage],
      threads: [
        {
          id: THREAD_ID,
          title: '即时消息来源线程',
          projectPath: '/project',
          createdBy: 'user-1',
          participants: [],
          lastActiveAt: 2,
          createdAt: 1,
        },
        {
          id: TARGET_THREAD_ID,
          title: '接收测试线程',
          projectPath: '/project',
          createdBy: 'user-1',
          participants: [],
          lastActiveAt: 1,
          createdAt: 1,
        },
      ],
      activeInvocations: {
        [INVOCATION_ID]: { catId: 'codex-sol', mode: 'execute', startedAt: Date.now() },
      },
      hasActiveInvocation: true,
    });
  }, []);

  const finishAndSelect = () => {
    handleAgentMessage({
      type: 'done',
      catId: 'codex-sol',
      threadId: THREAD_ID,
      invocationId: INVOCATION_ID,
      messageId: PERSISTED_MESSAGE_ID,
      isFinal: true,
      timestamp: Date.now(),
    });
    const canonicalMessage = useChatStore.getState().messages.find((message) => message.id === PERSISTED_MESSAGE_ID);
    setSelectedMessageIds(canonicalMessage ? [canonicalMessage.id] : []);
  };

  const message = messages[0];
  const widget = message?.extra?.rich?.blocks.find((block) => block.kind === 'html_widget');

  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col gap-4 p-6">
      <h1 className="text-lg font-semibold text-cafe-primary">F294 live selection identity fixture</h1>
      <article
        className="rounded-2xl border border-cafe bg-cafe-surface p-4"
        data-testid="live-message-identity-probe"
        data-message-id={message?.id}
        data-message-streaming={message?.isStreaming ? 'true' : 'false'}
      >
        <p>{message?.content}</p>
        <p data-rich-block-title>{widget?.title}</p>
      </article>
      {message ? (
        <MessageActions message={message} threadId={THREAD_ID}>
          <section data-testid="live-cli-forward-source">
            <CliOutputBlock
              events={[{ id: 'live-stdout', kind: 'text', timestamp: message.timestamp, content: CLI_STDOUT }]}
              status={message.isStreaming ? 'streaming' : 'done'}
              defaultExpanded
            />
          </section>
        </MessageActions>
      ) : null}
      <button
        type="button"
        className="w-fit rounded-xl border border-cafe px-4 py-2 text-cafe-primary"
        onClick={finishAndSelect}
      >
        完成并立即选中
      </button>
      {selectedMessageIds.length > 0 && (
        <MessageSelectionToolbar
          threadId={THREAD_ID}
          selectedMessageIds={selectedMessageIds}
          onCancel={() => setSelectedMessageIds([])}
          onExportSuccess={() => setExported(true)}
          forwardingDisabled
        />
      )}
      <output data-export-status>{exported ? 'exported' : 'pending'}</output>
    </main>
  );
}
