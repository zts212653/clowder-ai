import { createRoot } from 'react-dom/client';
import { ArtworkLightboxHost } from '@/components/content-review/ArtworkLightboxHost';
import { ArtworkLightboxProvider } from '@/components/content-review/ArtworkLightboxScope';
import { writeShellLanguage } from '@/components/shell/shell-language';
import { writeShellPresentation } from '@/components/shell/shell-presentation';
import { HomeWorksSummary } from '@/components/workspace-home/HomeWorksSummary';
import { useChatStore } from '@/stores/chatStore';
import '@/app/theme-tokens.css';
import '@/app/console-tokens.css';
import '@/app/console-controls.css';
import '@/app/globals.css';

writeShellPresentation('v2');
writeShellLanguage('zh');
useChatStore.setState({ currentThreadId: 'focus-fixture', messages: [], threadStates: {} });
const root = document.getElementById('root');
if (!root) throw new Error('Fixture root is missing');
createRoot(root).render(
  <ArtworkLightboxProvider threadId="focus-fixture">
    <main data-testid="f307-workspace-home-page" style={{ padding: 24, maxWidth: 800 }}>
      <h1>共同查看器焦点回归 · 隔离夹具</h1>
      <HomeWorksSummary
        threadId="focus-fixture"
        worktreeId={null}
        onSelectDestination={() => undefined}
        onOpenArtifact={() => undefined}
      />
      <label>
        另一面板的输入框
        <textarea data-testid="original-composer" defaultValue="未发送的原草稿" />
      </label>
      <button type="button" data-testid="other-owner">
        另一控件
      </button>
    </main>
    <ArtworkLightboxHost />
  </ArtworkLightboxProvider>,
);
