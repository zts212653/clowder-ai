import { createRoot } from 'react-dom/client';
import { ChatMessage } from '@/components/ChatMessage';
import { primeCoCreatorConfigCache } from '@/hooks/useCoCreatorConfig';
import type { ChatMessage as Message } from '@/stores/chat-types';
import { useChatStore } from '@/stores/chatStore';
import '@/app/globals.css';
import '@/app/theme-tokens.css';
import '@/app/connector-tokens.css';
import '@/app/console-tokens.css';

primeCoCreatorConfigCache({
  name: '验收用户',
  aliases: [],
  mentionPatterns: [],
  color: { primary: '#6B5443', secondary: '#E9DCCF' },
});
useChatStore.setState({ currentThreadId: 'briefing-proof', messages: [] });
const threadId = `thread_owned_${'a123456789'.repeat(10)}`;
const command = `cat_cafe_search_evidence({ query: "上下文交接", threadId: "${threadId}", scope: "threads", mode: "hybrid" })`;
const params = new URLSearchParams(location.search);
const card = {
  id: 'briefing-1',
  kind: 'card' as const,
  v: 1 as const,
  title: `砚砚 → 你 · 真相源: 未定位（threadId=${threadId}）`,
  ...(params.get('legacy') === '1'
    ? {}
    : {
        meta: {
          kind: 'context_briefing',
          receiverCatId: 'kimi',
          receiverDisplayName: '墨墨',
          coverageSummary: '近期消息 5 条 · 历史略过 42 条',
        },
      }),
  fields: [
    { label: '传球', value: '砚砚 → 你 (2026-11-03 07:20 America/Los_Angeles / 2026-11-03 15:20 UTC)' },
    { label: '真相源', value: `未定位（threadId=${threadId}）` },
    { label: '下一步', value: command },
    { label: '坐标', value: 'kimi/stream_json · unknown · serial' },
    { label: '上下文', value: 'cold · carrier_unsupported · epoch 2 · large' },
    { label: '呈现', value: 'T0 7 · T1 0 · T2 1 · invalid 0' },
  ],
  bodyMarkdown: `**参与者**: 砚砚、墨墨\n\n**最近产物**:\n- docs/${'long-reference-'.repeat(12)}plan.md\n\n**深入搜索**:\n- \`${command}\``,
};
const message: Message = {
  id: 'context-briefing-proof',
  type: 'system',
  content: card.title,
  timestamp: Date.now(),
  origin: 'briefing',
  extra: { systemKind: 'context_briefing', rich: { v: 1, blocks: [card] } },
};
const dark = params.get('theme') === 'dark';
document.documentElement.classList.toggle('dark', dark);
document.documentElement.dataset.theme = dark ? 'dark' : 'light';
document.body.style.margin = '0';
createRoot(document.getElementById('root')!).render(
  <main className="bg-cafe-bg text-cafe-primary min-h-screen p-3">
    <div className="mx-auto w-full max-w-[720px]">
      <p className="mb-3 text-sm">真实聊天消息容器 · 合成验收数据</p>
      <ChatMessage message={message} getCatById={() => undefined} />
    </div>
  </main>,
);
