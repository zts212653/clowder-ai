'use client';

import { useEffect, useState } from 'react';
import { ChatContainer } from '@/components/ChatContainer';
import { type ChatMessage, DEFAULT_THREAD_STATE, type Thread, useChatStore } from '@/stores/chatStore';

const THREAD_A = 'rich-html-continuity-a';
const THREAD_B = 'rich-html-continuity-b';
const WIDGET_MESSAGE_ID = 'rich-html-widget-message';
const WIDGET_BLOCK_ID = 'shared-rich-html';
// User-message fixture content, not an application-owned pictograph affordance.
const CLI_SIGNATURE = `[小团团·砚砚/gpt-5.6-terra${String.fromCodePoint(0x1f43e)}]`;

function widgetHtml(version: string, accent: string): string {
  const sections = Array.from(
    { length: 12 },
    (_, index) =>
      `<section style="min-height:92px;padding:18px 24px;border-bottom:1px solid #d9d3c5"><strong>${version} · section ${index + 1}</strong><p>Readable HTML context ${index + 1} stays inside the sandbox.</p></section>`,
  ).join('');
  return `<!doctype html><html><head><style>body{margin:0;background:#fffdf8;color:#352f45;font:16px/1.5 system-ui}main{border-top:8px solid ${accent}}[data-native-selection]{display:inline-block;margin:20px 24px;padding:8px;background:#fff3c4}[data-inner-disclosure]{margin:20px 24px;border-top:1px solid #d9d3c5;padding:18px 0}[data-inner-disclosure] summary{cursor:pointer;font-weight:700;color:#8f4f3c}[data-inner-disclosure] div{min-height:560px;padding:18px;background:#f8f2e9}</style></head><body><main>${sections}<span data-native-selection>Sandbox native selection remains copyable.</span><details data-inner-disclosure><summary>为什么不是一张 Demo 卡？</summary><div>Expanded evidence stays attached to the summary that the reader clicked.</div></details></main></body></html>`;
}

function makeWidgetMessage(threadId: string, version: string, accent: string): ChatMessage {
  return {
    id: WIDGET_MESSAGE_ID,
    type: 'assistant',
    catId: 'codex-sol',
    content: `Rich HTML fixture for ${threadId}`,
    timestamp: 1_787_843_540_000,
    projectionSourceMessageIds: [WIDGET_MESSAGE_ID],
    metadata: { model: 'gpt-5.6-sol', provider: 'openai' },
    extra: {
      isExplicitPost: true,
      stream: { invocationId: `${threadId}-parent`, turnInvocationId: `${threadId}-turn` },
      rich: {
        v: 1,
        blocks: [
          {
            id: WIDGET_BLOCK_ID,
            kind: 'html_widget',
            v: 1,
            title: `Continuity widget ${version}`,
            html: widgetHtml(version, accent),
            height: 360,
          },
        ],
      },
    },
  };
}

function makeFiller(index: number): ChatMessage {
  return {
    id: `continuity-filler-${index}`,
    type: 'assistant',
    catId: 'codex-sol',
    content: `上下文 ${index}：这是展开前仍在阅读的真实 Chat 消息。`.repeat(3),
    timestamp: 1_787_843_530_000 + index,
    metadata: { model: 'gpt-5.6-sol', provider: 'openai' },
    extra: {
      isExplicitPost: true,
      stream: { invocationId: `filler-parent-${index}`, turnInvocationId: `filler-turn-${index}` },
    },
  };
}

function makeCliMessage(): ChatMessage {
  return {
    id: 'continuity-cli-final-message',
    type: 'assistant',
    catId: 'codex-sol',
    content: [
      '回归命令未进入测试：独立 worktree 缺少 React 解析依赖，属于环境摩擦；我先登记，再修复验证环境而不把它误判为代码失败。',
      '',
      '测试尚未执行：独立 review worktree 缺失可解析的 React 依赖。已启动隔离依赖安装，完成后自动重跑同一 exact-HEAD 回归。',
      '',
      '[爪感差: managed review test+detached worktree 无法解析 react/react-jsx-dev-runtime]',
      '',
      CLI_SIGNATURE,
    ].join('\n'),
    timestamp: 1_787_843_550_000,
    origin: 'stream',
    metadata: { model: 'gpt-5.6-terra', provider: 'openai' },
    extra: { stream: { invocationId: 'continuity-cli-parent', turnInvocationId: 'continuity-cli-turn' } },
  };
}

