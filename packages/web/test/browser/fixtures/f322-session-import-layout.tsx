import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import '../../../src/app/globals.css';
import { SessionImportPanel } from '../../../src/components/new-conversation/SessionImportPanel';
import type { NewConversationAdmission } from '../../../src/components/new-conversation/useNewConversationAdmission';

function Fixture() {
  const [title, updateTitle] = useState('');
  const [pinned, updatePinned] = useState(false);
  const admission = {
    ready: true,
    optionsLocked: false,
    intent: { title, pinned, preferredCats: [], creationStarted: false },
    updateTitle,
    updatePinned,
    importSession: async () => {},
  } as unknown as NewConversationAdmission;
  return (
    <main style={{ position: 'fixed', top: '64vh', left: 16, width: 'calc(100% - 32px)', maxWidth: 720 }}>
      <SessionImportPanel admission={admission} onNavigate={() => {}} />
    </main>
  );
}
const root = document.getElementById('root');
if (!root) throw new Error('Fixture root is required');
createRoot(root).render(<Fixture />);
