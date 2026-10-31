import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import '@/app/theme-tokens.css';
import '@/app/console-tokens.css';
import '@/app/console-controls.css';
import '@/app/globals.css';
import workspaceStyles from '@/components/content-review/review-workspace.module.css';
import { PublicationContentReviewSurface } from '@/components/workbench/content-review/PublicationContentReviewSurface';
import { WorkspaceSurfaceVisibilityProvider } from '@/components/workbench/WorkspaceSurfaceVisibility';

// Only the host controls visibility/navigation. All owner reads, media decoding, review layout and readiness are shipped code.
function Host() {
  const query = new URLSearchParams(location.search);
  const [visible, setVisible] = useState(true);
  const [mounted, setMounted] = useState(true);
  const [contentRef, setContentRef] = useState(query.get('contentRef') ?? '');
  return (
    <main style={{ height: '100vh', display: 'flex', flexDirection: 'column' }}>
      <nav>
        <button type="button" onClick={() => setVisible((value) => !value)}>
          Toggle F307 visibility
        </button>
        <button type="button" onClick={() => setMounted((value) => !value)}>
          Toggle mount
        </button>
        <button type="button" onClick={() => setContentRef(query.get('otherRef') ?? '')}>
          Same bytes, other publication
        </button>
        <button
          type="button"
          onClick={() => {
            const workspace = document.querySelector<HTMLElement>(`.${workspaceStyles.workspace}`);
            if (workspace) workspace.dataset.comparing = workspace.dataset.comparing === 'true' ? 'false' : 'true';
          }}
        >
          Toggle production comparison CSS
        </button>
      </nav>
      <div style={{ display: visible ? 'flex' : 'none', flex: 1, minHeight: 0 }}>
        <WorkspaceSurfaceVisibilityProvider visible={visible}>
          {mounted ? (
            <PublicationContentReviewSurface
              contentRef={contentRef}
              ownerRevision={2}
              title="Native publication display"
              onBack={() => setMounted(false)}
            />
          ) : null}
        </WorkspaceSurfaceVisibilityProvider>
      </div>
    </main>
  );
}
const root = document.getElementById('root');
if (!root) throw new Error('fixture root required');
createRoot(root).render(<Host />);
