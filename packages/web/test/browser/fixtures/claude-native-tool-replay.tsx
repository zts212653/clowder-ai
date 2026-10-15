import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ReplayMessageList } from '@/components/story-player/ReplayMessageList';
import { adaptTranscriptEvents } from '@/lib/story-player/adapter';
import { buildReplayChatMessages, type ReplayChatMessage } from '@/lib/story-player/replay-chat-bridge';

function NativeReplay() {
  const [messages, setMessages] = useState<ReplayChatMessage[]>([]);
  useEffect(() => {
    fetch('/persisted-transcript.json')
      .then((r) => r.json())
      .then((raw) => setMessages(buildReplayChatMessages(adaptTranscriptEvents(raw))));
  }, []);
  return (
    <main>
      <h1>真实 Claude 工具结果的持久历史重放</h1>
      <ReplayMessageList messages={messages} autoScroll={false} />
    </main>
  );
}
createRoot(document.getElementById('root')!).render(<NativeReplay />);
