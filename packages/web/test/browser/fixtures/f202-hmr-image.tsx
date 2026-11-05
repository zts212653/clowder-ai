import { createRoot } from 'react-dom/client';
import { ConnectorBubble } from '@/components/ConnectorBubble';
import { ContentBlocks } from '@/components/ContentBlocks';
import type { ChatMessage } from '@/stores/chatStore';

const good = document.body.dataset.good;
const missing = document.body.dataset.missing;
if (!good || !missing) throw new Error('Missing HMR fixture references');

const connectorMessage = {
  id: 'f202-e3-plugin-message',
  content: 'Plugin image',
  contentBlocks: [{ type: 'image', url: `hmr:${good}` }],
  timestamp: Date.now(),
  source: { connector: 'f202-test', label: 'Plugin', icon: '📎' },
} as ChatMessage;

const root = document.getElementById('root');
if (!root) throw new Error('Missing browser fixture root');
createRoot(root).render(
  <main>
    <h1>Private plugin image</h1>
    <ConnectorBubble message={connectorMessage} />
    <ContentBlocks blocks={[{ type: 'image', url: `hmr:${missing}` }]} />
  </main>,
);
