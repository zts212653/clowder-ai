import { createRoot } from 'react-dom/client';
import { CommunityPanel } from '../../../src/components/CommunityPanel';
import '../../../src/app/globals.css';
import '../../../src/app/theme-tokens.css';

const container = document.getElementById('root');
if (!container) throw new Error('Missing browser fixture root');
createRoot(container).render(
  <main style={{ height: '100vh', maxWidth: 800, margin: 'auto' }}>
    <CommunityPanel />
  </main>,
);
