import { createRoot } from 'react-dom/client';
import '@/app/theme-tokens.css';
import '@/app/connector-tokens.css';
import '@/app/globals.css';
import { QueuePanel } from '@/components/QueuePanel';
import { useSocket } from '@/hooks/useSocket';
import type { QueueEntry } from '@/stores/chat-types';
import { useChatStore } from '@/stores/chatStore';

const seed = document.getElementById('queue-seed');
const root = document.getElementById('root');
if (!seed?.textContent || !root) throw new Error('Queue browser fixture is missing its seed');
const queue: QueueEntry[] = JSON.parse(seed.textContent);
const threadId = 'issue1371-queue-reconcile';
useChatStore.setState({
  currentThreadId: threadId,
  messages: [],
  activeInvocations: {},
  catInvocations: {},
  hasActiveInvocation: false,
  queue,
});

function QueueRecoveryProof() {
  useSocket({ onMessage: () => undefined }, threadId);
  return (
    <main className="min-h-screen bg-cafe-surface-canvas p-8 text-cafe" data-ready="true">
      <h1 className="text-xl font-semibold">队列恢复验证</h1>
      <p className="my-4 text-cafe-secondary">开发测试：三个已结束的消息回执，服务器已完成结算。</p>
      <QueuePanel threadId={threadId} />
    </main>
  );
}

createRoot(root).render(<QueueRecoveryProof />);
