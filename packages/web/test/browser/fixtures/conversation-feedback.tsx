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
useChatStore.setState({ currentThreadId: 'feedback-proof', messages: [] });
const params = new URLSearchParams(location.search);
const local = params.get('entry') === 'local';
const connector = params.get('entry') === 'connector';
const reportBody = params.has('markdown')
  ? '## 复现步骤\n1. 运行示例工具。\n\n**预期**：人工核对后发布。'
  : '有可复现的失败步骤。';
const dark = params.get('theme') === 'dark';
document.documentElement.classList.toggle('dark', dark);
document.documentElement.dataset.theme = dark ? 'dark' : 'light';
const message: Message = {
  id: 'original-message',
  type: local || connector ? 'connector' : 'assistant',
  catId: local || connector ? undefined : 'codex',
  content: local ? '检测到可信执行失败，已保留本地记录。' : '分析已确认症状和影响，可整理为 Issue 草稿。',
  timestamp: 1,
  ...(local
    ? { source: { connector: 'frustration-auto-issue', label: '问题检测', icon: 'search' } }
    : connector
      ? { source: { connector: 'community-publisher', label: '社区发布', icon: 'github' } }
      : {}),
  extra: {
    rich: {
      v: 1,
      blocks: [
        {
          id: 'issue-proposal',
          kind: 'card',
          v: 1,
          title: '工具执行失败',
          bodyMarkdown: reportBody,
          meta: local
            ? { kind: 'frustration_auto_issue', issueId: 'fi-proof', signalType: 'cli_error' }
            : connector
              ? { kind: 'community_issue_preview', draftId: 'retained-draft' }
              : {
                  kind: 'community_issue_draft',
                  proposedTitle: '工具执行失败',
                  proposedBody: reportBody,
                  proposedRepo: 'fixture/repo',
                  proposedLabels: ['bug'],
                },
        },
      ],
    },
  },
};
createRoot(document.getElementById('root')!).render(
  <main className="min-h-screen bg-cafe-bg p-3 text-cafe-text">
    <div className="mx-auto max-w-[720px]">
      <ChatMessage message={message} getCatById={() => undefined} />
    </div>
  </main>,
);
