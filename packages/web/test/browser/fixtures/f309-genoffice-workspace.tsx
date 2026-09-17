import { createRoot } from 'react-dom/client';
import '@/app/theme-tokens.css';
import '@/app/console-tokens.css';
import '@/app/console-controls.css';
import '@/app/connector-tokens.css';
import '@/app/globals.css';
import { OfficialPluginsPanel } from '@/components/settings/OfficialPluginsPanel';
import { F307FileOwnerSurface } from '@/components/workbench/F307FileOwnerSurface';
import { createFileSurface } from '@/components/workbench/real-surface-adapters';

const surface = createFileSurface({ worktreeId: 'genoffice-acceptance', path: 'sample.docx' });
createRoot(document.getElementById('root')!).render(
  <main>
    <section aria-label="插件设置">
      <OfficialPluginsPanel />
    </section>
    <section aria-label="Workspace 文档" style={{ height: 900 }}>
      <F307FileOwnerSurface surface={surface} onRequestDetach={() => undefined} />
    </section>
  </main>,
);
