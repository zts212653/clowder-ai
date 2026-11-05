import { createRoot } from 'react-dom/client';
import { ArtworkLightboxHost } from '@/components/content-review/ArtworkLightboxHost';
import { ArtworkLightboxProvider } from '@/components/content-review/ArtworkLightboxScope';
import { MediaGalleryBlock } from '@/components/rich/MediaGalleryBlock';
import { ThreadComposerHost } from '@/components/thread-chat/ThreadComposerHost';
import { useChatStore } from '@/stores/chatStore';
import '@/app/globals.css';
import '@/app/theme-tokens.css';
import '@/app/console-tokens.css';
import '@/app/shell-v2.css';

const threadId = 'thread-f309-ordinary-workspace';
const path = 'docs/plans/assets/memory-delivery-roadmap/construction-map.png';
const url = `/api/workspace/file/raw?${new URLSearchParams({ worktreeId: 'listed-root', path })}`;
useChatStore.setState({ currentThreadId: threadId });
localStorage.setItem('cat-cafe:shell-presentation', 'v2');
localStorage.setItem('cat-cafe:shell-language', new URLSearchParams(location.search).get('language') ?? 'zh');
createRoot(document.getElementById('root')!).render(
  <ArtworkLightboxProvider threadId={threadId}>
    <main style={{ width: 640, maxWidth: '95vw', margin: '20px auto' }}>
      <MediaGalleryBlock
        publication={{ threadId, messageId: 'original-map-message', messageRevision: '12' }}
        block={{ kind: 'media_gallery', v: 1, id: 'map', items: [{ url, alt: 'construction-map.png' }] }}
      />
      <ThreadComposerHost threadId={threadId}>
        <textarea aria-label="original composer" defaultValue="原草稿不能丢" />
      </ThreadComposerHost>
    </main>
    <ArtworkLightboxHost />
  </ArtworkLightboxProvider>,
);