function makeExcludedSelectionMessage(): ChatMessage {
  return {
    id: 'continuity-excluded-selection-message',
    type: 'assistant',
    catId: 'codex-sol',
    content: ['可引用的正文。', '', '```mermaid', 'this is not valid mermaid syntax', '```'].join('\n'),
    timestamp: 1_787_843_545_000,
    metadata: { model: 'gpt-5.6-sol', provider: 'openai' },
    extra: {
      isExplicitPost: true,
      stream: { invocationId: 'continuity-excluded-parent', turnInvocationId: 'continuity-excluded-turn' },
    },
  };
}

const THREAD_A_MESSAGES = [
  ...Array.from({ length: 5 }, (_, index) => makeFiller(index)),
  makeExcludedSelectionMessage(),
  makeCliMessage(),
  makeFiller(99),
  makeWidgetMessage(THREAD_A, 'A-v1', '#6b8f34'),
];
const THREAD_B_MESSAGES = [makeFiller(20), makeWidgetMessage(THREAD_B, 'B-v1', '#725aa8')];

function makeThread(id: string, title: string): Thread {
  return {
    id,
    projectPath: '/fixture/rich-html-continuity',
    title,
    createdBy: 'fixture',
    participants: ['codex-sol'],
    lastActiveAt: 1_787_843_560_000,
    createdAt: 1_787_843_520_000,
    bubbleCli: 'expanded',
  };
}

function seedFixture(): void {
  const stateA = { ...DEFAULT_THREAD_STATE, messages: THREAD_A_MESSAGES, hasMore: false };
  const stateB = { ...DEFAULT_THREAD_STATE, messages: THREAD_B_MESSAGES, hasMore: false };
  useChatStore.setState({
    ...stateA,
    currentThreadId: THREAD_A,
    threads: [makeThread(THREAD_A, 'Continuity A'), makeThread(THREAD_B, 'Continuity B')],
    threadStates: { [THREAD_A]: stateA, [THREAD_B]: stateB },
  });
}

export default function RichHtmlInteractionContinuityFixture() {
  const [activeThread, setActiveThread] = useState(THREAD_A);
  const [hydrated, setHydrated] = useState(false);
  const [widgetVersion, setWidgetVersion] = useState('A-v1');

  useEffect(() => {
    seedFixture();
    setHydrated(true);
  }, []);

  const switchThread = (threadId: string) => {
    useChatStore.getState().setCurrentThread(threadId);
    setActiveThread(threadId);
  };

  const replaceWidgetContent = () => {
    const nextVersion = 'A-v2';
    const state = useChatStore.getState();
    const current = state.getThreadState(THREAD_A).messages;
    const next = current.map((message) =>
      message.id === WIDGET_MESSAGE_ID ? makeWidgetMessage(THREAD_A, nextVersion, '#b16f2f') : message,
    );
    state.replaceThreadMessages(THREAD_A, next, false);
    setWidgetVersion(nextVersion);
  };

  return (
    <main
      data-testid="rich-html-interaction-continuity-fixture"
      data-hydrated={hydrated ? 'true' : 'false'}
      data-active-thread={activeThread}
      data-widget-version={widgetVersion}
    >
      <nav className="fixed right-3 top-3 z-[100] flex gap-2 rounded-lg bg-cafe-surface p-2 shadow-lg">
        <button type="button" data-testid="switch-thread-a" onClick={() => switchThread(THREAD_A)}>
          Thread A
        </button>
        <button type="button" data-testid="switch-thread-b" onClick={() => switchThread(THREAD_B)}>
          Thread B
        </button>
        <button type="button" data-testid="replace-widget-content" onClick={replaceWidgetContent}>
          Replace A content
        </button>
      </nav>
      {hydrated ? <ChatContainer threadId={activeThread} /> : null}
    </main>
  );
}
