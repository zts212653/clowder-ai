import { createRoot } from 'react-dom/client';
import { ArtworkLightboxHost } from '@/components/content-review/ArtworkLightboxHost';
import { ArtworkLightboxProvider } from '@/components/content-review/ArtworkLightboxScope';
import { FileBlock } from '@/components/rich/FileBlock';
import { MediaGalleryBlock } from '@/components/rich/MediaGalleryBlock';
import { ThreadComposerHost } from '@/components/thread-chat/ThreadComposerHost';
import { useChatStore } from '@/stores/chatStore';
import '@/app/globals.css';
import '@/app/theme-tokens.css';
import '@/app/console-tokens.css';
import '@/app/shell-v2.css';

const params = new URLSearchParams(location.search);
const video = params.get('video') === '1';
const name = video ? 'cat-planet-trailer-v1.2-1080p.mp4' : 'j6-1-find.jpg';
const url = `/api/workspace/file/raw?${new URLSearchParams({ worktreeId: 'listed-root', path: name })}`;
const publication = {
  threadId: 'thread-f309-ordinary-workspace',
  messageId: 'original-message',
  messageRevision: '12',
};
useChatStore.setState({ currentThreadId: publication.threadId });
localStorage.setItem('cat-cafe:shell-presentation', 'v2');
createRoot(document.getElementById('root')!).render(
  <ArtworkLightboxProvider threadId={publication.threadId}>
    <main style={{ width: 640, maxWidth: '95vw', margin: '20px auto' }}>
      {video ? (
        <FileBlock
          publication={publication}
          block={{ kind: 'file', v: 1, id: 'video', url, fileName: name, mimeType: 'video/mp4' }}
        />
      ) : (
        <MediaGalleryBlock
          publication={publication}
          block={{ kind: 'media_gallery', v: 1, id: 'gallery', items: [{ url, alt: name }] }}
        />
      )}
      <ThreadComposerHost threadId={publication.threadId}>
        <textarea aria-label="original composer" defaultValue="尚未发送的原草稿" />
      </ThreadComposerHost>
    </main>
    <ArtworkLightboxHost />
  </ArtworkLightboxProvider>,
);
